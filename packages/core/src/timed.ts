import type { Argument, Clause } from './ast.ts';
import type { Span } from './diag.ts';
import { Rational } from '@midi-madness/foundation/time';
export type TimedType = 'notes' | 'hits' | 'values' | 'harmony';
export type GateSpec = { kind: 'span'; span: Rational } | { kind: 'percent'; amount: Rational };
export type Hold = {
  onset: Rational;
  span: Rational;
  source: Span;
  conditions: Clause[];
  locks: Record<string, number>;
  fields: Clause[];
  gateSpec?: GateSpec;
  velocity?: number;
};
export type LiteralEvent = {
  generator?: import('./note-generators.ts').NoteGenerator;
  grain?: boolean;
  paths?: import('./note-paths.ts').NotePath[];
  group?: string;
  pitchNumbers?: number[];
  pitchResolution?: { spelling: string; key: string; chord?: string; pitch: number }[];
  onset: Rational;
  writtenSpan: Rational;
  gate: Rational;
  pitches: string[];
  offset: number;
  value?: number;
  velocity: number;
  locks: Record<string, number>;
  conditions: Clause[];
  fields: Clause[];
  holds: Hold[];
  attackSpan: Rational;
  gateOverride?: boolean;
  gateSpec?: GateSpec;
  operations: { name: string; args: Argument[]; span: Span }[];
  source: {
    span: Span;
    literal: Span;
    slot: number[];
    ratchet: number;
    operationOrdinal?: number;
    literalText?: string;
    cycle?: number;
    figureExtent?: Rational;
    originalAttackSpan?: Rational;
    originalFigureOnset?: Rational;
    callSites?: Span[];
  };
};
export type Shape = {
  name: string;
  low: number;
  high: number;
  period: Rational;
  onset: Rational;
  every?: Rational;
  span: Span;
  reverse?: boolean;
};
export type Unit = { name: string; kind: string; onset: Rational; extent: Rational; source: Span };
export type TimedValue = {
  units: Unit[];
  type: TimedType;
  extent: Rational;
  events: LiteralEvent[];
  shapes: Shape[];
  chords: { onset: Rational; span: Rational; symbol: string; source: Span }[];
  expression?: import('./ast.ts').Expression;
  leadingHolds: Hold[];
  smooth: boolean;
};
export function emptyTimed(type: TimedType, extent = new Rational(0)): TimedValue {
  return {
    units: [],
    type,
    extent,
    events: [],
    shapes: [],
    chords: [],
    leadingHolds: [],
    smooth: false,
  };
}
/** Percent gates use exact decimal arithmetic even though velocity/signal values are floats. */
export function eventGate(event: Pick<LiteralEvent, 'writtenSpan' | 'gateSpec'>): Rational {
  if (!event.gateSpec) return event.writtenSpan;
  if (event.gateSpec.kind === 'span') return event.gateSpec.span;
  return event.writtenSpan.mul(event.gateSpec.amount).div(new Rational(100));
}

/** Sequence already-expanded values without mutating the inputs; leading holds cross boundaries. */
export function sequenceTimed(values: TimedValue[], type: TimedType): TimedValue {
  const result = emptyTimed(type);
  let previous: LiteralEvent | undefined;
  for (const value of values) {
    if (value.type !== type) throw new RangeError('A timed sequence must contain one type');
    for (const hold of value.leadingHolds) {
      if (previous) {
        previous.writtenSpan = result.extent.add(hold.onset).add(hold.span).sub(previous.onset);
        previous.gate = eventGate(previous);
        previous.holds.push({ ...hold, onset: result.extent.add(hold.onset) });
      } else result.leadingHolds.push({ ...hold, onset: result.extent.add(hold.onset) });
    }
    for (const event of value.events) {
      const copy = {
        ...event,
        onset: result.extent.add(event.onset),
        pitches: [...event.pitches],
        locks: { ...event.locks },
        conditions: [...event.conditions],
        fields: [...event.fields],
        holds: event.holds.map((hold) => ({ ...hold, onset: result.extent.add(hold.onset) })),
      };
      result.events.push(copy);
      previous = copy;
    }
    result.units.push(
      ...value.units.map((unit) => ({ ...unit, onset: unit.onset.add(result.extent) })),
    );
    result.chords.push(
      ...value.chords.map((chord) => ({ ...chord, onset: chord.onset.add(result.extent) })),
    );
    result.shapes.push(
      ...value.shapes.map((shape) => ({ ...shape, onset: shape.onset.add(result.extent) })),
    );
    result.extent = result.extent.add(value.extent);
    result.smooth ||= value.smooth;
  }
  return result;
}
