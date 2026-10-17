import {
  RESET,
  resolveContributions,
  validateWriters,
  type ParameterDescriptor,
} from '@midi-madness/foundation/parameters';
import type { EngineFrame } from './engine.js';

export interface ParameterBinding<D = any> {
  effect: string;
  parameter: string;
  source: (frame: EngineFrame<D>) => number | null;
  map?: (value: number | null, frame: EngineFrame<D>) => number;
  combine?: 'replace' | 'sum';
}
export type EffectParameters = Record<string, Record<string, number>>;

/** The same control stream can drive multiple destinations with independent mappings. */
export function bindParameters<D>(
  frame: EngineFrame<D>,
  bindings: ParameterBinding<D>[],
  destinations?: readonly ParameterDescriptor[],
): EffectParameters {
  const evaluated = bindings.map((binding) => {
    const source = binding.source(frame);
    const value = binding.map ? binding.map(source, frame) : source;
    return {
      binding,
      destination: JSON.stringify([binding.effect, binding.parameter]),
      value: value === null ? RESET : value,
      ...(binding.combine === undefined ? {} : { combine: binding.combine }),
    };
  });
  if (destinations) {
    for (const { destination } of evaluated)
      if (!destinations.some((d) => d.id === destination))
        throw new Error('Missing parameter destination');
    validateWriters(
      evaluated
        .filter((item) => typeof item.value === 'number')
        .map((item) => ({
          destination: item.destination,
          enabled: true,
          // Hosts validate authored ranges before playback; here bound the actual
          // contributions. Reset contributes nothing and delegates to authored base.
          range: { min: item.value as number, max: item.value as number },
          ...(item.combine === undefined ? {} : { combine: item.combine }),
        })),
      destinations,
    );
  }
  const values = resolveContributions(evaluated);
  const parameters = new Map<string, Map<string, number>>();
  for (const { binding, destination } of evaluated) {
    const value = values.get(destination);
    if (value === undefined) continue;
    const effect = parameters.get(binding.effect) ?? new Map<string, number>();
    effect.set(binding.parameter, value);
    parameters.set(binding.effect, effect);
  }
  // fromEntries preserves ordinary object results without invoking prototype
  // setters when an authored effect or parameter uses a special property name.
  return Object.fromEntries(
    [...parameters].map(([id, values]) => [id, Object.fromEntries(values)]),
  );
}
export const control =
  (name: string, fallback: number | null = null) =>
  (frame: EngineFrame): number | null =>
    name in frame.signals ? frame.signals[name] : fallback;

/** Select a track (or any caller-defined group) without teaching the effect about it. */
export const activity =
  <T = any>(
    collection: string,
    select: (datum: T) => boolean,
    strength: (datum: T) => number = () => 1,
  ) =>
  (frame: EngineFrame): number =>
    (frame.active[collection] ?? []).reduce(
      (sum, record) =>
        select(record.datum) ? sum + strength(record.datum) * (1 - record.progress) : sum,
      0,
    );
