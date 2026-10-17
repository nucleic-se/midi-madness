import type { Expression } from './ast.ts';
import { constant, perData } from './constants.ts';
import type { Rational } from '@midi-madness/foundation/time';

type Sample = (sample: number) => number | undefined;
type Pair = { low: number; delta: number; denominator: number };
const decoded = new WeakMap<object, { values: number[]; pairs: (Pair | undefined)[] }>();
const safe = (...values: number[]) => values.every(Number.isSafeInteger);
function gcd(a: number, b: number): number {
  a = Math.abs(a);
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Compile dense constant-valued lanes to sample-index arithmetic. Every operation on
 * integer coordinates is guarded; undefined requests the original exact evaluator.
 * Reduction before division preserves the exact evaluator's numeric result, rather
 * than changing interpolation to floating-point lerp (which can differ by an ulp).
 */
export function numericSignal(
  e: Expression,
  tick: Rational,
  reset: Rational,
  meter: readonly [number, number],
): Sample | undefined {
  if (e.kind === 'number') {
    const value = constant(e);
    const n = Number(value.numerator) / Number(value.denominator);
    return () => n;
  }
  if (e.kind === 'label') return numericSignal(e.value, tick, reset, meter);
  if (e.kind === 'group' && e.value.elements.length === 1)
    return numericSignal(e.value.elements[0], tick, reset, meter);
  if (e.kind === 'binary') {
    const left = numericSignal(e.left, tick, reset, meter),
      right = numericSignal(e.right, tick, reset, meter);
    if (!left || !right) return;
    return (sample) => {
      const a = left(sample),
        b = right(sample);
      if (a === undefined || b === undefined || (e.operator === '/' && b === 0)) return;
      const value =
        e.operator === '+'
          ? a + b
          : e.operator === '-'
            ? a - b
            : e.operator === '*'
              ? a * b
              : e.operator === '/'
                ? a / b
                : a ** b;
      return Number.isFinite(value) ? value : undefined;
    };
  }
  if (e.kind !== 'call' || e.name !== '__per') return;
  const lane = perData(e, meter);
  let data = decoded.get(lane);
  if (!data) {
    data = {
      values: lane.values.map((v) => Number(v.numerator) / Number(v.denominator)),
      pairs: lane.smooth
        ? lane.values.map((v, i) => {
            const next = lane.values[(i + 1) % lane.values.length];
            const denominator =
              (v.denominator / bigGcd(v.denominator, next.denominator)) * next.denominator;
            const low = v.numerator * (denominator / v.denominator);
            const high = next.numerator * (denominator / next.denominator);
            const pair = {
              low: Number(low),
              delta: Number(high - low),
              denominator: Number(denominator),
            };
            return safe(pair.low, pair.delta, pair.denominator) ? pair : undefined;
          })
        : [],
    };
    decoded.set(lane, data);
  }
  const scale = tick.div(lane.step),
    origin = (e.clock === 'song' ? reset.sub(reset) : reset).div(lane.step),
    denominator =
      (scale.denominator / bigGcd(scale.denominator, origin.denominator)) * origin.denominator;
  let a = scale.numerator * (denominator / scale.denominator),
    c = origin.numerator * (denominator / origin.denominator),
    d = denominator;
  const factor = bigGcd(bigGcd(a, c), d);
  a /= factor;
  c /= factor;
  d /= factor;
  const coefficient = Number(a),
    shift = Number(c),
    unit = Number(d),
    period = unit * data.values.length;
  if (!safe(coefficient, shift, unit, period)) return;
  const { values, pairs } = data;
  return (sample) => {
    const scaled = sample * coefficient,
      position = scaled - shift;
    if (!safe(scaled, position)) return;
    let phase = position % period;
    if (phase < 0) phase += period;
    let index = Math.floor(phase / unit);
    // Division can round up immediately below an integer for large denominators.
    if (index * unit > phase) index--;
    if (!lane.smooth) return values[index];
    const pair = pairs[index];
    if (!pair) return;
    const fraction = phase - index * unit,
      base = pair.low * unit,
      delta = pair.delta * fraction,
      numerator = base + delta,
      divisor = pair.denominator * unit;
    if (!safe(base, delta, numerator, divisor)) return;
    const reduction = gcd(numerator, divisor);
    return numerator / reduction / (divisor / reduction);
  };
}

function bigGcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
}
