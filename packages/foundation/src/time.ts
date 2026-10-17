import { Rational } from './rational.js';
export { Rational } from './rational.js';
export { createPlayback } from './playback.js';

/** Host-owned playback. All beats are quarter notes; clock injection uses milliseconds. */
export interface PlaybackTransport {
  position(): number;
  secondsAt(beat: number): number;
  setTempo(bpm: number): void;
  play(): void;
  stop(): void;
  readonly playing: boolean;
  readonly bpm: number;
}

export function wholeNotesToBeats(wholeNotes: Rational): Rational {
  return wholeNotes.mul(new Rational(4));
}

export function beatsToWholeNotes(beats: Rational): Rational {
  return beats.div(new Rational(4));
}

export function beatsPerBar(numerator: number, denominator: number): Rational {
  if (
    !Number.isSafeInteger(numerator) ||
    numerator <= 0 ||
    !Number.isSafeInteger(denominator) ||
    denominator <= 0
  )
    throw new RangeError('Meter components must be positive safe integers');
  return new Rational(numerator, denominator).mul(new Rational(4));
}

/** Prepare numeric project durations exactly as written in their decimal representation.
 * Arithmetic occurs during preparation, not on each rendered frame.
 */
export function beatTimeline(durations: readonly number[]) {
  let total = new Rational(0);
  const starts = durations.map((duration) => {
    if (!Number.isFinite(duration) || duration <= 0)
      throw new RangeError('Beat duration must be positive and finite');
    const start = total.toNumber();
    total = total.add(Rational.fromNumber(duration));
    return start;
  });
  return { starts, end: total.toNumber() };
}

/** Backend samples remain authoritative, including negative pre-excerpt positions. */
export interface MediaTimeOrigin {
  readonly sampleRate: number;
  readonly originSample: number;
  readonly scoreOffsetSample: number;
}

export function mediaClock(origin: MediaTimeOrigin, tempoBpm: number) {
  const { sampleRate, originSample, scoreOffsetSample } = origin;
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isSafeInteger(originSample) ||
    !Number.isSafeInteger(scoreOffsetSample) ||
    !Number.isFinite(tempoBpm) ||
    tempoBpm <= 0
  )
    throw new RangeError('Invalid media time origin or tempo');
  const finite = (value: number) => {
    if (!Number.isFinite(value)) throw new RangeError('Time must be finite');
    return value;
  };
  return {
    secondsAtSample(sample: number) {
      return finite((finite(sample) - originSample) / sampleRate);
    },
    /** Continuous coordinate; quantize once at a backend boundary if needed. */
    sampleAtSeconds(seconds: number) {
      return finite(finite(seconds) * sampleRate + originSample);
    },
    scoreBeatsAtSeconds(seconds: number) {
      return finite(
        ((finite(seconds) + (originSample - scoreOffsetSample) / sampleRate) * tempoBpm) / 60,
      );
    },
    secondsAtScoreBeat(beat: number) {
      return finite(
        (finite(beat) * 60) / tempoBpm - (originSample - scoreOffsetSample) / sampleRate,
      );
    },
  };
}
