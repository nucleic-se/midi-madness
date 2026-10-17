import { expressionText } from './source.ts';
import type { Argument, Expression, Sequence } from './ast.ts';
import { evaluateCondition } from './conditions.ts';
import { generator, type AddressValue } from './random.ts';
import { parseKey, resolvePitches, shiftPitch } from './pitch.ts';
import { diagnostic, type Diagnostic, type Span } from './diag.ts';
import { compileLiteral, durationNumber, literalType, type LiteralContext } from './literals.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import type { Resolution } from './resolve.ts';
import { perData, perValue, scalarRational, constant } from './constants.ts';
import { emptyTimed, eventGate, sequenceTimed, type TimedType, type TimedValue } from './timed.ts';
const zero = new R(0),
  one = new R(1);
class ExpansionError extends Error {
  readonly code: string;
  readonly span: Span;
  constructor(code: string, message: string, span: Span) {
    super(message);
    this.code = code;
    this.span = span;
  }
}
export function expandBinding(
  resolution: Resolution,
  name: string,
  context: Omit<LiteralContext, 'type'> = {},
): { value?: TimedValue; diagnostics: Diagnostic[] } {
  const statement = resolution.normalized.statements.find(
    (s) => s.kind === 'binding' && s.name === name,
  );
  if (statement?.kind !== 'binding')
    return { diagnostics: [diagnostic('R001', `Unknown material ${name}`, resolution.ast.span)] };
  // Phrases carry the type of their contents, including referenced rhythms.
  function contentType(e: Expression): TimedType | undefined {
    if (e.origin?.kind === 'rhythm') return 'hits';
    if (e.origin?.kind === 'signal') return 'values';
    if (e.origin?.kind === 'progression') return 'harmony';
    if (e.kind === 'group') return e.value.elements.map(contentType).find(Boolean);
    if (e.kind === 'operation') return e.name === 'rhythm' ? 'hits' : contentType(e.receiver);
    if (e.kind === 'literal') {
      // Silence alone cannot choose a phrase's type.
      if (!e.shape && /^[|. _\s]+$/.test(expressionText(e))) return undefined;
      return literalType(e);
    }
    if (e.kind === 'shape') return 'values';
    if (e.kind === 'call' && e.name === 'together')
      return e.args
        .flatMap((a) => (a.kind === 'sequence' ? a.elements : []))
        .map(contentType)
        .find(Boolean);
    return undefined;
  }
  const type: TimedType =
    statement.keyword === 'phrase'
      ? (statement.value.elements.map(contentType).find(Boolean) ?? 'notes')
      : statement.keyword === 'rhythm'
        ? 'hits'
        : statement.keyword === 'signal'
          ? 'values'
          : statement.keyword === 'progression'
            ? 'harmony'
            : 'notes';
  return expandSequence(statement.value, type, {
    ...context,
    path: `${statement.keyword} ${name}`,
  });
}
export function expandSequence(
  sequence: Sequence,
  type: TimedType,
  context: Omit<LiteralContext, 'type'> = {},
): { value?: TimedValue; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const meter = context.meter ?? [4, 4],
    bar = new R(meter[0], meter[1]);
  let cycle = context.cycle ?? 1;
  let rate = bar,
    seed = BigInt(context.seed ?? 1),
    address = context.address ?? [];
  const key = context.key ?? parseKey();
  function fail(code: string, message: string, span: Span): never {
    throw new ExpansionError(code, message, span);
  }
  function argument(arg: Argument | undefined): Expression {
    if (arg?.kind !== 'sequence' || arg.elements.length !== 1)
      return fail('R003', 'Expected one argument expression', arg?.span ?? sequence.span);
    let e = arg.elements[0];
    while (e.kind === 'group' && e.value.elements.length === 1) e = e.value.elements[0];
    return e;
  }
  function amount(e: Expression): R {
    if (e.kind === 'call' && e.name === '__per') {
      if (!context.materialTime)
        return fail('R003', 'Per rate sequences run inside part plays, not song form', e.span);
      try {
        return perValue(e, context.materialTime, meter);
      } catch (error) {
        return fail('R003', (error as Error).message, e.span);
      }
    }
    if (e.kind === 'number')
      return e.text.endsWith('%')
        ? R.parse(e.text.slice(0, -1)).div(new R(100))
        : durationNumber(e.text);
    if (e.kind === 'group' && e.value.elements.length === 1) return amount(e.value.elements[0]);
    if (e.kind === 'name' && e.name === 'section' && context.section) return context.section;
    if (e.kind === 'name' && e.name === 'phrase' && context.phrase) return context.phrase;
    if (e.kind === 'span') {
      const unit = ['bar', 'bars'].includes(e.unit)
        ? bar
        : ['beat', 'beats'].includes(e.unit)
          ? new R(1, 4)
          : ['pulse', 'pulses'].includes(e.unit)
            ? (context.pulse ??
              (meter[1] === 4 ? new R(1, 4) : [6, 9, 12].includes(meter[0]) ? new R(3, 8) : bar))
            : fail('R003', `Unit ${e.unit} requires a grid`, e.span);
      return amount(e.value).mul(unit);
    }
    if (e.kind === 'binary') {
      const a = amount(e.left),
        b = amount(e.right);
      if (e.operator === '+') return a.add(b);
      if (e.operator === '-') return a.sub(b);
      if (e.operator === '*') return a.mul(b);
      if (e.operator === '^')
        return scalarRational(
          (Number(a.numerator) / Number(a.denominator)) **
            (Number(b.numerator) / Number(b.denominator)),
        );
      if (b.equals(zero)) return fail('R013', 'Division by zero', e.span);
      return a.div(b);
    }
    if (e.kind === 'call' && e.name === 'pow') return constant(e, meter);
    if (e.kind === 'call' && e.name === 'extent') return evaluate(argument(e.args[0]), type).extent;
    return fail('R003', 'Expected a resolved scalar or span', e.span);
  }
  function seq(s: Sequence, expected: TimedType, prefix = false): TimedValue {
    const oldRate = rate,
      oldAddress = address,
      oldCycle = cycle;
    const occurrences = new Map<string, number>();
    if (s.rate) rate = amount(s.rate);
    const values: TimedValue[] = [];
    let prior = prefix;
    for (const [i, element] of s.elements.entries()) {
      cycle = oldCycle;
      if (element.origin) {
        const name = element.origin.name,
          n = (occurrences.get(name) ?? 0) + 1;
        occurrences.set(name, n);
        cycle += n - 1;
      }
      address = s.elements.length === 1 ? oldAddress : [...oldAddress, i];
      const v = evaluate(element, expected, prior);
      values.push(v);
      prior ||= v.events.length > 0;
    }
    rate = oldRate;
    address = oldAddress;
    cycle = oldCycle;
    return sequenceTimed(values, expected);
  }
  function evaluate(e: Expression, expected: TimedType, prefix = false): TimedValue {
    const value = evaluateCore(e, expected, prefix);
    return e.kind === 'operation'
      ? {
          ...value,
          events: value.events.map((event) => ({
            ...event,
            source: { ...event.source, operationOrdinal: (event.source.operationOrdinal ?? 0) + 1 },
          })),
        }
      : value;
  }
  function evaluateCore(e: Expression, expected: TimedType, prefix = false): TimedValue {
    if (e.kind === 'call' && e.name === '__per') {
      try {
        const p = perData(e, meter),
          total = p.step.mul(new R(p.values.length));
        const expression: Extract<Expression, { kind: 'literal' }> = {
          kind: 'literal',
          mode: 'across',
          smooth: p.smooth,
          span: e.span,
          duration: {
            kind: 'sequence',
            elements: [{ kind: 'number', text: total.toString(), span: e.span }],
            span: e.span,
          },
          groups: [
            p.values.map((v) => ({
              kind: 'item',
              atoms: [
                {
                  kind: 'clause',
                  tokens: [String(Number(v.numerator) / Number(v.denominator))],
                  span: e.span,
                },
              ],
              options: [],
              span: e.span,
            })),
          ],
        };
        const r = compileLiteral(expression, { ...context, type: 'values' });
        diagnostics.push(...r.diagnostics);
        return r.value ?? emptyTimed('values');
      } catch (error) {
        return fail('R003', (error as Error).message, e.span);
      }
    }
    if (e.kind === 'group') {
      const old = address;
      if (e.callSites?.length) address = [...address, 'call'];
      const value = seq(
        e.value,
        e.origin?.kind === 'rhythm'
          ? 'hits'
          : e.origin?.kind === 'signal'
            ? 'values'
            : e.origin?.kind === 'progression'
              ? 'harmony'
              : expected,
        prefix,
      );
      address = old;
      const traced = e.callSites?.length
        ? {
            ...value,
            events: value.events.map((event) => ({
              ...event,
              source: {
                ...event.source,
                callSites: [...(event.source.callSites ?? []), ...e.callSites!],
              },
            })),
          }
        : value;
      return e.origin
        ? {
            ...traced,
            units: [
              ...value.units,
              {
                name: e.origin.name,
                kind: e.origin.kind,
                onset: zero,
                extent: value.extent,
                source: e.origin.span,
              },
            ],
          }
        : traced;
    }
    if (e.kind === 'label') {
      const value = evaluate(e.value, expected, prefix);
      return {
        ...value,
        units: [
          ...value.units,
          { name: e.name, kind: 'label', onset: zero, extent: value.extent, source: e.span },
        ],
      };
    }
    if (e.kind === 'alternation')
      return evaluate(e.branches[(cycle - 1) % e.branches.length], expected, prefix);
    if (e.kind === 'literal' || e.kind === 'shape') {
      let expression = e;
      if (e.kind === 'literal' && e.duration) {
        const d = amount(argument(e.duration));
        if (d.compare(zero) < 0)
          return fail('R011', 'A literal span must be nonnegative', e.duration.span);
        // Keep explicit triplet spelling when possible; resolved duration expressions use exact fractions.
        if (e.duration.elements[0].kind !== 'number' && e.duration.elements[0].kind !== 'group')
          expression = {
            ...e,
            duration: {
              ...e.duration,
              elements: [{ kind: 'number', text: d.toString(), span: e.duration.span }],
            },
          };
      }
      const result = compileLiteral(expression, {
        ...context,
        type: expected,
        cycle,
        allowLeadingHold: context.allowLeadingHold || prefix,
      });
      diagnostics.push(...result.diagnostics);
      return result.value ?? emptyTimed(expected);
    }
    if (
      e.kind === 'number' ||
      e.kind === 'binary' ||
      (e.kind === 'call' &&
        ['trigger', 'min', 'max', 'clamp', 'pick', 'cycle', 'pow'].includes(e.name))
    ) {
      if (expected !== 'values')
        return fail('R003', 'A scalar/signal expression requires values context', e.span);
      const value = emptyTimed('values', bar);
      value.expression = e;
      return value;
    }
    if (e.kind === 'name' && context.materials?.has(e.name)) return context.materials.get(e.name)!;
    if (e.kind === 'name' && expected === 'harmony') {
      const value = emptyTimed('harmony', rate);
      value.chords.push({ onset: zero, span: rate, symbol: e.name, source: e.span });
      return value;
    }
    if (e.kind === 'name') {
      if (expected === 'values') {
        const value = emptyTimed('values', bar);
        value.expression = e;
        return value;
      }
      return fail('R001', `Unresolved material ${e.name}`, e.span);
    }
    if (e.kind === 'call' && e.name === 'rest') {
      const span = amount(argument(e.args[0]));
      if (span.compare(zero) < 0) return fail('R011', 'A rest span must be nonnegative', e.span);
      const value = emptyTimed(expected, span);
      if (expected === 'harmony' && !span.equals(zero))
        value.chords.push({ onset: zero, span, symbol: 'N', source: e.span });
      return value;
    }
    if (e.kind === 'call' && e.name === 'together') {
      const values = e.args.map((a) =>
        a.kind === 'sequence'
          ? seq(a, expected)
          : fail('R003', 'together requires timed arguments', a.span),
      );
      const result = emptyTimed(expected);
      for (const value of values) {
        if (value.extent.compare(result.extent) > 0) result.extent = value.extent;
        result.events.push(...value.events);
        result.shapes.push(...value.shapes);
      }
      return result;
    }
    if (e.kind === 'operation') {
      if (e.name === 'seed') {
        const old = seed,
          n = amount(argument(e.args[0]));
        if (n.denominator !== 1n) return fail('R003', 'Seed must be an integer', e.span);
        seed = n.numerator;
        const value = evaluate(e.receiver, expected, prefix);
        seed = old;
        return value;
      }
      const receiverType = e.name === 'rhythm' || e.name === 'on' ? 'notes' : expected;
      const input = evaluate(e.receiver, receiverType, prefix);
      if (['fast', 'slow', 'fit'].includes(e.name)) {
        const n = amount(argument(e.args[0]));
        if (
          n.compare(zero) < 0 ||
          (n.equals(zero) &&
            (e.name !== 'fit' ||
              input.events.length > 0 ||
              input.shapes.length > 0 ||
              input.chords.length > 0))
        )
          return fail(
            'R011',
            `${e.name} requires a positive factor/target for nonempty material`,
            e.span,
          );
        const extent =
          e.name === 'fit' ? n : e.name === 'slow' ? input.extent.mul(n) : input.extent.div(n);
        if (input.extent.equals(zero)) return { ...input, extent };
        return scaleTimed(input, extent.div(input.extent));
      }
      if (e.name === 'loop' || e.name === 'repeat') {
        const n = amount(argument(e.args[0]));
        const extent = e.name === 'repeat' ? input.extent.mul(n) : n;
        if (n.compare(zero) < 0)
          return fail('R011', 'A repeat/loop span must be nonnegative', e.span);
        if (extent.equals(zero)) return emptyTimed(input.type);
        if (input.extent.equals(zero)) return { ...input, extent };
        const copies =
          Number(extent.div(input.extent).floor()) +
          (extent.mod(input.extent).equals(zero) ? 0 : 1);
        if (copies > 65536) return fail('D001', 'Expansion exceeds 65536 copies', e.span);
        const oldCycle = cycle,
          oldAddress = address;
        const values: TimedValue[] = [];
        for (let i = 0; i < copies; i++) {
          cycle = i + 1;
          address = [...oldAddress, 'copy', cycle];
          values.push(evaluate(e.receiver, receiverType, prefix || i > 0));
        }
        cycle = oldCycle;
        address = oldAddress;
        return cropTimed(sequenceTimed(values, input.type), extent);
      }
      const sorted = (v: TimedValue): TimedValue => ({
        ...v,
        events: [...v.events].sort((a, b) => a.onset.compare(b.onset)),
      });
      const pitchView = () => resolvePitches(input, context.keyAt ?? key, context.chordAt).value;
      const operation = (name: string, n: number) => ({
        name,
        args: [
          {
            kind: 'sequence' as const,
            elements: [{ kind: 'number' as const, text: String(n), span: e.span }],
            span: e.span,
          },
        ],
        span: e.span,
      });
      if (e.name === 'reverse')
        return sorted({
          ...input,
          units: input.units.map((unit) => ({
            ...unit,
            onset: input.extent.sub(unit.onset).sub(unit.extent),
          })),
          events: input.events.map((event) => ({
            ...event,
            onset: input.extent.sub(event.onset).sub(event.writtenSpan),
          })),
          chords: input.chords
            .map((chord) => ({ ...chord, onset: input.extent.sub(chord.onset).sub(chord.span) }))
            .reverse(),
          shapes: input.shapes.map((shape) => ({
            ...shape,
            onset: input.extent.sub(shape.onset).sub(shape.period),
            reverse: !shape.reverse,
          })),
        });
      if (e.name === 'rotate') {
        if (input.extent.equals(zero)) return input;
        let n: R;
        const arg = argument(e.args[0]);
        if (arg.kind === 'span' && ['step', 'steps'].includes(arg.unit))
          n = amount(arg.value).mul(input.events[0]?.attackSpan ?? new R(1, 16));
        else n = amount(arg);
        return sorted({
          ...input,
          units: input.units.map((unit) => ({
            ...unit,
            onset: unit.onset.sub(n).mod(input.extent),
          })),
          events: input.events.map((event) => ({
            ...event,
            onset: event.onset.sub(n).mod(input.extent),
          })),
          chords: input.chords
            .map((chord) => ({ ...chord, onset: chord.onset.sub(n).mod(input.extent) }))
            .sort((a, b) => a.onset.compare(b.onset)),
          shapes: input.shapes.map((shape) => ({ ...shape, onset: shape.onset.sub(n) })),
        });
      }
      if (e.name === 'fragment') {
        if (input.extent.equals(zero)) return input;
        const half = input.extent.div(new R(2));
        return cropTimed(
          sequenceTimed([cropTimed(input, half), cropTimed(input, half)], input.type),
          input.extent,
        );
      }
      if (e.name === 'thin')
        return {
          ...input,
          events: input.events.filter(
            (event, i) =>
              event.onset.mod(context.pulse ?? new R(1, 4)).equals(zero) ||
              i === input.events.length - 1,
          ),
        };
      if (e.name === 'extend') {
        const n = amount(argument(e.args[0]));
        if (n.compare(zero) < 0) return fail('R011', 'Extend span must be nonnegative', e.span);
        const events = input.events.map((event) => ({ ...event }));
        const last = events.at(-1);
        if (last) {
          last.writtenSpan = last.writtenSpan.add(n);
          last.gate = eventGate(last);
        }
        return { ...input, extent: input.extent.add(n), events };
      }
      if (e.name === 'on') {
        const hits =
          e.args[0]?.kind === 'sequence'
            ? seq(e.args[0], 'hits')
            : fail('R003', 'on requires hits', e.span);
        return {
          ...input,
          extent: hits.extent,
          events: input.events.length
            ? hits.events.map((hit, i) => {
                const note = input.events[i % input.events.length];
                return {
                  ...note,
                  onset: hit.onset,
                  writtenSpan: hit.writtenSpan,
                  attackSpan: hit.attackSpan,
                  gate: hit.gate,
                  gateSpec: hit.gateSpec,
                  velocity: hit.velocity,
                  locks: { ...note.locks, ...hit.locks },
                  conditions: [...note.conditions, ...hit.conditions],
                };
              })
            : [],
        };
      }
      if (e.name === 'invert' && input.type === 'values') {
        const values = [
          ...input.events.flatMap((event) => (event.value === undefined ? [] : [event.value])),
          ...input.shapes.flatMap((shape) => [shape.low, shape.high]),
        ];
        const sum = Math.min(...values) + Math.max(...values);
        return {
          ...input,
          events: input.events.map((event) => ({
            ...event,
            value: event.value === undefined ? undefined : sum - event.value,
          })),
          shapes: input.shapes.map((shape) => ({
            ...shape,
            low: sum - shape.low,
            high: sum - shape.high,
          })),
        };
      }
      if (e.name === 'shift' && input.type === 'harmony') {
        const n = Number(amount(argument(e.args[0])).numerator),
          romans = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
        return {
          ...input,
          chords: input.chords.map((chord) => {
            const m = chord.symbol.match(
              /^([b#]?)(VII|III|VI|IV|II|V|I|vii|iii|vi|iv|ii|v|i)(.*)$/,
            );
            if (!m) return chord;
            const index = romans.indexOf(m[2].toUpperCase()),
              shifted = romans[(((index + n) % 7) + 7) % 7];
            return {
              ...chord,
              symbol: m[1] + (m[2] === m[2].toLowerCase() ? shifted.toLowerCase() : shifted) + m[3],
            };
          }),
        };
      }
      if (e.name === 'where') {
        const arg = e.args[0];
        if (arg?.kind !== 'where')
          return fail('R003', 'where requires condition: operations', e.span);
        const pitches = pitchView();
        const events = input.events.flatMap((event, i) => {
          const phrase = input.units
            .filter(
              (u) =>
                u.kind === 'phrase' &&
                event.onset.compare(u.onset) >= 0 &&
                event.onset.compare(u.onset.add(u.extent)) < 0,
            )
            .sort((a, b) => a.extent.compare(b.extent))[0];
          const passes = evaluateCondition(arg.condition, {
            time: event.onset,
            bar,
            event: pitches.events[i],
            events: pitches.events,
            phraseStart: phrase?.onset,
            phraseExtent: phrase?.extent ?? input.extent,
            sectionExtent: input.extent,
            n: cycle,
            signal: context.signal,
          });
          if (!passes) return [event];
          let single: TimedValue = { ...input, events: [event] };
          for (const op of arg.operations) {
            const term = op.elements[0];
            const name = term?.kind === 'call' || term?.kind === 'name' ? term.name : undefined;
            if (name && op.elements.length === 2 && op.elements[1].kind === 'number') {
              const n = Number(op.elements[1].text);
              single = {
                ...single,
                events: single.events.map((ev) => ({ ...ev, locks: { ...ev.locks, [name]: n } })),
              };
              continue;
            }
            if (
              !name ||
              ![
                'shift',
                'transpose',
                'octave',
                'velocity',
                'accent',
                'length',
                'lengthen',
                'mute',
              ].includes(name)
            )
              return fail('R010', 'Unsupported where operation', op.span);
            if (name === 'mute') return [];
            const args = term.kind === 'call' ? term.args : [];
            const n =
              Number(amount(argument(args[0])).numerator) /
              Number(amount(argument(args[0])).denominator);
            single = {
              ...single,
              events: single.events.map((ev) =>
                name === 'velocity'
                  ? { ...ev, velocity: n }
                  : name === 'accent'
                    ? { ...ev, velocity: ev.velocity + n }
                    : name === 'length'
                      ? {
                          ...ev,
                          gateOverride: true,
                          gate: ev.gateSpec
                            ? ev.gate
                            : argument(args[0]).kind === 'number' &&
                                (
                                  argument(args[0]) as Extract<Expression, { kind: 'number' }>
                                ).text.endsWith('%')
                              ? ev.writtenSpan.mul(amount(argument(args[0])))
                              : amount(argument(args[0])),
                        }
                      : name === 'lengthen'
                        ? ev.gateSpec
                          ? ev
                          : {
                              ...ev,
                              gateOverride: true,
                              gate: ev.gate.add(amount(argument(args[0]))),
                            }
                        : { ...ev, operations: [...ev.operations, { name, args, span: op.span }] },
              ),
            };
          }
          return single.events;
        });
        return { ...input, events };
      }
      if (e.name === 'velocity' || e.name === 'accent') {
        let n: R;
        try {
          n = amount(argument(e.args[0]));
        } catch (error) {
          if (!(error instanceof ExpansionError)) throw error;
          return {
            ...input,
            events: input.events.map((event) => ({
              ...event,
              operations: [...event.operations, { name: e.name, args: e.args, span: e.span }],
            })),
          };
        }
        const velocity = Number(n.numerator) / Number(n.denominator);
        return {
          ...input,
          events: input.events.map((event) => ({
            ...event,
            velocity: e.name === 'accent' ? event.velocity + velocity : velocity,
          })),
        };
      }
      if (e.name === 'length' || e.name === 'lengthen') {
        const arg = argument(e.args[0]),
          n = amount(arg),
          percent = arg.kind === 'number' && arg.text.endsWith('%');
        return {
          ...input,
          events: input.events.map((event) => ({
            ...event,
            gateOverride: true,
            gate: event.gateSpec
              ? event.gate
              : e.name === 'lengthen'
                ? event.gate.add(n)
                : percent
                  ? event.writtenSpan.mul(n)
                  : n,
          })),
        };
      }
      if (e.name === 'peak') {
        const clause = e.args[0],
          n = clause?.kind === 'clause' ? Number(clause.tokens[1]) : NaN;
        if (!Number.isInteger(n) || n < 1 || bar.mul(new R(n - 1)).compare(input.extent) >= 0)
          return fail('R012', 'Peak bar is outside the material', e.span);
        const view = pitchView(),
          group = view.events.filter((event) => event.onset.div(bar).floor() === BigInt(n - 1)),
          peak = Math.max(...group.flatMap((event) => event.pitchNumbers ?? []));
        return {
          ...input,
          events: input.events.map((event, i) =>
            view.events[i].onset.div(bar).floor() === BigInt(n - 1) &&
            view.events[i].pitchNumbers?.includes(peak)
              ? { ...event, operations: [...event.operations, operation('shift', 2)] }
              : event,
          ),
        };
      }
      if (e.name === 'vary') {
        let arg = e.args[0]?.kind === 'sequence' ? e.args[0].elements[0] : undefined;
        while (arg?.kind === 'group' && arg.value.elements.length === 1)
          arg = arg.value.elements[0];
        const mode = arg?.kind === 'name' ? arg.name : undefined,
          k = arg?.kind === 'number' ? Math.min(9, Number(arg.text)) : 1;
        if (!Number.isInteger(k) || k < 0)
          return fail('R011', 'Variation amount must be a nonnegative integer', e.span);
        const count = Math.ceil((k * input.events.length) / 10);
        const material = JSON.stringify({
          type: input.type,
          extent: input.extent.toString(),
          events: input.events.map((event) => [
            event.onset.toString(),
            event.writtenSpan.toString(),
            event.pitches,
            event.velocity,
          ]),
        });
        const draws = input.events.map((event, i) => {
          const next = generator([
            'mm2',
            seed,
            'vary',
            ...address,
            material,
            i,
            event.source.operationOrdinal ?? 0,
          ]);
          return { i, rank: next(), sign: next() < 0.5 ? -1 : 1, step: next() < 0.5 ? 1 : 2 };
        });
        const chosen = new Map(
          draws
            .sort((a, b) => a.rank - b.rank || a.i - b.i)
            .slice(0, count)
            .map((draw) => [draw.i, draw]),
        );
        const grid = input.events.reduce(
          (grid, event) => (event.attackSpan.compare(grid) < 0 ? event.attackSpan : grid),
          input.extent,
        );
        return sorted({
          ...input,
          events: input.events.map((event, i) => {
            const draw = chosen.get(i);
            if (!draw) return event;
            if (input.type === 'hits' || mode === 'rhythm')
              return {
                ...event,
                onset: event.onset.add(grid.mul(new R(draw.sign))).mod(input.extent),
              };
            return {
              ...event,
              operations: [...event.operations, operation('shift', draw.sign * draw.step)],
            };
          }),
        });
      }
      if (e.name === 'recurse') {
        const n = e.args.length ? Number(amount(argument(e.args[0])).numerator) : 1;
        if (!Number.isInteger(n) || n < 0 || n > 3)
          return fail('R011', 'Recursion depth must be 0..3', e.span);
        let value = input;
        for (let iteration = 0; iteration < n; iteration++) {
          const view = resolvePitches(value, context.keyAt ?? key, context.chordAt).value;
          value = {
            ...value,
            events: value.events.flatMap((parent, i) => {
              const start = bar.mul(new R(parent.onset.div(bar).floor())),
                all = input.events.filter(
                  (event) =>
                    event.onset.compare(start) >= 0 && event.onset.compare(start.add(bar)) < 0,
                );
              const seen = new Set<string>(),
                figure = all.filter((event) => {
                  const id = JSON.stringify([
                    event.source.literal,
                    event.source.slot,
                    event.source.ratchet,
                  ]);
                  if (seen.has(id)) return false;
                  seen.add(id);
                  return true;
                });
              if (!figure.length) return [];
              const prototype = figure[0],
                factor = prototype.attackSpan.div(
                  prototype.source.originalAttackSpan ?? prototype.attackSpan,
                ),
                figureExtent = (prototype.source.figureExtent ?? bar).mul(factor),
                figureStart = prototype.onset.sub(
                  (prototype.source.originalFigureOnset ?? zero).mul(factor),
                );
              const first =
                  view.events.find((event) => event.onset.equals(figure[0]?.onset ?? zero))
                    ?.pitchNumbers?.[0] ?? 60,
                target = view.events[i].pitchNumbers?.[0] ?? first;
              let steps = 0;
              while (steps < 64 && shiftPitch(first, steps, key) < target) steps++;
              while (steps > -64 && shiftPitch(first, steps, key) > target) steps--;
              return figure.map((event) => ({
                ...event,
                onset: parent.onset.add(
                  event.onset.sub(figureStart).mul(parent.writtenSpan.div(figureExtent)),
                ),
                writtenSpan: event.writtenSpan.mul(parent.writtenSpan.div(figureExtent)),
                attackSpan: event.attackSpan.mul(parent.writtenSpan.div(figureExtent)),
                gate: event.gate.mul(parent.writtenSpan.div(figureExtent)),
                operations: [...event.operations, operation('shift', steps)],
              }));
            }),
          };
          if (value.events.length > 65536)
            return fail('D001', 'Recursive material exceeds expansion limit', e.span);
        }
        return value;
      }
      if (e.name === 'rhythm')
        return {
          ...input,
          type: 'hits',
          events: input.events.map((event) => ({ ...event, pitches: [] })),
        };
      if (e.name === 'mute') return { ...input, events: [] };
      // Pitch and development operations become executable in slices 4–5.
      return {
        ...input,
        events: input.events.map((event) => ({
          ...event,
          operations: [...event.operations, { name: e.name, args: e.args, span: e.span }],
        })),
      };
    }
    return fail('R003', 'Unsupported material expression', e.span);
  }
  try {
    const value = seq(sequence, type);
    return {
      value: diagnostics.some((d) => d.severity === 'error') ? undefined : value,
      diagnostics,
    };
  } catch (error) {
    if (error instanceof ExpansionError)
      diagnostics.push(diagnostic(error.code, error.message, error.span, { path: context.path }));
    else if (error instanceof RangeError)
      diagnostics.push(diagnostic('R003', error.message, sequence.span, { path: context.path }));
    else throw error;
    return { diagnostics };
  }
}
export function scaleTimed(value: TimedValue, factor: R): TimedValue {
  return {
    ...value,
    units: value.units.map((unit) => ({
      ...unit,
      onset: unit.onset.mul(factor),
      extent: unit.extent.mul(factor),
    })),
    extent: value.extent.mul(factor),
    events: value.events.map((e) => ({
      ...e,
      onset: e.onset.mul(factor),
      writtenSpan: e.writtenSpan.mul(factor),
      attackSpan: e.attackSpan.mul(factor),
      gate: e.gate.mul(factor),
      paths: e.paths?.map((path) => ({ ...path, duration: path.duration.mul(factor) })),
      holds: e.holds.map((h) => ({ ...h, onset: h.onset.mul(factor), span: h.span.mul(factor) })),
    })),
    shapes: value.shapes.map((s) => ({
      ...s,
      onset: s.onset.mul(factor),
      period: s.period.mul(factor),
      every: s.every?.mul(factor),
    })),
    chords: value.chords.map((c) => ({
      ...c,
      onset: c.onset.mul(factor),
      span: c.span.mul(factor),
    })),
  };
}
export function cropTimed(value: TimedValue, extent: R): TimedValue {
  const min = (a: R, b: R) => (a.compare(b) < 0 ? a : b);
  return {
    ...value,
    units: value.units
      .filter((u) => u.onset.compare(extent) < 0)
      .map((u) => ({ ...u, extent: min(u.extent, extent.sub(u.onset)) })),
    extent,
    events: value.events
      .filter((e) => e.onset.compare(extent) < 0)
      .map((e) => ({
        ...e,
        writtenSpan: min(e.writtenSpan, extent.sub(e.onset)),
        gate: min(e.gate, extent.sub(e.onset)),
      })),
    chords: value.chords
      .filter((c) => c.onset.compare(extent) < 0)
      .map((c) => ({ ...c, span: min(c.span, extent.sub(c.onset)) })),
    shapes: extent.equals(zero) ? [] : value.shapes,
    leadingHolds: value.leadingHolds.filter((h) => h.onset.compare(extent) < 0),
  };
}
