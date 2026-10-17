import { ControlLane } from '@midi-madness/foundation/curves';
import {
  type PerformanceFrame,
  type Position3,
  type VoiceDefinition,
  type VoiceState,
} from '../performance.js';
import type { adaptPerformance, ScheduledAttack } from '../performance-adapter.js';

/** What positioned-performance instruments read. Effects never parse the export themselves. */
export type AdaptedPerformance = ReturnType<typeof adaptPerformance>;

/** One frame per time for several instruments; frames are pure, so caching is safe. */
export class FrameCache {
  private time = NaN;
  private value?: PerformanceFrame;
  constructor(private readonly performance: AdaptedPerformance) {}
  at(time: number): PerformanceFrame {
    if (time !== this.time || !this.value) {
      this.value = this.performance.engine.frame(time);
      this.time = time;
    }
    return this.value;
  }
}

/** A voice's state at an exact time, found by ID. Undefined outside its [start, end). */
export function voiceAt(
  performance: AdaptedPerformance,
  voice: VoiceDefinition,
  time: number,
): VoiceState | undefined {
  return performance.engine.frame(time).voices.find((v) => v.id === voice.id);
}

/** Where a hit sounds: track position lanes, overridden by the hit's own position locks. */
export function attackPosition(
  performance: AdaptedPerformance,
  attack: ScheduledAttack,
): Position3 {
  const controls = performance.definition.tracks?.[attack.track]?.controls ?? {};
  const locks = ('locks' in attack.source ? attack.source.locks : undefined) ?? {};
  const axis = (name: 'x' | 'y' | 'z') =>
    locks[`space.${name}`] ??
    (controls[name] ? new ControlLane(controls[name]).value(attack.start, 0) : 0);
  return [axis('x'), axis('y'), axis('z')];
}

/** The latest attack on a track at or before `time` (monophonic lanes retrigger on each hit). */
export function latestAttack(
  attacks: readonly ScheduledAttack[],
  time: number,
): ScheduledAttack | undefined {
  let lo = 0,
    hi = attacks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (attacks[mid].start <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo ? attacks[lo - 1] : undefined;
}

/** Where an instrument's brightness comes from, so demos can show it rather than hide it. */
export type EnvelopeSource = 'exported' | 'gate-approximation' | 'lane-model' | 'idle';
/** Combine per-voice sources: nothing sounding is idle, any approximated voice is reported. */
export function envelopeSourceOf(voices: readonly { exported: boolean }[]): EnvelopeSource {
  if (!voices.length) return 'idle';
  return voices.every((v) => v.exported) ? 'exported' : 'gate-approximation';
}

/** Position lanes of a track (x, y, z in metres) as seekable lanes; undefined axes are 0. */
export function trackPosition(performance: AdaptedPerformance, track: string) {
  const controls = performance.definition.tracks?.[track]?.controls ?? {};
  const lanes = (['x', 'y', 'z'] as const).map((axis) =>
    controls[axis] ? new ControlLane(controls[axis]) : undefined,
  );
  return (time: number): Position3 => [
    lanes[0]?.value(time, 0) ?? 0,
    lanes[1]?.value(time, 0) ?? 0,
    lanes[2]?.value(time, 0) ?? 0,
  ];
}
/** A sounding voice's brightness: its exported amplitude, else its gate (explicitly approximate). */
export function voiceLevel(voice: VoiceState): { level: number; exported: boolean } {
  if (voice.amplitude !== null) return { level: voice.amplitude * voice.velocity, exported: true };
  return { level: voice.held ? voice.velocity : 0, exported: false };
}
