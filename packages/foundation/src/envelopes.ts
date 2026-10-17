/** Shared trigger selection/combination. The caller supplies source-unit age and
 * shape evaluation, preserving exact authored coordinates until that boundary.
 */
export interface EnvelopePolicy {
  readonly duration: number;
  readonly idle: number;
  readonly combine?: 'latest' | 'sum';
  readonly ceiling?: number;
  readonly tie?: 'first' | 'last';
}
export interface TriggerAccess<T> {
  age(event: T): number;
  sample(age: number, event: T): number;
  accepts?(event: T): boolean;
  velocity?(event: T): number;
}
export function sampleEnvelope<T>(
  policy: EnvelopePolicy,
  events: readonly T[],
  access: TriggerAccess<T>,
): number {
  if (
    !Number.isFinite(policy.duration) ||
    policy.duration < 0 ||
    !Number.isFinite(policy.idle) ||
    (policy.ceiling !== undefined && !Number.isFinite(policy.ceiling))
  )
    throw new RangeError('Envelope needs finite values and nonnegative duration');
  let latestAge = Infinity,
    latestValue = policy.idle,
    sum = 0,
    found = false;
  for (const event of events) {
    const age = access.age(event);
    if (!Number.isFinite(age)) throw new RangeError('Trigger age must be finite');
    if (age < 0 || age >= policy.duration || (access.accepts && !access.accepts(event))) continue;
    const newer = age < latestAge || (policy.tie === 'last' && age === latestAge);
    if (policy.combine !== 'sum' && !newer) continue;
    const velocity = access.velocity?.(event) ?? 1;
    const value = access.sample(age, event) * velocity;
    if (!Number.isFinite(velocity) || !Number.isFinite(value))
      throw new RangeError('Envelope output must be finite');
    found = true;
    if (policy.combine === 'sum') sum += value;
    else {
      latestAge = age;
      latestValue = value;
    }
  }
  const result = !found ? policy.idle : policy.combine === 'sum' ? sum : latestValue;
  if (!Number.isFinite(result)) throw new RangeError('Envelope sum must be finite');
  return policy.ceiling === undefined ? result : Math.min(policy.ceiling, result);
}

import { sampleBeatCurve, type BeatPoint } from './curves.js';
/** Musical convenience for validated beat curves and caller-owned cue histories. */
export function sampleTriggeredEnvelope<T extends { readonly at: number }>(
  envelope: {
    readonly beats: number;
    readonly idle: number;
    readonly points: readonly BeatPoint[];
  },
  events: readonly T[],
  beat: number,
  accepts: (event: T) => boolean,
): number {
  if (!Number.isFinite(beat) || envelope.beats <= 0)
    throw new RangeError('Envelope sampling needs finite beats and positive duration.');
  return sampleEnvelope({ duration: envelope.beats, idle: envelope.idle }, events, {
    age: (event) => beat - event.at,
    accepts,
    sample: (age) => sampleBeatCurve(envelope.points, age),
  });
}
