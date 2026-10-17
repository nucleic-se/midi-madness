import { pathEndpoint, type NotePath } from './note-paths.ts';
import { resolvePitch } from './pitch.ts';
import type { Clause, Expression, Item, Sequence } from './ast.ts';
import { diagnostic, type Diagnostic, type Span } from './diag.ts';
import { expressionText } from './source.ts';
import { parseExpression } from './parser.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import {
  emptyTimed,
  eventGate,
  type GateSpec,
  type LiteralEvent,
  type Shape,
  type TimedType,
  type TimedValue,
} from './timed.ts';
/** Rest-only prefixes carry no type; infer from the first sounding element. */
export function literalType(expression: Extract<Expression, { kind: 'literal' }>): TimedType {
  if (expression.shape) return 'values';
  function first(items: Item[]): string | undefined {
    for (const item of items)
      for (const atom of item.atoms) {
        if (atom.kind === 'subdivision' || (atom.kind === 'alternation' && 'items' in atom)) {
          const value = first(atom.items);
          if (value !== undefined) return value;
        } else if (atom.kind === 'clause') {
          const value = atom.tokens.join('');
          if (!['.', '_'].includes(value)) return value;
        }
      }
  }
  const value = first(expression.groups.flat()) ?? '';
  return /^[xXo](?:[+-]\d+)?$/.test(value)
    ? 'hits'
    : /^[+-]?\d+\.\d+$/.test(value)
      ? 'values'
      : 'notes';
}
export type LiteralContext = {
  materialTime?: R;
  absoluteMaterialTime?: R;
  type: TimedType;
  meter?: readonly [number, number];
  pulse?: R;
  section?: R;
  phrase?: R;
  cycle?: number;
  allowLeadingHold?: boolean;
  materials?: Map<string, import('./timed.ts').TimedValue>;
  signal?: (name: string, time: R) => number | undefined;
  keyAt?: (time: R) => import('./pitch.ts').Key;
  path?: string;
  seed?: number | bigint;
  address?: (string | number)[];
  key?: import('./pitch.ts').Key;
  chordAt?: (time: R) => import('./pitch.ts').Chord | undefined;
};
type DurationContext = Omit<LiteralContext, 'type'>;
const zero = new R(0);
class ExpansionLimitError extends RangeError {}
/** Appendix C's normative Bjorklund procedure, including its orientation. */
export function euclid(k: number, n: number, rotation = 0): boolean[] {
  if (![k, n, rotation].every(Number.isSafeInteger) || n < 1 || k < 0 || k > n)
    throw new RangeError('Euclid requires integer 0 ≤ k ≤ n, n ≥ 1 and an integer rotation');
  if (n > 65536)
    throw new ExpansionLimitError(
      'Euclid expansion exceeds the literal resource limit (65536 slots)',
    );
  let result: boolean[];
  if (k === 0) result = Array<boolean>(n).fill(false);
  else if (k === n) result = Array<boolean>(n).fill(true);
  else {
    let a = Array.from({ length: k }, () => [true]),
      b = Array.from({ length: n - k }, () => [false]);
    let i = k,
      j = n - k;
    while (Math.min(i, j) > 1) {
      if (i > j)
        [a, b, i, j] = [a.slice(0, j).map((value, x) => [...value, ...b[x]]), a.slice(j), j, i - j];
      else [a, b, i, j] = [a.map((value, x) => [...value, ...b[x]]), b.slice(i), i, j - i];
    }
    result = [...a.flat(), ...b.flat()];
  }
  const r = ((rotation % n) + n) % n;
  return [...result.slice(r), ...result.slice(0, r)];
}
export function isBinaryDuration(value: R): boolean {
  const powerOfTwo = (n: bigint) => n > 0n && (n & (n - 1n)) === 0n;
  return (
    value.numerator > 0n &&
    powerOfTwo(value.denominator) &&
    (powerOfTwo(value.numerator) ||
      (value.numerator % 3n === 0n && powerOfTwo(value.numerator / 3n)))
  );
}
export function durationNumber(text: string): R {
  if (text.endsWith('t')) return R.parse(text.slice(0, -1)).mul(new R(2, 3));
  if (text.endsWith('.')) return R.parse(text.slice(0, -1)).mul(new R(3, 2));
  return R.parse(text);
}
function bar(context: DurationContext): R {
  const [n, d] = context.meter ?? [4, 4];
  if (n < 1 || d < 1 || !Number.isSafeInteger(n) || !Number.isSafeInteger(d))
    throw new RangeError('Meter requires positive integers');
  return new R(n, d);
}
function unit(name: string, context: DurationContext): R {
  if (name === 'bar' || name === 'bars') return bar(context);
  if (name === 'beat' || name === 'beats') return new R(1, 4);
  if (name === 'pulse' || name === 'pulses') {
    if (context.pulse) return context.pulse;
    const [n, d] = context.meter ?? [4, 4];
    return d === 4 ? new R(1, 4) : d === 8 && [6, 9, 12].includes(n) ? new R(3, 8) : bar(context);
  }
  throw new RangeError(`Duration unit ${name} needs a grid or is not a musical span`);
}
function quantity(
  expr: Expression,
  context: DurationContext,
): { value: R; dimension: 'number' | 'span' } {
  if (expr.kind === 'number')
    return {
      value: durationNumber(expr.text),
      dimension: expr.text.includes('/') ? 'span' : 'number',
    };
  if (expr.kind === 'name' && (expr.name === 'section' || expr.name === 'phrase')) {
    const value = context[expr.name];
    if (!value) throw new RangeError(`${expr.name} span requires an occurrence context`);
    return { value, dimension: 'span' };
  }
  if (expr.kind === 'span')
    return {
      value: quantity(expr.value, context).value.mul(unit(expr.unit, context)),
      dimension: 'span',
    };
  if (expr.kind === 'group' && expr.value.elements.length === 1)
    return quantity(expr.value.elements[0], context);
  if (expr.kind === 'binary') {
    const a = quantity(expr.left, context),
      b = quantity(expr.right, context);
    if (expr.operator === '+' || expr.operator === '-') {
      if (a.dimension !== b.dimension)
        throw new RangeError('Span arithmetic requires spans on both sides');
      return {
        value: expr.operator === '+' ? a.value.add(b.value) : a.value.sub(b.value),
        dimension: a.dimension,
      };
    }
    if (expr.operator === '*') {
      if (a.dimension === 'span' && b.dimension === 'span')
        throw new RangeError('A span can only be multiplied by a number');
      return {
        value: a.value.mul(b.value),
        dimension: a.dimension === 'span' || b.dimension === 'span' ? 'span' : 'number',
      };
    }
    if (expr.operator === '/') {
      if (b.dimension === 'span') throw new RangeError('A span can only be divided by a number');
      return { value: a.value.div(b.value), dimension: a.dimension };
    }
  }
  throw new RangeError('Span requires a constant duration at this implementation stage');
}
export function sequenceDuration(sequence: Sequence, context: DurationContext = {}): R {
  if (sequence.elements.length !== 1) throw new RangeError('Expected one span expression');
  const result = quantity(sequence.elements[0], context);
  if (result.dimension !== 'span') throw new RangeError('A duration needs a unit or fraction');
  if (result.value.compare(zero) < 0)
    throw new DurationError('R011', 'Duration must be nonnegative');
  return result.value;
}
export function parseDuration(source: string, context: DurationContext = {}): R {
  const parsed = parseExpression(source);
  if (parsed.diagnostics.length || !parsed.expression)
    throw new RangeError(`Invalid duration: ${source}`);
  return sequenceDuration(
    { kind: 'sequence', elements: [parsed.expression], span: parsed.expression.span },
    context,
  );
}
class DurationError extends RangeError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
function explicitTriplet(expression: Expression): boolean {
  if (expression.kind === 'number') return expression.text.endsWith('t');
  if (expression.kind === 'group') return expression.value.elements.some(explicitTriplet);
  if (expression.kind === 'binary')
    return explicitTriplet(expression.left) || explicitTriplet(expression.right);
  if (expression.kind === 'span') return explicitTriplet(expression.value);
  return false;
}
function durationErrorCode(error: unknown): string {
  return error instanceof DurationError ? error.code : 'R003';
}
type Options = {
  paths?: NotePath[];
  group?: string;
  generator?: import('./note-generators.ts').NoteGenerator;
  velocity?: number;
  gateSpec?: GateSpec;
  locks: Record<string, number>;
  conditions: Clause[];
  fields: Clause[];
};
class LiteralCompiler {
  readonly diagnostics: Diagnostic[] = [];
  readonly value: TimedValue;
  readonly context: LiteralContext;
  readonly literal: Span;
  readonly literalText: string;
  readonly mode: string;
  previous: LiteralEvent[] = [];
  readonly widths = new Map<Item, bigint>();
  constructor(expression: Expression, context: LiteralContext) {
    this.context = context;
    this.literal = expression.span;
    this.literalText = expressionText(expression);
    this.mode = expression.kind === 'literal' ? expression.mode : 'shape';
    this.value = emptyTimed(context.type);
  }
  error(code: string, message: string, span: Span, measured?: Record<string, unknown>): void {
    this.diagnostics.push(diagnostic(code, message, span, { path: this.context.path, measured }));
  }
  integer(
    text: string | undefined,
    fallback: number,
    span: Span,
    label: string,
    minimum = 1,
  ): number {
    if (text === undefined) return fallback;
    const n = Number(text);
    if (!/^[+-]?\d+$/.test(text) || !Number.isSafeInteger(n) || n < minimum) {
      this.error('R011', `${label} requires an integer ≥ ${minimum}`, span, {
        value: text,
        minimum,
      });
      return fallback;
    }
    return n;
  }
  width(item: Item): bigint {
    const known = this.widths.get(item);
    if (known !== undefined) return known;
    const result = this.measureWidth(item);
    this.widths.set(item, result);
    return result;
  }
  measureWidth(item: Item): bigint {
    const weight = BigInt(this.integer(item.weight, 1, item.span, 'Weight'));
    if (item.euclid) {
      const written = Number(item.euclid[1]);
      const n = Number.isSafeInteger(written) && written > 0 ? written : 1;
      return weight * BigInt(n);
    }
    const atom = item.atoms[0];
    if (atom?.kind === 'alternation' && 'items' in atom) {
      const widths = atom.items.map((item) => this.width(item));
      if (widths.some((w) => w !== widths[0]))
        this.error('T005', 'Alternation branches have unequal slot extents', atom.span, {
          slots: widths.map(String),
          required: 'equal branch extents',
        });
      return weight * (widths[0] ?? 1n);
    }
    return weight;
  }
  options(clauses: Clause[], inherited: Options): Options {
    const result: Options = {
      ...inherited,
      generator: inherited.generator ? { ...inherited.generator } : undefined,
      paths: [...(inherited.paths ?? [])],
      locks: { ...inherited.locks },
      conditions: [...inherited.conditions],
      fields: [...inherited.fields],
    };
    for (const clause of clauses) {
      const tokens = [...clause.tokens];
      let name = tokens.shift()!;
      while (tokens[0] === '.' && tokens.length > 2) {
        name += `.${tokens[1]}`;
        tokens.splice(0, 2);
      }
      const source = tokens.join(' ');
      if (
        name === 'ratchet' ||
        name === 'grains' ||
        name.startsWith('ratchet.') ||
        name.startsWith('grain.')
      ) {
        try {
          const kind = name.startsWith('ratchet') ? 'ratchet' : 'grains';
          if (result.generator && result.generator.kind !== kind)
            throw new RangeError('Choose ratchets or grains for an event');
          const g = (result.generator ??= { kind, count: 1 });
          const m = source.replace(/\s/g, '').match(/^([+-]?\d+(?:\.\d+)?)(ms|s|ct|st|oct)?$/);
          if (!m) throw new RangeError(`Invalid ${name} value`);
          if (
            m[2] &&
            !(
              (name === 'grain.size' && ['ms', 's'].includes(m[2])) ||
              (['ratchet.pitch', 'grain.pitchjitter'].includes(name) &&
                ['ct', 'st', 'oct'].includes(m[2]))
            )
          )
            throw new RangeError(`Unsupported unit for ${name}`);
          let value = Number(m[1]);
          if (m[2] === 'ms') value /= 1000;
          if (m[2] === 'st') value *= 100;
          if (m[2] === 'oct') value *= 1200;
          const key = (
            {
              ratchet: 'count',
              grains: 'count',
              'ratchet.decay': 'decay',
              'ratchet.pitch': 'pitch',
              'ratchet.curve': 'curve',
              'grain.size': 'size',
              'grain.scatter': 'scatter',
              'grain.pitchjitter': 'pitchJitter',
              'grain.pan': 'pan',
            } as Record<string, Exclude<keyof import('./note-generators.ts').NoteGenerator, 'kind'>>
          )[name];
          if (!key) throw new RangeError(`Unknown generator control ${name}`);
          if (
            (key === 'count' && (!Number.isInteger(value) || value < 1 || value > 65536)) ||
            (['decay', 'scatter', 'pan'].includes(key) && (value < 0 || value > 1)) ||
            (['size', 'curve'].includes(key) &&
              (value <= 0 || value > (key === 'size' ? 10 : 16))) ||
            (key === 'pitchJitter' && (value < 0 || value > 2400))
          )
            throw new RangeError(`Out-of-range ${name}`);
          g[key] = value;
        } catch (error) {
          this.error('R003', (error as Error).message, clause.span);
        }
        continue;
      }

      if (name === 'group') {
        if (tokens.length !== 1 || !/^[A-Za-z][\w-]*$/.test(tokens[0]))
          this.error('R003', 'group needs one identifier', clause.span);
        else result.group = tokens[0];
        continue;
      }
      if (tokens.includes('->')) {
        try {
          const path = source.match(
            /^(.*?)\s*->\s*(.*?)\s+over\s+(.+?)(?:\s+curve\s+(linear|exp|log))?$/,
          );
          if (!path) throw new RangeError('Note paths use a -> b over span [curve linear|exp|log]');
          const numeric = (text: string) => pathEndpoint(name, text);
          const pitchTarget = path[2].replace(/\s+/g, '');
          const absolutePitch = name === 'pitch' && /^[A-G][#b]?-?\d+$/.test(pitchTarget);
          const from = path[1].trim() ? numeric(path[1]) : undefined;
          const to = absolutePitch ? resolvePitch(pitchTarget) : numeric(path[2]);
          const duration = parseDuration(path[3], this.context);
          const curve = (path[4] ?? 'linear') as NotePath['curve'];
          if (duration.compare(zero) <= 0)
            throw new RangeError('Note path duration must be positive');
          if (name !== 'pitch' && from === undefined)
            throw new RangeError('Parameter paths require a starting value');
          if (curve !== 'linear' && (from === undefined || from <= 0 || to <= 0))
            throw new RangeError('exp/log note paths require positive starting and ending values');
          result.paths!.push({ name, from, to, duration, curve, absolutePitch });
          // Exclude paths from member-wide lock streams; they belong only to this voice.
        } catch (error) {
          this.error('R003', (error as Error).message, clause.span);
        }
        continue;
      }

      if (
        name !== 'length' &&
        !['after', 'chance'].includes(name) &&
        /^[+-]?\d+(?:\.\d+)?\s*(?:ms|s|Hz|kHz|ct|st|oct|dB)$/.test(source)
      ) {
        this.error(
          'R003',
          `Unsupported unit literal in ${name} lock: ${source}; use a numeric value or a supported software unit`,
          clause.span,
        );
        continue;
      }
      if (name === 'velocity') {
        const value = source.endsWith('%') ? Number(source.slice(0, -1)) / 100 : Number(source);
        if (!Number.isFinite(value)) result.fields.push(clause);
        else result.velocity = value;
      } else if (name === 'length') {
        try {
          result.gateSpec = source.endsWith('%')
            ? { kind: 'percent', amount: R.parse(source.slice(0, -1)) }
            : { kind: 'span', span: parseDuration(source, this.context) };
          if (result.gateSpec.kind === 'percent' && result.gateSpec.amount.compare(zero) < 0)
            throw new RangeError('Length percentage must be nonnegative');
        } catch (error) {
          this.error(
            'R003',
            error instanceof Error ? error.message : 'Invalid length',
            clause.span,
          );
        }
      } else if (
        tokens.length === 1 &&
        /^[+-]?\d+(?:\.\d+)?%?$/.test(source) &&
        !['chance', 'after'].includes(name)
      ) {
        result.locks[name] = source.endsWith('%')
          ? Number(source.slice(0, -1)) / 100
          : Number(source);
      } else result.conditions.push(clause);
    }
    return result;
  }
  checkSlot(duration: R, span: Span, slots: number | bigint, level: string): void {
    if (isBinaryDuration(duration)) return;
    this.error(
      'T001',
      `${level} has ${slots} slots; slot duration ${duration} is neither binary nor dotted`,
      span,
      {
        slots:
          typeof slots === 'bigint'
            ? slots <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(slots)
              : String(slots)
            : slots,
        slotDuration: duration.toString(),
        required: '2^k or 3·2^k whole notes',
      },
    );
  }
  list(
    items: Item[],
    onset: R,
    extent: R,
    explicit: boolean,
    path: number[],
    inherited: Options,
  ): void {
    const widths = items.map((item) => this.width(item)),
      count = widths.reduce((a, b) => a + b, 0n);
    if (!count) return;
    const slot = extent.div(new R(count));
    if (!explicit)
      this.checkSlot(
        slot,
        {
          ...items[0].span,
          endLine: items.at(-1)!.span.endLine,
          endCol: items.at(-1)!.span.endCol,
        },
        count,
        path.length > 1 ? 'Subdivision' : 'Bar',
      );
    let offset = onset;
    items.forEach((item, i) => {
      const span = slot.mul(new R(widths[i]));
      this.item(item, offset, span, explicit, [...path, i], inherited);
      offset = offset.add(span);
    });
  }
  item(
    item: Item,
    onset: R,
    extent: R,
    explicit: boolean,
    path: number[],
    inherited: Options,
  ): void {
    const options = this.options(item.options, inherited);
    if (item.euclid) {
      const [k, n, r = '0'] = item.euclid;
      let pattern: boolean[];
      try {
        pattern = euclid(Number(k), Number(n), Number(r));
      } catch (error) {
        this.error(
          error instanceof ExpansionLimitError ? 'D001' : 'C005',
          error instanceof Error ? error.message : 'Invalid Euclid bounds',
          item.span,
          { k, n, rotation: r },
        );
        return;
      }
      const span = extent.div(new R(pattern.length));
      if (!explicit) this.checkSlot(span, item.span, pattern.length, 'Euclid');
      pattern.forEach((attack, i) => {
        if (attack)
          this.attacks(item, onset.add(span.mul(new R(i))), span, explicit, [...path, i], options);
      });
    } else this.attacks(item, onset, extent, explicit, path, options);
  }
  attacks(
    item: Item,
    onset: R,
    extent: R,
    explicit: boolean,
    path: number[],
    options: Options,
  ): void {
    const ratchets = this.integer(item.ratchet, 1, item.span, 'Ratchet');
    if (ratchets > 65536) {
      this.error('D001', 'Ratchet expansion exceeds 65536 attacks', item.span, {
        attacks: ratchets,
        limit: 65536,
      });
      return;
    }
    const span = extent.div(new R(ratchets));
    if (ratchets > 1 && !explicit) this.checkSlot(span, item.span, ratchets, 'Ratchet');
    for (let i = 0; i < ratchets; i++)
      this.atoms(item, onset.add(span.mul(new R(i))), span, explicit, path, options, i);
  }
  atoms(
    item: Item,
    onset: R,
    extent: R,
    explicit: boolean,
    path: number[],
    options: Options,
    ratchet: number,
  ): void {
    const first = item.atoms[0];
    if (first.kind === 'subdivision') {
      this.list(first.items, onset, extent, false, path, options);
      return;
    }
    if (first.kind === 'alternation' && 'items' in first) {
      const widths = first.items.map((branch) => this.width(branch));
      if (widths.some((w) => w !== widths[0])) return;
      const selected = ((this.context.cycle ?? 1) - 1) % first.items.length;
      first.items.forEach((branch, index) => {
        if (index === selected) return;
        const checker = new LiteralCompiler(
          { kind: 'name', name: 'branch', span: this.literal },
          this.context,
        );
        checker.previous = this.previous.map((event) => ({ ...event, holds: [...event.holds] }));
        checker.item(branch, onset, extent, explicit, [...path, index], options);
        this.diagnostics.push(...checker.diagnostics);
      });
      this.item(first.items[selected], onset, extent, explicit, [...path, selected], options);
      return;
    }
    if (first.kind === 'literal') {
      let duration: R;
      try {
        duration = sequenceDuration(first.duration!, this.context);
      } catch (error) {
        this.error(
          durationErrorCode(error),
          error instanceof Error ? error.message : 'Invalid tuplet duration',
          first.span,
        );
        return;
      }
      if (!duration.equals(extent)) {
        this.error('R003', 'Inline tuplet span differs from its enclosing slot', first.span, {
          extent: duration.toString(),
          required: extent.toString(),
        });
        return;
      }
      this.list(first.groups[0], onset, extent, true, path, options);
      return;
    }
    if (first.kind !== 'clause' || item.atoms.some((atom) => atom.kind !== 'clause')) {
      this.error('R003', 'A stack must contain pitch atoms', item.span);
      return;
    }
    const spellings = item.atoms.map((atom) => (atom as Clause).tokens.join(''));
    if (spellings[0] === '.') {
      if (this.context.type === 'values')
        this.error(
          'R003',
          'Values literals use typed rest spans for absence, not a dot',
          item.span,
        );
      return;
    }
    if (spellings[0] === '_') {
      const hold = {
        onset,
        span: extent,
        source: item.span,
        conditions: [...options.conditions],
        generator: options.generator,
        paths: options.paths,
        group: options.group,
        locks: { ...options.locks },
        fields: [...options.fields],
        velocity: options.velocity,
        gateSpec: options.gateSpec,
      };
      if (!this.previous.length) {
        if (this.context.allowLeadingHold) this.value.leadingHolds.push(hold);
        else
          this.error('T002', 'Hold has no preceding event in this literal or sequence', item.span);
      } else {
        for (const event of this.previous) {
          event.writtenSpan = onset.add(extent).sub(event.onset);
          event.gate = eventGate(event);
          event.holds.push(hold);
        }
      }
      return;
    }
    const event: LiteralEvent = {
      onset,
      writtenSpan: extent,
      gate: extent,
      pitches: [],
      offset: 0,
      velocity: options.velocity ?? 0.8,
      gateSpec: options.gateSpec,
      generator: options.generator,
      paths: options.paths,
      group: options.group,
      locks: { ...options.locks },
      conditions: [...options.conditions],
      fields: [...options.fields],
      holds: [],
      attackSpan: extent,
      operations: [],
      source: {
        span: item.span,
        literal: this.literal,
        literalText: this.literalText,
        slot: path,
        ratchet,
        cycle: this.context.cycle ?? 1,
        figureExtent: this.mode === 'bars' ? bar(this.context) : this.value.extent,
        originalAttackSpan: extent,
        originalFigureOnset: this.mode === 'bars' ? onset.mod(bar(this.context)) : onset,
      },
    };
    if (this.context.type === 'notes') event.pitches = spellings;
    else if (this.context.type === 'hits') {
      const match = spellings[0].match(/^([xXo])([+-]\d+)?$/);
      if (!match || spellings.length !== 1) {
        this.error('R003', 'Hits literals require x, X, o, rests or holds', item.span);
        return;
      }
      event.velocity = options.velocity ?? (match[1] === 'X' ? 1 : match[1] === 'o' ? 0.4 : 0.8);
      event.offset = Number(match[2] ?? 0);
    } else if (this.context.type === 'values') {
      if (spellings.length !== 1 || !/^[+-]?\d+(\.\d+)?$/.test(spellings[0])) {
        this.error('R003', 'Values literals require scalar numbers or holds', item.span);
        return;
      }
      event.value = Number(spellings[0]);
    } else {
      this.error('R003', 'Bar literals are not harmony literals', item.span);
      return;
    }
    event.gate = eventGate(event);
    this.value.events.push(event);
    this.previous = [event];
  }
  shape(expression: Extract<Expression, { kind: 'shape' }>, extent: R): void {
    if (this.context.type !== 'values') {
      this.error('R003', 'Shapes require values context', expression.span);
      return;
    }
    const range = expression.value;
    if (extent.equals(zero)) return;
    if (
      (expression.name !== 'hold' && range.kind !== 'range') ||
      (expression.name === 'hold' && range.kind === 'range')
    ) {
      this.error(
        'R003',
        expression.name === 'hold'
          ? 'hold requires one scalar value'
          : `${expression.name} requires an a..b range`,
        expression.span,
      );
      return;
    }
    if (expression.name === 'random' && !expression.every) {
      this.error('R003', 'A random shape requires an every step', expression.span);
      return;
    }
    const number = (expr: Expression | undefined): number => {
      if (expr?.kind !== 'number' || !Number.isFinite(Number(expr.text)))
        throw new RangeError('A shape endpoint must be a scalar number');
      return Number(expr.text);
    };
    try {
      const low = range.kind === 'range' ? number(range.from) : number(range),
        high = range.kind === 'range' ? number(range.to) : low;
      if (['exp', 'log'].includes(expression.name) && (low <= 0 || high <= 0))
        throw new RangeError('exp and log require positive endpoints');
      const every = expression.every ? sequenceDuration(expression.every, this.context) : undefined;
      if (every && every.compare(zero) <= 0)
        throw new RangeError('A random shape step must be positive');
      const shape: Shape = {
        name: expression.name,
        low,
        high,
        onset: zero,
        period: extent,
        every,
        span: expression.span,
      };
      this.value.shapes.push(shape);
    } catch (error) {
      this.error('R003', error instanceof Error ? error.message : 'Invalid shape', expression.span);
    }
  }
  compile(expression: Extract<Expression, { kind: 'literal' | 'shape' }>): void {
    if (expression.kind === 'shape') {
      this.value.extent = bar(this.context);
      this.shape(expression, this.value.extent);
      return;
    }
    this.value.smooth = expression.smooth ?? false;
    if (expression.mode === 'bars') {
      const length = bar(this.context);
      this.value.extent = length.mul(new R(expression.groups.length));
      expression.groups.forEach((items, i) =>
        this.list(items, length.mul(new R(i)), length, false, [i], {
          locks: {},
          conditions: [],
          fields: [],
        }),
      );
    } else {
      let duration: R;
      try {
        duration = sequenceDuration(expression.duration!, this.context);
      } catch (error) {
        this.error(
          durationErrorCode(error),
          error instanceof Error ? error.message : 'Invalid literal duration',
          expression.duration!.span,
        );
        return;
      }
      if (expression.shape) {
        this.value.extent = duration;
        if (expression.shape.kind === 'shape') this.shape(expression.shape, duration);
        return;
      }
      const items = expression.groups[0],
        slots = items.reduce((sum, item) => sum + this.width(item), 0n);
      this.value.extent = expression.mode === 'steps' ? duration.mul(new R(slots)) : duration;
      const explicit =
        expression.mode === 'across' || expression.duration!.elements.some(explicitTriplet);
      if (duration.equals(zero)) return;
      this.list(items, zero, this.value.extent, explicit, [], {
        locks: {},
        conditions: [],
        fields: [],
      });
    }
  }
}
export function compileLiteral(
  expression: Extract<Expression, { kind: 'literal' | 'shape' }>,
  context: LiteralContext,
): { value?: TimedValue; diagnostics: Diagnostic[] } {
  const compiler = new LiteralCompiler(expression, context);
  compiler.compile(expression);
  if (
    expression.kind === 'literal' &&
    expression.mode === 'bars' &&
    expression.groups.length === 1
  ) {
    for (const d of compiler.diagnostics)
      if (d.code === 'T001' && d.message.startsWith('Bar ')) {
        d.fixes = [
          {
            title: 'make the tuplet explicit',
            edits: [
              {
                span: {
                  ...expression.span,
                  endLine: expression.span.line,
                  endCol: expression.span.col + 1,
                },
                insert: 'across 1 bar:',
              },
              {
                span: {
                  line: expression.span.endLine,
                  col: expression.span.endCol - 1,
                  endLine: expression.span.endLine,
                  endCol: expression.span.endCol,
                },
                insert: '',
              },
            ],
          },
        ];
      }
  }
  const diagnostics = compiler.diagnostics.filter(
    (d, i, all) =>
      !all
        .slice(0, i)
        .some(
          (previous) =>
            previous.code === d.code &&
            previous.span.line === d.span.line &&
            previous.span.col === d.span.col &&
            (previous.message === d.message ||
              (d.code === 'T001' && previous.measured?.slotDuration === d.measured?.slotDuration)),
        ),
  );
  return {
    value: diagnostics.some((d) => d.severity === 'error') ? undefined : compiler.value,
    diagnostics,
  };
}
