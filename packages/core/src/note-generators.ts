import type { Event } from './ir.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import { generator } from './random.ts';
export type NoteGenerator = {
  kind: 'ratchet' | 'grains';
  count: number;
  decay?: number;
  pitch?: number;
  curve?: number;
  size?: number;
  scatter?: number;
  pitchJitter?: number;
  pan?: number;
};
const scalar = (n: number) => R.parse(n.toFixed(12));
/** Compact IR until a backend schedules attacks. Seeded independently of render order. */
export function generatedEvents(event: Event, secondsPerWhole: number, seed: string): Event[] {
  const g = event.generator;
  if (!g) return [event];
  const random = generator(['mm-note-generator-v1', seed, event.id]);
  const span = event.writtenSpan;
  const starts = Array.from({ length: g.count }, (_, i) => {
    const phase = (i / g.count) ** (g.curve ?? 1);
    const jitter = g.kind === 'grains' ? ((random() * 2 - 1) * (g.scatter ?? 0)) / g.count : 0;
    return Math.max(0, Math.min(1 - 1e-12, phase + jitter));
  }).sort((a, b) => a - b);
  const positions = starts.map(scalar);
  return starts.map((phase, i) => {
    const delta = span.mul(positions[i]);
    const gate =
      g.kind === 'grains'
        ? scalar((g.size ?? 0.03) / secondsPerWhole)
        : span.mul((positions[i + 1] ?? new R(1)).sub(positions[i])).mul(event.gate.div(span));
    const cents =
      g.kind === 'grains' ? (random() * 2 - 1) * (g.pitchJitter ?? 0) : i * (g.pitch ?? 0);
    if (
      event.pitch !== null &&
      (!Number.isFinite(event.pitch + cents / 100) ||
        event.pitch + cents / 100 < 0 ||
        event.pitch + cents / 100 > 127)
    )
      throw new RangeError(
        'Generated pitch leaves MIDI 0..127; reduce pitch step, jitter or count',
      );
    const pan = g.kind === 'grains' ? (random() * 2 - 1) * (g.pan ?? 0) : undefined;
    return {
      ...event,
      generator: undefined,
      id: `${event.id}/${g.kind}/${i}`,
      nominalOnset: event.nominalOnset.add(delta),
      performedOnset: event.performedOnset.add(delta),
      gate,
      writtenSpan: gate,
      pitch: event.pitch === null ? null : event.pitch + cents / 100,
      velocity: event.velocity * (1 - (g.decay ?? 0)) ** i,
      grain: g.kind === 'grains',
      panOffset: pan,
      locks: {
        ...event.locks,
        ...(event.pitch === null && cents ? { 'drum.generated.pitch': cents } : {}),
      },
    };
  });
}
