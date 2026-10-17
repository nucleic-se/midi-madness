import type { Argument, Expression, File, Sequence } from './ast.ts';
import { constant } from './constants.ts';
import { diagnostic, type Diagnostic, type Span } from './diag.ts';
import type { Structure } from './ir.ts';
import { Rational as R } from '@midi-madness/foundation/time';
const zero = new R(0);
const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
};
function grid(spans: R[]): R {
  const positive = spans.filter((r) => r.compare(zero) > 0);
  const denominator = positive.reduce((a, r) => (a / gcd(a, r.denominator)) * r.denominator, 1n);
  const numerator = positive.reduce(
    (a, r) => gcd(a, r.numerator * (denominator / r.denominator)),
    0n,
  );
  if (!numerator) throw new RangeError('Section lanes need a nonempty song form');
  return new R(numerator, denominator);
}
function one(arg: Argument | undefined): Expression {
  if (arg?.kind !== 'sequence' || arg.elements.length !== 1)
    throw new RangeError('Section lane values and smoothing require constant scalar expressions');
  return arg.elements[0];
}
const sequence = (text: string, span: Span): Sequence => ({
  kind: 'sequence',
  span,
  elements: [{ kind: 'number', text, span }],
});

/** Compile resolved section choices into ordinary song-clock per-value lanes. */
export function lowerSectionLanes(ast: File, structure?: Structure): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new WeakSet<object>();
  function lower(e: Extract<Expression, { kind: 'call' }>) {
    if (!structure) throw new RangeError('Section lanes require a resolved song form');
    const omitted = e.args[0]?.kind === 'clause' && e.args[0].tokens.length === 0;
    const smooth = omitted ? zero : constant(one(e.args[0]), structure.settings.meter);
    if (!omitted && smooth.compare(zero) <= 0)
      throw new RangeError('Section smoothing must be positive');
    const entries = new Map<string, R>();
    const selectors = new Set(structure.sections.flatMap((s) => [s.name, s.sectionName ?? s.name]));
    for (let i = 1; i < e.args.length; i += 2) {
      const selector = e.args[i];
      if (selector?.kind !== 'clause' || selector.tokens.length !== 1)
        throw new RangeError('Invalid section selector');
      const key = selector.tokens[0];
      if (entries.has(key)) throw new RangeError(`Duplicate section selector ${key}`);
      if (key !== '*' && !selectors.has(key))
        throw new RangeError(`Unknown section selector ${key}`);
      entries.set(key, constant(one(e.args[i + 1]), structure.settings.meter));
    }
    const targets = structure.sections.map((s) => {
      const value = entries.get(s.name) ?? entries.get(s.sectionName ?? s.name) ?? entries.get('*');
      if (!value) throw new RangeError(`No section lane value for ${s.name}; add its name or *`);
      return value;
    });
    const step = grid([...structure.sections.map((s) => s.extent), smooth]);
    const count = structure.extent.div(step).floor();
    // One point at song end plus a duplicate prevents wrap interpolation into bar 1.
    if (count + 2n > 65536n)
      throw new RangeError(
        'Section lane exceeds 65536 values; simplify fractional section/smoothing durations',
      );
    let section = 0,
      start = zero,
      initial = targets[0],
      target = targets[0];
    const values: R[] = [];
    if (!initial) throw new RangeError('Section lanes need a nonempty song form');
    const at = (time: R) =>
      smooth.equals(zero)
        ? target
        : initial.add(
            target
              .sub(initial)
              .mul(
                time.sub(start).div(smooth).compare(new R(1)) >= 0
                  ? new R(1)
                  : time.sub(start).div(smooth),
              ),
          );
    for (let n = 0; n <= Number(count); n++) {
      const time = step.mul(new R(n));
      const current = at(time);
      while (
        section + 1 < structure.sections.length &&
        structure.sections[section + 1].onset.compare(time) <= 0
      ) {
        section++;
        if (!targets[section].equals(target)) {
          initial = current;
          target = targets[section];
          start = time;
        }
      }
      values.push(at(time));
    }
    values.push(values.at(-1)!);
    e.name = '__per';
    e.clock = 'song';
    e.args = [
      sequence(step.toString(), e.span),
      sequence(smooth.equals(zero) ? '0' : '1', e.span),
      ...values.map((v) => sequence(v.toString(), e.span)),
    ];
  }
  function walk(value: unknown) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    // Function templates may still contain parameters; their inlined uses below
    // are normalized and can be compiled against the current form.
    if ('kind' in value && value.kind === 'define') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (
      'kind' in value &&
      value.kind === 'call' &&
      'name' in value &&
      value.name === '__sections'
    ) {
      const e = value as Extract<Expression, { kind: 'call' }>;
      try {
        lower(e);
      } catch (error) {
        diagnostics.push(diagnostic('R003', (error as Error).message, e.span));
        // Keep later realization finite and avoid an unknown-function cascade.
        e.name = '__per';
        e.clock = 'song';
        e.args = [sequence('1', e.span), sequence('0', e.span), sequence('0', e.span)];
      }
      return;
    }
    for (const [key, child] of Object.entries(value))
      if (!['span', 'origin', 'callSites'].includes(key)) walk(child);
  }
  walk(ast);
  return diagnostics;
}
