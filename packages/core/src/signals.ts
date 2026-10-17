import { interpolate } from '@midi-madness/foundation/curves';
import { sampleEnvelope } from '@midi-madness/foundation/envelopes';
import { generatedEvents } from './note-generators.ts';
import type { Argument, Expression, Sequence } from './ast.ts';
import { evaluateCondition, parseCondition } from './conditions.ts';
import { curveAt } from './curves.ts';
import { constant, perData, perValue } from './constants.ts';
import { diagnostic, type Diagnostic } from './diag.ts';
import { expandSequence } from './expand.ts';
import type { PartIR, Structure } from './ir.ts';
import { durationNumber } from './literals.ts';
import { generator } from './random.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import type { Resolution } from './resolve.ts';
import { argumentText, expressionText } from './source.ts';
import { sectionAt } from './structure.ts';
import type { TimedValue } from './timed.ts';
const zero = new R(0),
  one = new R(1);
export type SignalContext = {
  reset: R;
  sectionStart?: R;
  phraseStart?: R;
  velocity?: number;
  attack?: number;
  part?: string;
};
export const parameterNames = new Set(
  'cutoff resonance envamount filterdrive attack decay sustain release level drive wave detune noise sub glide bend vibrato mod send1 send2 delay reverb pan tune tone'.split(
    ' ',
  ),
);
export function createSignalSampler(
  resolution: Resolution,
  structure: Structure,
  parts: PartIR[] = [],
) {
  const diagnostics: Diagnostic[] = [],
    bar = new R(...structure.settings.meter),
    cache = new WeakMap<object, Map<string, TimedValue>>();
  const stage2 = new Map(
    parts.map((p) => [
      p.name,
      p.events
        .flatMap((e) =>
          e.generator?.kind === 'ratchet'
            ? generatedEvents(
                e,
                240 /
                  (Number(structure.settings.tempo.numerator) /
                    Number(structure.settings.tempo.denominator)),
                String(structure.settings.seed),
              )
            : [e],
        )
        .filter(
          (e, i, a) => !a.slice(0, i).some((other) => other.nominalOnset.equals(e.nominalOnset)),
        )
        .map((e) => ({ time: e.nominalOnset, velocity: e.velocity })),
    ]),
  );
  const conditions = new Map(
    resolution.normalized.statements
      .filter((s) => s.kind === 'when')
      .map((s) => [s.name, s.condition]),
  );
  function issue(code: string, message: string, e: Expression) {
    if (
      !diagnostics.some(
        (d) => d.code === code && d.span.line === e.span.line && d.span.col === e.span.col,
      )
    )
      diagnostics.push(diagnostic(code, message, e.span));
  }
  function amount(e: Expression): R {
    if (e.kind === 'number') return durationNumber(e.text);
    if (e.kind === 'group') return amount(e.value.elements[0]);
    if (e.kind === 'span')
      return amount(e.value).mul(
        e.unit.startsWith('bar') ? bar : e.unit.startsWith('beat') ? new R(1, 4) : new R(1, 4),
      );
    if (e.kind === 'binary') {
      const a = amount(e.left),
        b = amount(e.right);
      return e.operator === '+'
        ? a.add(b)
        : e.operator === '-'
          ? a.sub(b)
          : e.operator === '*'
            ? a.mul(b)
            : a.div(b);
    }
    return bar;
  }
  function arg(arg: Argument | undefined): Expression | undefined {
    return arg?.kind === 'sequence'
      ? arg.elements.length === 1
        ? arg.elements[0]
        : { kind: 'group', value: arg, span: arg.span }
      : undefined;
  }
  function timed(e: Expression, t: R, c: SignalContext): TimedValue | undefined {
    const section = sectionAt(structure, t) ?? structure.sections.at(-1),
      phrase = structure.material.units
        .filter(
          (u) =>
            u.kind === 'phrase' && t.compare(u.onset) >= 0 && t.compare(u.onset.add(u.extent)) < 0,
        )
        .sort((a, b) => a.extent.compare(b.extent))[0];
    const key = `${section?.onset}/${phrase?.onset}/${c.reset}/${c.part}`;
    let entries = cache.get(e);
    if (!entries) {
      entries = new Map();
      cache.set(e, entries);
    }
    if (entries.has(key)) return entries.get(key);
    const result = expandSequence({ kind: 'sequence', elements: [e], span: e.span }, 'values', {
      meter: structure.settings.meter,
      section: section?.extent,
      phrase: phrase?.extent ?? section?.extent,
      seed: structure.settings.seed,
      address: [c.part ?? 'signal', expressionText(e)],
    });
    diagnostics.push(...result.diagnostics);
    if (result.value) entries.set(key, result.value);
    return result.value;
  }
  function extent(e: Expression, t: R, c: SignalContext): R {
    if (e.kind === 'call' && e.name === '__per') {
      try {
        const p = perData(e, structure.settings.meter);
        return p.step.mul(new R(p.values.length));
      } catch (error) {
        issue('R003', (error as Error).message, e);
        return bar;
      }
    }
    if (e.kind === 'group') return e.value.elements.reduce((a, e) => a.add(extent(e, t, c)), zero);
    if (e.kind === 'binary') {
      const a = extent(e.left, t, c),
        b = extent(e.right, t, c);
      return a.compare(b) > 0 ? a : b;
    }
    if (e.kind === 'number' || e.kind === 'name' || (e.kind === 'call' && e.name !== 'rest'))
      return bar;
    return timed(e, t, c)?.extent ?? bar;
  }
  function sampleSequence(s: Sequence, t: R, c: SignalContext, local?: R): number | undefined {
    if (s.elements.length === 1) return sample(s.elements[0], t, c, local);
    const lengths = s.elements.map((e) => extent(e, t, c)),
      total = lengths.reduce((a, b) => a.add(b), zero);
    if (total.equals(zero)) return undefined;
    let at = (local ?? t.sub(c.reset)).mod(total);
    for (let i = 0; i < s.elements.length; i++) {
      if (at.compare(lengths[i]) < 0) return sample(s.elements[i], t, c, at);
      at = at.sub(lengths[i]);
    }
    return undefined;
  }
  function named(name: string, t: R, c: SignalContext, raw = false): number | undefined {
    const curve = curveAt(resolution, structure, name, t);
    if (curve !== undefined) return raw ? curve : curve / 9;
    const binding = resolution.normalized.statements.find(
      (s) => s.kind === 'binding' && s.name === name,
    );
    return binding?.kind === 'binding' ? sampleSequence(binding.value, t, c) : undefined;
  }
  function sample(e: Expression, t: R, c: SignalContext, local?: R): number | undefined {
    if (e.kind === 'call' && e.name === '__per') {
      try {
        const v = perValue(e, local ?? t.sub(c.reset), structure.settings.meter);
        return Number(v.numerator) / Number(v.denominator);
      } catch (error) {
        issue('R003', (error as Error).message, e);
        return undefined;
      }
    }
    if (e.kind === 'number') {
      const v = constant(e);
      return Number(v.numerator) / Number(v.denominator);
    }
    if (e.kind === 'name') {
      if (e.name === 'velocity') return c.velocity ?? 0.8;
      const v = curveAt(resolution, structure, e.name, t);
      if (v !== undefined) return v / 9;
      return named(e.name, t, c);
    }
    if (e.kind === 'group') return sampleSequence(e.value, t, c, local);
    if (e.kind === 'label') return sample(e.value, t, c, local);
    if (e.kind === 'binary') {
      const a = sample(e.left, t, c, local),
        b = sample(e.right, t, c, local);
      if (a === undefined || b === undefined) return undefined;
      if (e.operator === '/') {
        if (b === 0) {
          issue('R013', 'Division by zero in signal', e);
          return undefined;
        }
        return a / b;
      }
      if (e.operator === '^') {
        const v = a ** b;
        if (!Number.isFinite(v)) {
          issue('R013', 'Power must produce a finite real value', e);
          return undefined;
        }
        return v;
      }
      return e.operator === '+' ? a + b : e.operator === '-' ? a - b : a * b;
    }
    if (e.kind === 'call' && e.name === 'trigger') {
      const name = argumentText(e.args[0]).replace(/[()]/g, '').trim(),
        options = e.args.slice(1).map(argumentText).join(', '),
        onsets = stage2.get(name) ?? [],
        active = onsets.filter((o) => o.time.compare(t) <= 0);
      const envelope = options.match(/(?:attack ([\d/.]+) )?decay ([\d/.]+)/),
        attack = envelope?.[1] ? durationNumber(envelope[1]) : zero,
        decay = envelope ? durationNumber(envelope[2]) : zero;
      const points: { time: R; value: number }[] = [];
      if (options.includes('env ')) {
        for (const token of options.slice(options.indexOf('env ') + 4).split(',')) {
          const m = token.trim().match(/^([\d.]+)(?: at ([\d/.]+))?/);
          if (m) points.push({ value: Number(m[1]), time: m[2] ? durationNumber(m[2]) : zero });
        }
      } else {
        points.push({ time: zero, value: attack.equals(zero) ? 1 : 0 });
        if (!attack.equals(zero)) points.push({ time: attack, value: 1 });
        points.push({ time: attack.add(decay), value: 0 });
      }
      const value = (o: { time: R; velocity: number }) => {
        const age = t.sub(o.time);
        if (!points.length || age.compare(points.at(-1)!.time) >= 0) return 0;
        for (let i = 0; i < points.length - 1; i++)
          if (age.compare(points[i + 1].time) < 0) {
            const p = points[i],
              q = points[i + 1],
              ratio = age.sub(p.time).div(q.time.sub(p.time));
            return interpolate(p.value, q.value, ratio.toNumber());
          }
        return 0;
      };
      return sampleEnvelope(
        {
          duration: points.at(-1)?.time.toNumber() ?? 0,
          idle: 0,
          combine: options.includes('sum') ? 'sum' : 'latest',
          ...(options.includes('sum') ? { ceiling: 1 } : {}),
          tie: 'last',
        },
        active,
        {
          age: (onset) => t.sub(onset.time).toNumber(),
          sample: (_age, onset) => value(onset),
          velocity: (onset) => (options.includes('unscaled') ? 1 : onset.velocity),
        },
      );
    }
    if (e.kind === 'call' && e.name === 'cycle') {
      const seq = e.args[0];
      if (seq?.kind !== 'sequence' || !seq.elements.length) return undefined;
      return sample(seq.elements[(c.attack ?? 0) % seq.elements.length], t, c, local);
    }
    if (e.kind === 'call' && e.name === 'pick') {
      const condition = argumentText(e.args[0]);
      const section = sectionAt(structure, t),
        selected = evaluateCondition(parseCondition(condition), {
          time: t,
          bar,
          reset: c.reset,
          sectionStart: section?.onset,
          sectionExtent: section?.extent,
          conditions,
          names: [section?.name ?? ''],
          signal: (n, t) => curveAt(resolution, structure, n, t),
        })
          ? 1
          : 2;
      const a = arg(e.args[selected]);
      return a ? sample(a, t, c, local) : undefined;
    }
    if (e.kind === 'call' && ['min', 'max', 'clamp', 'pow'].includes(e.name)) {
      const values = e.args.map((a) => {
        const ex = arg(a);
        return ex ? sample(ex, t, c, local) : undefined;
      });
      if (values.some((v) => v === undefined)) return undefined;
      const v = values as number[];
      if (e.name === 'pow') {
        const result = v[0] ** v[1];
        if (!Number.isFinite(result)) {
          issue('R013', 'Power must produce a finite real value', e);
          return undefined;
        }
        return result;
      }
      return e.name === 'min'
        ? Math.min(...v)
        : e.name === 'max'
          ? Math.max(...v)
          : Math.max(v[1], Math.min(v[2], v[0]));
    }
    const value = timed(e, t, c);
    if (!value || value.extent.compare(zero) <= 0) return undefined;
    const contextual = expressionText(e).match(/across (section|phrase)/),
      section = sectionAt(structure, t),
      origin =
        contextual?.[1] === 'section'
          ? (section?.onset ?? c.reset)
          : contextual?.[1] === 'phrase'
            ? (c.phraseStart ?? section?.onset ?? c.reset)
            : c.reset;
    const elapsed = local ?? t.sub(origin),
      phase = elapsed.mod(value.extent);
    const shape = value.shapes.find(
      (s) => phase.compare(s.onset) >= 0 && phase.compare(s.onset.add(s.period)) < 0,
    );
    if (shape) {
      let p = phase.sub(shape.onset).div(shape.period),
        x = Number(p.numerator) / Number(p.denominator);
      if (shape.reverse) x = 1 - x;
      let y = x;
      if (shape.name === 'sine') y = (1 - Math.cos(2 * Math.PI * x)) / 2;
      else if (shape.name === 'triangle') y = x < 0.5 ? 2 * x : 2 - 2 * x;
      else if (shape.name === 'saw') y = 1 - x;
      else if (shape.name === 'square') y = x < 0.5 ? 0 : 1;
      else if (shape.name === 'hold') y = 0;
      else if (shape.name === 'random') {
        const index = phase
            .sub(shape.onset)
            .div(shape.every ?? shape.period)
            .floor(),
          cycle = elapsed.div(value.extent).floor();
        y = generator([
          'mm2',
          structure.settings.seed,
          'random',
          c.part ?? 'signal',
          expressionText(e),
          cycle,
          index,
        ])();
      }
      if (shape.name === 'exp' || shape.name === 'log')
        return interpolate(shape.low, shape.high, x, shape.name);
      return shape.low + (shape.high - shape.low) * y;
    }
    const event = value.events.find(
      (ev) => phase.compare(ev.onset) >= 0 && phase.compare(ev.onset.add(ev.writtenSpan)) < 0,
    );
    if (!event || event.value === undefined) return undefined;
    if (!value.smooth) return event.value;
    const index = value.events.indexOf(event),
      next = value.events[(index + 1) % value.events.length],
      nextTime = index + 1 < value.events.length ? next.onset : value.extent.add(next.onset),
      ratio = phase.sub(event.onset).div(nextTime.sub(event.onset));
    return interpolate(event.value, next.value ?? event.value, ratio.toNumber());
  }
  function range(e: Expression): readonly [number, number] {
    if (e.kind === 'call' && e.name === '__per') {
      try {
        const values = perData(e, structure.settings.meter).values.map(
          (v) => Number(v.numerator) / Number(v.denominator),
        );
        return [Math.min(...values), Math.max(...values)];
      } catch (error) {
        issue('R003', (error as Error).message, e);
        return [0, 1];
      }
    }
    if (e.kind === 'number') {
      const v = constant(e),
        n = Number(v.numerator) / Number(v.denominator);
      return [n, n];
    }
    if (e.kind === 'name' || (e.kind === 'call' && e.name === 'trigger')) return [0, 1];
    if (e.kind === 'group') {
      const all = e.value.elements.map(range);
      return [Math.min(...all.map((r) => r[0])), Math.max(...all.map((r) => r[1]))];
    }
    if (e.kind === 'binary') {
      const a = range(e.left),
        b = range(e.right);
      if (e.operator === '+') return [a[0] + b[0], a[1] + b[1]];
      if (e.operator === '-') return [a[0] - b[1], a[1] - b[0]];
      if (e.operator === '/' && b[0] <= 0 && b[1] >= 0) {
        issue('R013', 'Divisor can be zero', e);
        return [-Infinity, Infinity];
      }
      if (
        e.operator === '^' &&
        ((a[0] < 0 && (b[0] !== b[1] || !Number.isInteger(b[0]))) ||
          (a[0] <= 0 && a[1] >= 0 && b[0] < 0))
      ) {
        issue('R013', 'Power can produce a non-finite or non-real value', e);
        return [-Infinity, Infinity];
      }
      const combinations = a.flatMap((x) =>
        b.map((y) => (e.operator === '*' ? x * y : e.operator === '^' ? x ** y : x / y)),
      );
      if (e.operator === '^' && b[0] <= 0 && b[1] >= 0) combinations.push(1);
      if (e.operator === '^' && a[0] <= 0 && a[1] >= 0 && b[1] > 0) combinations.push(0);
      if (combinations.some((n) => !Number.isFinite(n))) {
        issue('R013', 'Power must produce a finite real value', e);
        return [-Infinity, Infinity];
      }
      return [Math.min(...combinations), Math.max(...combinations)];
    }
    if (e.kind === 'call' && e.name === 'pow' && e.args.length === 2) {
      const a = arg(e.args[0]),
        b = arg(e.args[1]);
      if (a && b) return range({ kind: 'binary', operator: '^', left: a, right: b, span: e.span });
    }
    if (e.kind === 'call' && e.name === 'clamp') {
      const lo = arg(e.args[1]),
        hi = arg(e.args[2]);
      return [lo ? range(lo)[0] : 0, hi ? range(hi)[1] : 1];
    }
    if (e.kind === 'call' && ['min', 'max', 'pick', 'cycle'].includes(e.name)) {
      const entries = e.args
        .slice(e.name === 'pick' ? 1 : 0)
        .map(arg)
        .filter((e) => e !== undefined)
        .map(range);
      return [Math.min(...entries.map((r) => r[0])), Math.max(...entries.map((r) => r[1]))];
    }
    const value = timed(e, zero, { reset: zero });
    const numbers = [
      ...(value?.events.flatMap((e) => (e.value === undefined ? [] : [e.value])) ?? []),
      ...(value?.shapes.flatMap((s) => [s.low, s.high]) ?? []),
    ];
    return numbers.length ? [Math.min(...numbers), Math.max(...numbers)] : [0, 1];
  }
  return { sample, sampleSequence, named, range, diagnostics };
}
