import type { Expression } from './ast.ts';
import { Rational as R } from '@midi-madness/foundation/time';
export function decimalText(value: number): string {
  if (!Number.isFinite(value))
    throw new RangeError('Numeric expression must produce a finite real value');
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [mantissa, exponent] = text.split(/[eE]/);
  const sign = mantissa.startsWith('-') ? '-' : '';
  const raw = mantissa.replace('-', '');
  const digits = raw.replace('.', '');
  const at = (raw.indexOf('.') < 0 ? raw.length : raw.indexOf('.')) + Number(exponent);
  return (
    sign +
    (at <= 0
      ? '0.' + '0'.repeat(-at) + digits
      : at >= digits.length
        ? digits + '0'.repeat(at - digits.length)
        : digits.slice(0, at) + '.' + digits.slice(at))
  );
}
export function scalarRational(value: number): R {
  return R.parse(decimalText(value));
}
export function constant(e: Expression, meter?: readonly [number, number]): R {
  if (e.kind === 'number') {
    if (e.text.endsWith('%')) return R.parse(e.text.slice(0, -1)).div(new R(100));
    const duration = e.text.match(/^([\d]+\/[\d]+)(\.|t)$/);
    return duration
      ? R.parse(duration[1]).mul(duration[2] === '.' ? new R(3, 2) : new R(2, 3))
      : R.parse(e.text);
  }
  if (e.kind === 'group' && e.value.elements.length === 1)
    return constant(e.value.elements[0], meter);
  if (e.kind === 'span' && meter) {
    const unit = e.unit.startsWith('bar')
      ? new R(...meter)
      : e.unit.startsWith('beat')
        ? new R(1, 4)
        : undefined;
    if (!unit) throw new RangeError('Per spans support bars, beats or whole-note fractions');
    return constant(e.value).mul(unit);
  }
  if (e.kind === 'binary') {
    const a = constant(e.left, meter),
      b = constant(e.right, meter);
    if (e.operator === '+') return a.add(b);
    if (e.operator === '-') return a.sub(b);
    if (e.operator === '*') return a.mul(b);
    if (e.operator === '/') return a.div(b);
    if (e.operator === '^')
      return scalarRational(
        (Number(a.numerator) / Number(a.denominator)) **
          (Number(b.numerator) / Number(b.denominator)),
      );
  }
  if (e.kind === 'call' && e.name === 'pow' && e.args.length === 2) {
    const values = e.args.map((a) => {
      if (a.kind !== 'sequence' || a.elements.length !== 1)
        throw new RangeError('pow requires two scalar arguments');
      const v = constant(a.elements[0], meter);
      return Number(v.numerator) / Number(v.denominator);
    });
    return scalarRational(values[0] ** values[1]);
  }
  throw new RangeError('Expected constant scalar arithmetic');
}
// Lane expressions and rationals are immutable during realization. Keep decoded
// constants per AST and meter so sampling long data lanes stays O(1).
const perCache = new WeakMap<Expression, Map<string, { step: R; smooth: boolean; values: R[] }>>();
export function perData(
  e: Extract<Expression, { kind: 'call' }>,
  meter: readonly [number, number],
) {
  const key = `${meter[0]}/${meter[1]}`;
  const cached = perCache.get(e)?.get(key);
  if (cached) return cached;
  const one = (i: number) => {
    const arg = e.args[i];
    if (arg?.kind !== 'sequence' || arg.elements.length !== 1)
      throw new RangeError('Per needs one expression per value');
    return arg.elements[0];
  };
  const step = constant(one(0), meter),
    smooth = !constant(one(1)).equals(new R(0));
  if (step.compare(new R(0)) <= 0 || e.args.length < 3)
    throw new RangeError('Per needs a positive span and at least one value');
  const values = e.args.slice(2).map((_, i) => constant(one(i + 2)));
  const result = { step, smooth, values };
  let entries = perCache.get(e);
  if (!entries) perCache.set(e, (entries = new Map()));
  entries.set(key, result);
  return result;
}
export function perValue(
  e: Extract<Expression, { kind: 'call' }>,
  time: R,
  meter: readonly [number, number],
) {
  const { step, smooth, values } = perData(e, meter);
  const position = time.mod(step.mul(new R(values.length))).div(step),
    index = Number(position.floor());
  return smooth
    ? values[index].add(
        values[(index + 1) % values.length].sub(values[index]).mul(position.sub(new R(index))),
      )
    : values[index];
}
