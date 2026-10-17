import type { Clause, Condition } from './ast.ts';
import { parse } from './parser.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import { euclid } from './literals.ts';
import type { LiteralEvent } from './timed.ts';
export type ConditionContext = {
  time: R;
  bar: R;
  reset?: R;
  sectionStart?: R;
  sectionExtent?: R;
  phraseStart?: R;
  phraseExtent?: R;
  n?: number;
  cycle?: number;
  names?: string[];
  event?: LiteralEvent;
  events?: LiteralEvent[];
  conditions?: Map<string, Condition>;
  signal?: (name: string, time: R) => number | undefined;
  resets?: Map<string, R>;
};
export function parseCondition(source: string): Condition {
  const result = parse(`mm 1\nwhen condition-name = ${source}\n`),
    s = result.ast.statements[0];
  if (result.diagnostics.length || s?.kind !== 'when')
    throw new RangeError(`Invalid condition ${source}`);
  return s.condition;
}
export function evaluateCondition(
  condition: Condition | string,
  context: ConditionContext,
  seen = new Set<string>(),
): boolean {
  const c = typeof condition === 'string' ? parseCondition(condition) : condition;
  if (c.kind === 'not') return !evaluateCondition(c.value, context, seen);
  if (c.kind === 'condition')
    return c.operator === 'and'
      ? evaluateCondition(c.left, context, seen) && evaluateCondition(c.right, context, seen)
      : evaluateCondition(c.left, context, seen) || evaluateCondition(c.right, context, seen);
  const text = c.tokens.join(' ').replace(/\s*\.\.\s*/g, '..');
  if (text.startsWith('(') && text.endsWith(')'))
    return evaluateCondition(parseCondition(text), context, seen);
  if (text === 'always') return true;
  if (text.startsWith('in '))
    return text
      .slice(3)
      .split(/\s*,\s*/)
      .some((n) => context.names?.includes(n));
  const periodic = text.match(
    /^(every|euclid|after) (\d+)(?:\.\.(\d+))?(?: of (\d+))?(?: (bars|beats|pulses|cycles))?(?: since ([\w-]+))?$/,
  );
  if (periodic) {
    const [, op, aText, bText, yText, unit, since] = periodic,
      a = Number(aText),
      b = Number(bText ?? aText),
      y = Number(yText ?? 1);
    const reset = since
      ? (context.resets?.get(since) ??
        (since === 'song'
          ? new R(0)
          : since === 'phrase'
            ? context.phraseStart
            : context.sectionStart))
      : context.reset;
    const duration =
      unit === 'bars'
        ? context.bar
        : unit === 'beats'
          ? new R(1, 4)
          : unit === 'pulses'
            ? new R(1, 4)
            : undefined;
    const n = duration
      ? Number(
          context.time
            .sub(reset ?? new R(0))
            .div(duration)
            .floor(),
        ) + 1
      : (context.n ?? context.cycle ?? 1);
    if (op === 'after') return n > a;
    if (y < 1 || a < (op === 'euclid' ? 0 : 1) || b > y || a > b)
      throw new RangeError('Condition bounds out of range');
    const index = (((n - 1) % y) + y) % y;
    return op === 'euclid' ? euclid(a, y)[index] : index + 1 >= a && index + 1 <= b;
  }
  const barPosition = text.match(/^bar (\d+)(?:\.\.(\d+))? of (section|phrase)$/),
    comparison = text.match(/^bar (<=|>=|<|>) (\d+) of (section|phrase)$/);
  if (barPosition || comparison) {
    const unit = (barPosition?.[3] ?? comparison![3]) as 'section' | 'phrase';
    const n =
      Number(
        context.time
          .sub(context[`${unit}Start`] ?? new R(0))
          .div(context.bar)
          .floor(),
      ) + 1;
    return barPosition
      ? n >= Number(barPosition[1]) && n <= Number(barPosition[2] ?? barPosition[1])
      : compare(n, comparison![1], Number(comparison![2]));
  }
  const edge = text.match(/^(first|last) bar of (section|phrase)$/);
  if (edge || text === 'fill bar') {
    const unit = (edge?.[2] ?? 'section') as 'section' | 'phrase',
      start = context[`${unit}Start`] ?? new R(0),
      extent = context[`${unit}Extent`] ?? context.bar;
    const n = context.time.sub(start).div(context.bar).floor(),
      bars = extent.div(context.bar),
      last = bars.floor() + (bars.mod(new R(1)).numerator ? 1n : 0n) - 1n;
    return edge?.[1] === 'first' ? n === 0n : n === last;
  }
  const note = text.match(/^(first|last|highest|lowest) note of (bar|phrase|section)$/);
  if (note) {
    if (!context.event || !context.events?.length) return false;
    const start =
      note[2] === 'bar'
        ? context.bar.mul(new R(context.time.div(context.bar).floor()))
        : note[2] === 'phrase'
          ? (context.phraseStart ?? new R(0))
          : (context.sectionStart ?? new R(0));
    const extent =
      note[2] === 'bar'
        ? context.bar
        : note[2] === 'phrase'
          ? context.phraseExtent
          : context.sectionExtent;
    const events = context.events.filter(
      (e) => e.onset.compare(start) >= 0 && (!extent || e.onset.compare(start.add(extent)) < 0),
    );
    if (note[1] === 'first') return context.event.onset.equals(events[0]?.onset ?? new R(-1));
    if (note[1] === 'last') return context.event.onset.equals(events.at(-1)?.onset ?? new R(-1));
    const pitches = events.flatMap((e) => e.pitchNumbers ?? []);
    if (!pitches.length) return false;
    const selected = note[1] === 'highest' ? Math.max(...pitches) : Math.min(...pitches);
    return context.event.pitchNumbers?.includes(selected) ?? false;
  }
  if (text === 'on pulse' || text === 'off pulse') {
    const on = context.time.sub(context.reset ?? new R(0)).mod(new R(1, 4)).numerator === 0n;
    return text === 'on pulse' ? on : !on;
  }
  const sampled = text.match(/^([\w-]+) (<=|>=|<|>|=) ([+-]?\d+(?:\.\d+)?%?)$/);
  if (sampled) {
    const v = context.signal?.(sampled[1], context.time);
    if (v === undefined) return false;
    const threshold = sampled[3].endsWith('%')
      ? Number(sampled[3].slice(0, -1)) / 100
      : Number(sampled[3]);
    return compare(v, sampled[2], threshold);
  }
  const named = context.conditions?.get(text);
  if (!named || seen.has(text)) return false;
  return evaluateCondition(named, context, new Set([...seen, text]));
}
function compare(value: number, operator: string, target: number): boolean {
  return operator === '>'
    ? value > target
    : operator === '<'
      ? value < target
      : operator === '>='
        ? value >= target
        : operator === '<='
          ? value <= target
          : Math.abs(value - target) <= 0.5;
}
