export interface NumericRange {
  readonly min: number;
  readonly max: number;
}
export interface ParameterBounds extends NumericRange {
  readonly id: string;
}
export interface ParameterDescriptor extends ParameterBounds {
  readonly label: string;
  readonly unit: string;
  readonly defaultValue: number;
}
export interface NumericSample {
  readonly value: number;
  readonly range: NumericRange;
}
export const RESET = Object.freeze({ kind: 'reset' as const });
export const UNAVAILABLE = Object.freeze({ kind: 'unavailable' as const });
export type NumericValue = number | typeof RESET | typeof UNAVAILABLE;
export interface Writer {
  readonly destination: string;
  readonly enabled: boolean;
  readonly range: NumericRange;
  readonly combine?: 'replace' | 'sum';
  /** Whether this writer can disappear independently via reset/unavailability. */
  readonly optional?: boolean;
}
export interface SourceSample {
  readonly value: NumericValue;
  readonly range: NumericRange;
  /** Numeric fallback is in native source units and is mapped normally. */
  readonly unavailable?: 'base' | 'error' | number;
}
export interface NumericConnection extends Writer {
  readonly sourceId: string;
}
export interface Contribution {
  readonly destination: string;
  readonly value: NumericValue;
  readonly combine?: 'replace' | 'sum';
  readonly unavailable?: 'base' | 'error' | number;
}
export function mapSample(sample: NumericSample, output: NumericRange): number {
  const { value, range } = sample,
    span = range.max - range.min;
  if (
    ![value, range.min, range.max, span, output.min, output.max].every(Number.isFinite) ||
    span <= 0 ||
    value < range.min ||
    value > range.max
  )
    throw new RangeError('Invalid numeric source sample or mapping range.');
  const fraction = (value - range.min) / span;
  const result = output.min * (1 - fraction) + output.max * fraction;
  if (!Number.isFinite(result)) throw new RangeError('Control mapping exceeded finite values.');
  return result;
}
export function validateDescriptor(descriptor: ParameterDescriptor): void {
  if (
    !descriptor.id ||
    !descriptor.label ||
    !descriptor.unit ||
    ![descriptor.min, descriptor.max, descriptor.defaultValue].every(Number.isFinite) ||
    descriptor.min > descriptor.max ||
    descriptor.defaultValue < descriptor.min ||
    descriptor.defaultValue > descriptor.max
  )
    throw new RangeError('Invalid parameter descriptor/default');
}
export function validateWriters(
  connections: readonly Writer[],
  destinations: readonly ParameterBounds[],
): void {
  const catalogue = new Map<string, ParameterBounds>();
  for (const target of destinations) {
    if (
      catalogue.has(target.id) ||
      ![target.min, target.max].every(Number.isFinite) ||
      target.min > target.max
    )
      throw new RangeError('Invalid or duplicate destination descriptor');
    catalogue.set(target.id, target);
  }
  const groups = new Map<string, Writer[]>();
  for (const connection of connections) {
    const target = catalogue.get(connection.destination);
    if (!target) throw new RangeError('Connection refers to a missing/unsupported destination.');
    const { min, max } = connection.range;
    if (
      ![min, max].every(Number.isFinite) ||
      Math.min(min, max) < target.min ||
      Math.max(min, max) > target.max
    )
      throw new RangeError('Connection range exceeds destination range.');
    if (
      connection.combine !== undefined &&
      connection.combine !== 'sum' &&
      connection.combine !== 'replace'
    )
      throw new RangeError('Unknown connection combination.');
    if (!connection.enabled) continue;
    const group = groups.get(target.id) ?? [];
    group.push(connection);
    groups.set(target.id, group);
  }
  for (const [id, writers] of groups) {
    if (writers.length > 1 && writers.some((c) => c.combine !== 'sum'))
      throw new RangeError(
        'Only one enabled connection may write a destination unless every writer explicitly selects Sum.',
      );
    if (writers[0]!.combine !== 'sum') continue;
    const required = writers.some((c) => !c.optional);
    let min = 0,
      max = 0;
    for (const writer of writers) {
      const lo = Math.min(writer.range.min, writer.range.max),
        hi = Math.max(writer.range.min, writer.range.max);
      min += writer.optional ? Math.min(0, lo) : lo;
      max += writer.optional ? Math.max(0, hi) : hi;
    }
    // With no writers present the authored base applies, not numeric zero.
    if (!required && min === 0)
      min = Math.min(...writers.map((c) => Math.min(c.range.min, c.range.max)));
    if (!required && max === 0)
      max = Math.max(...writers.map((c) => Math.max(c.range.min, c.range.max)));
    const target = catalogue.get(id)!;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < target.min || max > target.max)
      throw new RangeError(
        'Summed connection ranges exceed the destination range. Reduce their contributions.',
      );
  }
}

/** Resolve current-frame values only; missing writers never retain last frame state. */
export function resolveContributions(contributions: readonly Contribution[]): Map<string, number> {
  const values = new Map<string, number>();
  const modes = new Map<string, Contribution['combine']>();
  for (const contribution of contributions) {
    if (
      modes.has(contribution.destination) &&
      (modes.get(contribution.destination) !== 'sum' || contribution.combine !== 'sum')
    )
      throw new RangeError(
        'Only one enabled connection may write a destination unless every writer explicitly selects Sum.',
      );
    modes.set(contribution.destination, contribution.combine);
    let value = contribution.value;
    if (typeof value !== 'number') {
      if (value.kind === 'reset') continue;
      if (contribution.unavailable === 'base') continue;
      if (typeof contribution.unavailable === 'number') value = contribution.unavailable;
      else throw new RangeError('Required parameter source is unavailable');
    }
    const result =
      value + (contribution.combine === 'sum' ? (values.get(contribution.destination) ?? 0) : 0);
    if (!Number.isFinite(result)) throw new RangeError('Parameter output must be finite');
    values.set(contribution.destination, result);
  }
  return values;
}

export function routeParameters(
  sources: ReadonlyMap<string, SourceSample>,
  connections: readonly NumericConnection[],
): Map<string, number> {
  return resolveContributions(
    connections
      .filter((c) => c.enabled)
      .map((connection) => {
        const source = sources.get(connection.sourceId);
        if (!source) throw new RangeError('Connection refers to a missing source');
        const native =
          typeof source.value === 'number'
            ? source.value
            : source.value.kind === 'unavailable' && typeof source.unavailable === 'number'
              ? source.unavailable
              : source.value;
        return {
          destination: connection.destination,
          value:
            typeof native === 'number'
              ? mapSample({ value: native, range: source.range }, connection.range)
              : native,
          ...(source.unavailable === 'base' ? { unavailable: 'base' as const } : {}),
          ...(connection.combine === undefined ? {} : { combine: connection.combine }),
        };
      }),
  );
}

export function parameterValue(
  descriptor: ParameterDescriptor,
  values: ReadonlyMap<string, number>,
  base = descriptor.defaultValue,
): number {
  const value = values.get(descriptor.id) ?? base;
  if (!Number.isFinite(value) || value < descriptor.min || value > descriptor.max)
    throw new RangeError('Parameter value exceeds destination range');
  return value;
}
