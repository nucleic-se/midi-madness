import type { PlaybackTransport } from './time.js';

/** The only musical clock. Tempo changes integrate elapsed time at the old tempo first. */
export function createPlayback(now: () => number): PlaybackTransport {
  let beat = 0,
    seconds = 0,
    bpm = 120,
    playing = false,
    startedAt = 0,
    previous = now();
  const tempos = [{ beat: 0, seconds: 0, bpm }];
  function position() {
    const current = now();
    if (playing) {
      // Read elapsed time from one origin, not a sum of frame deltas. Summing
      // introduces cadence-dependent drift at exact authored scene boundaries.
      seconds = (Math.max(previous, current) - startedAt) / 1000;
      const tempo = tempos.at(-1)!;
      beat = tempo.beat + ((seconds - tempo.seconds) * bpm) / 60;
    }
    previous = Math.max(previous, current);
    return beat;
  }
  return {
    position,
    /** Performance seconds at an authored beat. Future beats use the latest tempo.
     * This is a read-only mapping, not a second clock or a seek operation.
     */
    secondsAt(at: number) {
      if (!Number.isFinite(at) || at < 0) throw new Error('Beat must be finite and nonnegative.');
      let low = 0,
        high = tempos.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (tempos[middle]!.beat <= at) low = middle;
        else high = middle - 1;
      }
      const tempo = tempos[low]!;
      return tempo.seconds + ((at - tempo.beat) * 60) / tempo.bpm;
    },
    setTempo(value: number) {
      if (!Number.isFinite(value) || value <= 0)
        throw new Error('BPM must be positive and finite.');
      position();
      if (value === bpm) return;
      bpm = value;
      const tempo = { beat, seconds, bpm };
      if (tempos.at(-1)!.beat === beat) tempos[tempos.length - 1] = tempo;
      else tempos.push(tempo);
    },
    play() {
      position();
      if (!playing) startedAt = previous;
      playing = true;
    },
    stop() {
      playing = false;
      beat = 0;
      seconds = 0;
      tempos.splice(0, tempos.length, { beat: 0, seconds: 0, bpm });
      previous = now();
    },
    get playing() {
      return playing;
    },
    get bpm() {
      return bpm;
    },
  };
}
