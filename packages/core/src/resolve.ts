import { literalType } from './literals.ts';
import type {
  Argument,
  Clause,
  Condition,
  Expression,
  Field,
  File,
  Item,
  Override,
  Sequence,
  Statement,
} from './ast.ts';
import { diagnostic, type Diagnostic, type Span } from './diag.ts';
import { lex } from './lexer.ts';
import { parse } from './parser.ts';
import { PRELUDE_SOURCE } from './prelude.ts';
import { argumentText } from './source.ts';
export type ValueType =
  | 'notes'
  | 'hits'
  | 'values'
  | 'harmony'
  | 'timed'
  | 'number'
  | 'steps'
  | 'semitones'
  | 'span'
  | 'percent'
  | 'part'
  | 'condition'
  | 'fields'
  | 'unknown';
type Named = Extract<Statement, { kind: 'binding' | 'define' | 'curve' | 'when' }>;
export type Resolution = {
  ast: File;
  normalized: File;
  symbols: Map<string, Named>;
  parts: Map<string, Extract<Statement, { kind: 'part' }>>;
  eventDerived: Set<string>;
  diagnostics: Diagnostic[];
};
const timed = new Set<ValueType>(['notes', 'hits', 'values', 'harmony', 'timed']);
const scalar = new Set<ValueType>(['number', 'steps', 'semitones', 'percent']);
const bindingTypes: Record<string, ValueType> = {
  motif: 'notes',
  rhythm: 'hits',
  signal: 'values',
  progression: 'harmony',
};
const operationTypes: Record<string, ValueType[]> = {
  shift: ['notes', 'harmony'],
  transpose: ['notes'],
  octave: ['notes'],
  invert: ['notes', 'values'],
  reverse: [...timed],
  rotate: [...timed],
  fast: [...timed],
  slow: [...timed],
  fit: [...timed],
  loop: [...timed],
  repeat: [...timed],
  fragment: [...timed],
  thin: ['notes', 'hits'],
  peak: ['notes'],
  extend: ['notes'],
  mute: ['notes', 'hits'],
  recurse: ['notes'],
  vary: ['notes', 'hits'],
  seed: [...timed],
  where: ['notes', 'hits'],
  velocity: ['notes', 'hits'],
  accent: ['notes', 'hits'],
  length: ['notes', 'hits'],
  lengthen: ['notes', 'hits'],
  rhythm: ['notes'],
  on: ['notes'],
  modulate: ['notes'],
};
const prelude = parse(`mm 1\n${PRELUDE_SOURCE}`);
if (prelude.diagnostics.length) throw new Error('Internal bug: normative prelude does not parse');
function markPrelude(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if ('line' in value && 'col' in value) (value as Span).file = 'prelude';
  else Object.values(value).forEach(markPrelude);
}
markPrelude(prelude.ast);
export function resolve(ast: File): Resolution {
  const diagnostics: Diagnostic[] = [],
    symbols = new Map<string, Named>(),
    parts = new Map<string, Extract<Statement, { kind: 'part' }>>();
  const reported = new Map<string, Diagnostic>();
  function error(
    code: string,
    message: string,
    span: Span,
    path?: string,
    key?: string,
    fixes: Diagnostic['fixes'] = [],
  ): void {
    const identity = key ?? `${code}:${span.line}:${span.col}:${message}`;
    const previous = reported.get(identity);
    if (previous) {
      if (previous.span.line !== span.line || previous.span.col !== span.col)
        previous.causes.push(`also referenced at ${span.line}:${span.col}`);
      return;
    }
    const d = diagnostic(code, message, span, { path, fixes });
    reported.set(identity, d);
    diagnostics.push(d);
  }
  function collect(statement: Statement, builtin = false): void {
    if (!('name' in statement)) return;
    if (statement.kind === 'part') {
      if (parts.has(statement.name))
        error('R004', `Duplicate part ${statement.name}`, statement.span);
      else parts.set(statement.name, statement);
    } else if (['binding', 'define', 'when', 'curve'].includes(statement.kind)) {
      if (symbols.has(statement.name)) {
        const previous = symbols.get(statement.name)!;
        const label = statement.kind === 'binding' ? statement.keyword : statement.kind;
        error(
          'R004',
          previous.span.file === 'prelude'
            ? `${label} ${statement.name} conflicts with built-in prelude function ${statement.name}; rename it, for example ${statement.name}-section`
            : `Duplicate name ${statement.name}; already declared as ${previous.kind === 'binding' ? previous.keyword : previous.kind}`,
          statement.span,
        );
      } else symbols.set(statement.name, statement as Named);
    }
  }
  prelude.ast.statements.forEach((s) => collect(s, true));
  ast.statements.forEach((s) => collect(s));
  function unknown(name: string, span: Span, expected?: ValueType): void {
    const candidates =
      expected === 'part'
        ? [...parts.keys()]
        : [...symbols]
            .filter(
              ([, s]) =>
                !expected ||
                (s.kind === 'binding' &&
                  (!bindingTypes[s.keyword] || compatible(bindingTypes[s.keyword], expected))) ||
                s.kind === 'define' ||
                (s.kind === 'curve' && expected === 'values') ||
                (s.kind === 'when' && expected === 'condition'),
            )
            .map(([name]) => name);
    const suggestion = nearest(name, candidates);
    error(
      'R001',
      `Unknown ${expected ?? 'value'} ${name}${suggestion ? `; did you mean ${suggestion}?` : ''}`,
      span,
      undefined,
      `R001:${expected}:${name}`,
      suggestion ? [{ title: `use ${suggestion}`, edits: [{ span, insert: suggestion }] }] : [],
    );
  }
  function subClause(clause: Clause, env: Map<string, Argument>): Clause {
    const source = clause.tokens
      .map((token) => (env.has(token) ? `(${argumentText(env.get(token)!)})` : token))
      .join(' ');
    return {
      ...clause,
      tokens: lex(source)
        .tokens.filter((t) => !['EOF', 'NL'].includes(t.kind))
        .map((t) => t.text),
    };
  }
  function subCondition(c: Condition, env: Map<string, Argument>): Condition {
    if (c.kind === 'clause') return subClause(c, env);
    if (c.kind === 'not') return { ...c, value: subCondition(c.value, env) };
    return { ...c, left: subCondition(c.left, env), right: subCondition(c.right, env) };
  }
  function normSequence(
    seq: Sequence,
    env = new Map<string, Argument>(),
    stack: string[] = [],
  ): Sequence {
    return {
      ...seq,
      elements: seq.elements.map((e) => norm(e, env, stack)),
      rate: seq.rate ? norm(seq.rate, env, stack) : undefined,
    };
  }
  function normArgument(arg: Argument, env: Map<string, Argument>, stack: string[]): Argument {
    if (arg.kind === 'sequence') return normSequence(arg, env, stack);
    if (arg.kind === 'clause') return subClause(arg, env);
    return {
      ...arg,
      condition: subCondition(arg.condition, env),
      operations: arg.operations.map((o) => normSequence(o, env, stack)),
    };
  }
  function normItem(item: Item, env: Map<string, Argument>, stack: string[]): Item {
    return {
      ...item,
      options: item.options.map((o) => subClause(o, env)),
      atoms: item.atoms.map((a) =>
        a.kind === 'clause'
          ? a
          : a.kind === 'subdivision' || (a.kind === 'alternation' && 'items' in a)
            ? { ...a, items: a.items.map((i) => normItem(i, env, stack)) }
            : norm(a as Expression, env, stack),
      ),
    };
  }
  function functionEnv(
    fn: Extract<Named, { kind: 'define' }>,
    args: Argument[],
    env: Map<string, Argument>,
    stack: string[],
  ): Map<string, Argument> {
    if (args.length !== fn.params.length)
      error(
        'R003',
        `${fn.name} requires ${fn.params.length} arguments; got ${args.length}`,
        args[0]?.span ?? fn.span,
      );
    return new Map(
      fn.params.flatMap((p, i) =>
        args[i]
          ? [
              [
                p.name,
                p.type === 'part' || p.type === 'condition'
                  ? args[i].kind === 'clause'
                    ? subClause(args[i] as Clause, env)
                    : args[i]
                  : normArgument(args[i], env, stack),
              ] as [string, Argument],
            ]
          : [],
      ),
    );
  }
  function norm(e: Expression, env: Map<string, Argument>, stack: string[]): Expression {
    if (e.kind === 'name') {
      const argument = env.get(e.name);
      if (argument?.kind === 'sequence') return { kind: 'group', value: argument, span: e.span };
      const symbol = symbols.get(e.name);
      if (symbol?.kind === 'binding') {
        if (stack.includes(e.name)) {
          error(
            'R002',
            `Recursive definition: ${[...stack, e.name].join(' → ')}`,
            e.span,
            undefined,
            `R002:${[...stack, e.name].sort().join(',')}`,
          );
          return e;
        }
        return {
          kind: 'group',
          value: normSequence(symbol.value, new Map(), [...stack, e.name]),
          span: e.span,
          origin: { name: e.name, kind: symbol.keyword, span: symbol.span },
        };
      }
      return e;
    }
    if (e.kind === 'call' || e.kind === 'operation') {
      const fn = symbols.get(e.name);
      const args =
        e.kind === 'operation'
          ? [
              { kind: 'sequence' as const, elements: [e.receiver], span: e.receiver.span },
              ...e.args,
            ]
          : e.args;
      if (fn?.kind === 'define' && fn.value) {
        if (stack.includes(fn.name)) {
          error(
            'R002',
            `Recursive function: ${[...stack, fn.name].join(' → ')}`,
            e.span,
            undefined,
            `R002:${fn.name}`,
          );
          return e;
        }
        const parameters = functionEnv(fn, args, env, stack);
        return {
          kind: 'group',
          value: normSequence(fn.value, parameters, [...stack, fn.name]),
          span: e.span,
          callSites: [...(e.callSites ?? []), e.span],
        };
      }
      return {
        ...e,
        ...(e.kind === 'operation' ? { receiver: norm(e.receiver, env, stack) } : {}),
        args: e.args.map((a) => normArgument(a, env, stack)),
      };
    }
    if (e.kind === 'binary')
      return { ...e, left: norm(e.left, env, stack), right: norm(e.right, env, stack) };
    if (e.kind === 'group') return { ...e, value: normSequence(e.value, env, stack) };
    if (e.kind === 'label') return { ...e, value: norm(e.value, env, stack) };
    if (e.kind === 'span') return { ...e, value: norm(e.value, env, stack) };
    if (e.kind === 'range')
      return {
        ...e,
        from: e.from ? norm(e.from, env, stack) : undefined,
        to: e.to ? norm(e.to, env, stack) : undefined,
      };
    if (e.kind === 'alternation')
      return { ...e, branches: e.branches.map((b) => norm(b, env, stack)) };
    if (e.kind === 'literal')
      return {
        ...e,
        duration: e.duration ? normSequence(e.duration, env, stack) : undefined,
        groups: e.groups.map((g) => g.map((i) => normItem(i, env, stack))),
        shape: e.shape ? norm(e.shape, env, stack) : undefined,
      };
    if (e.kind === 'shape')
      return {
        ...e,
        value: norm(e.value, env, stack),
        every: e.every ? normSequence(e.every, env, stack) : undefined,
      };
    return e;
  }
  function normFields(
    fields: Field[],
    env = new Map<string, Argument>(),
    stack: string[] = [],
  ): Field[] {
    return fields.flatMap((field) => {
      if (field.name === 'use' && field.value.kind === 'sequence') {
        const call = field.value.elements[0],
          fn = call?.kind === 'call' ? symbols.get(call.name) : undefined;
        if (fn?.kind !== 'define' || !fn.fields) {
          if (call?.kind === 'call') unknown(call.name, call.span, 'fields');
          else error('R003', 'use requires a field-function call', field.span);
          return [];
        }
        if (stack.includes(fn.name)) {
          error('R002', `Recursive field function ${fn.name}`, field.span);
          return [];
        }
        return normFields(
          fn.fields,
          functionEnv(fn, call.kind === 'call' ? call.args : [], env, stack),
          [...stack, fn.name],
        ).map((f) => ({ ...f, span: field.span }));
      }
      if (field.name === 'plays' && field.value.kind === 'sequence') {
        // The adapter keyword is separate from a parenthesized material expression.
        const head = field.value.elements[0];
        let adapter: Expression | undefined = head;
        while (adapter?.kind === 'operation') adapter = adapter.receiver;
        if (
          adapter?.kind === 'call' &&
          ['notes', 'line', 'hits', 'roots', 'chords', 'arpeggio'].includes(adapter.name) &&
          adapter.args[0]?.kind === 'sequence'
        ) {
          const call = adapter;
          const replace = (e: Expression): Expression =>
            e === call
              ? { kind: 'group', value: call.args[0] as Sequence, span: e.span }
              : e.kind === 'operation'
                ? { ...e, receiver: replace(e.receiver) }
                : e;
          field = {
            ...field,
            value: {
              ...field.value,
              elements: [
                { kind: 'name', name: adapter.name, span: adapter.span },
                replace(head),
                ...field.value.elements.slice(1),
              ],
            },
          };
        }

        if (field.value.kind !== 'sequence') return [field];
        const root = (e: Expression): string | undefined =>
          e.kind === 'name' ? e.name : e.kind === 'operation' ? root(e.receiver) : undefined;
        const first = field.value.elements[0],
          kind = root(first);
        if (kind === 'melody')
          return [
            {
              ...field,
              playKind: kind,
              value: normSequence(
                field.value,
                new Map([
                  ...env,
                  [
                    'melody',
                    {
                      kind: 'sequence' as const,
                      elements: [
                        { kind: 'name' as const, name: '__form_melody', span: first.span },
                      ],
                      span: first.span,
                    },
                  ],
                ]),
                stack,
              ),
            },
          ];
        return [
          {
            ...field,
            playKind: kind,
            value: {
              ...field.value,
              elements: [first, ...field.value.elements.slice(1).map((e) => norm(e, env, stack))],
            },
          },
        ];
      }
      return [
        {
          ...field,
          value:
            field.value.kind === 'sequence'
              ? normSequence(field.value, env, stack)
              : subCondition(field.value, env),
        },
      ];
    });
  }
  const normalized: File = {
    ...ast,
    statements: ast.statements.map((s) => {
      if (s.kind === 'binding' || s.kind === 'form' || s.kind === 'harmony')
        return { ...s, value: normSequence(s.value) };
      if (s.kind === 'part')
        return {
          ...s,
          fields: s.fields.flatMap<Field | Override>((f) =>
            f.kind === 'field' ? normFields([f]) : [{ ...f, fields: normFields(f.fields) }],
          ),
        };
      return s;
    }),
  };
  // Fixed point over normalized definitions includes condition aliases and transitive trigger uses.
  const eventDerived = new Set<string>();
  function derived(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(derived);
    if (!value || typeof value !== 'object')
      return typeof value === 'string' && (value === 'trigger' || eventDerived.has(value));
    // Constant parameter locks do not reference event signals. A dotted field
    // such as lfo.trigger contains the word trigger, but is not trigger(...).
    if (
      'kind' in value &&
      value.kind === 'clause' &&
      'tokens' in value &&
      Array.isArray(value.tokens)
    ) {
      const tokens = value.tokens as string[];
      if (
        tokens.length > 1 &&
        /^[+-]?\d+(?:\.\d+)?%?$/.test(tokens.at(-1)!) &&
        /^[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)*$/.test(tokens.slice(0, -1).join(''))
      )
        return false;
    }
    return (
      Object.entries(value).some(
        ([key, child]) =>
          !['span', 'origin', 'callSites', 'name', 'keyword'].includes(key) && derived(child),
      ) ||
      ('kind' in value &&
        ['name', 'call'].includes(String(value.kind)) &&
        'name' in value &&
        (value.name === 'trigger' || eventDerived.has(String(value.name))))
    );
  }
  const normalizedDefinitions = new Map(
    [...symbols].map(([name, s]) => [
      name,
      s.kind === 'binding' ? normSequence(s.value, new Map(), [name]) : s,
    ]),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, value] of normalizedDefinitions)
      if (!eventDerived.has(name) && derived(value)) {
        eventDerived.add(name);
        changed = true;
      }
  }
  function stage2(value: unknown, span: Span, path: string): boolean {
    if (!derived(value)) return false;
    error(
      'C007',
      'Event-derived signal containing trigger is not allowed in a stage-2 position',
      span,
      path,
    );
    return true;
  }
  const inferring = new Set<string>();
  let formContext = false;
  function inferSequence(
    seq: Sequence,
    env: Map<string, ValueType>,
    expected?: ValueType,
  ): ValueType {
    let type = expected;
    for (const e of seq.elements) {
      const current = infer(e, env, type);
      if (!type || type === 'unknown') type = current;
      else if (!compatible(current, type))
        error('R003', `Sequence requires ${type}; found ${current}`, e.span);
    }
    if (seq.rate) {
      infer(seq.rate, env, 'span');
      if (type !== 'harmony') error('R003', 'A progression rate requires harmony', seq.rate.span);
    }
    return type ?? 'unknown';
  }
  function argumentType(
    arg: Argument,
    env: Map<string, ValueType>,
    expected?: ValueType,
  ): ValueType {
    if (arg.kind === 'sequence') return inferSequence(arg, env, expected);
    return arg.kind === 'clause' && expected === 'span' ? 'span' : 'condition';
  }
  function infer(e: Expression, env: Map<string, ValueType>, expected?: ValueType): ValueType {
    if (e.kind === 'number')
      return e.text.endsWith('%')
        ? 'percent'
        : e.text.includes('/') && !expected?.match(/^(number|steps|semitones|percent|values)$/)
          ? 'span'
          : 'number';
    if (e.kind === 'name') {
      if (env.has(e.name)) return env.get(e.name)!;
      if (expected === 'part') {
        if (!parts.has(e.name)) unknown(e.name, e.span, expected);
        return 'part';
      }
      if (['section', 'phrase'].includes(e.name) && expected === 'span') return 'span';
      if (e.name === 'velocity' || e.name === 'energy') return 'values';
      if (['rhythm', 'pitch', 'unscaled', 'sum'].includes(e.name)) return 'unknown';
      if (
        (expected === 'harmony' && /^[b#]?[IViv]+(?:[a-z0-9ø+]*)(?:\/[IViv0-9]+)?$/.test(e.name)) ||
        e.name === 'N'
      )
        return 'harmony';
      const symbol = symbols.get(e.name);
      if (!symbol) {
        unknown(e.name, e.span, expected);
        return 'unknown';
      }
      if (symbol.kind === 'curve') return 'values';
      if (symbol.kind === 'when') return 'condition';
      if (symbol.kind === 'define') {
        error('R003', `Function ${e.name} requires a call`, e.span);
        return 'unknown';
      }
      if (bindingTypes[symbol.keyword]) {
        if (
          expected === 'number' &&
          symbol.keyword === 'signal' &&
          JSON.stringify(normalizedDefinitions.get(e.name)).includes('"__per"')
        )
          return 'number';
        return bindingTypes[symbol.keyword];
      }
      if (inferring.has(e.name)) return 'unknown';
      inferring.add(e.name);
      const type = inferSequence(symbol.value, env);
      inferring.delete(e.name);
      return type;
    }
    if (e.kind === 'span') {
      infer(e.value, env, 'number');
      return ['step', 'steps'].includes(e.unit) ? 'steps' : 'span';
    }
    if (e.kind === 'shape') {
      infer(e.value, env, 'number');
      if (e.every) inferSequence(e.every, env, 'span');
      return 'values';
    }
    if (e.kind === 'range') {
      if (e.from) infer(e.from, env, expected);
      if (e.to) infer(e.to, env, expected);
      return expected ?? 'number';
    }
    if (e.kind === 'literal') {
      if (e.duration) inferSequence(e.duration, env, 'span');
      if (e.shape) return 'values';
      const type = literalType(e);
      return expected === 'values'
        ? 'values'
        : type === 'notes' && expected && timed.has(expected)
          ? expected
          : type;
    }
    if (e.kind === 'group') return inferSequence(e.value, env, expected);
    if (e.kind === 'label') return infer(e.value, env, expected);
    if (e.kind === 'alternation') {
      const types = e.branches.map((b) => infer(b, env, expected));
      return types[0] ?? 'unknown';
    }
    if (e.kind === 'binary') {
      const a = infer(e.left, env),
        b = infer(e.right, env);
      if (a === 'span' || b === 'span') {
        if (
          (['+', '-'].includes(e.operator) && a !== b) ||
          (e.operator === '*' && a === 'span' && b === 'span') ||
          e.operator === '^'
        )
          error('R003', 'Invalid dimensions in span arithmetic', e.span);
        return 'span';
      }
      if (a === 'values' || b === 'values') return 'values';
      if ((!scalar.has(a) && a !== 'unknown') || (!scalar.has(b) && b !== 'unknown'))
        error('R003', 'Arithmetic requires numbers or signals', e.span);
      return 'number';
    }
    const fn = symbols.get(e.name),
      args =
        e.kind === 'operation'
          ? [
              { kind: 'sequence' as const, elements: [e.receiver], span: e.receiver.span },
              ...e.args,
            ]
          : e.args;
    if (fn?.kind === 'define') {
      if (inferring.has(fn.name)) return 'unknown';
      if (args.length !== fn.params.length)
        error(
          'R003',
          `${fn.name} requires ${fn.params.length} arguments; got ${args.length}`,
          e.span,
        );
      const local = new Map<string, ValueType>();
      fn.params.forEach((p, i) => {
        const required = p.type as ValueType;
        const actual = args[i]
          ? argumentType(args[i], env, required === 'timed' ? expected : required)
          : 'unknown';
        if (!compatible(actual, required))
          error(
            'R003',
            `${fn.name} parameter ${p.name} requires ${required}; found ${actual}`,
            args[i]?.span ?? e.span,
          );
        local.set(p.name, actual);
      });
      inferring.add(fn.name);
      const result = fn.value ? inferSequence(fn.value, local, expected) : 'fields';
      inferring.delete(fn.name);
      return result;
    }
    if (e.kind === 'call') {
      if (e.name === '__per') {
        if (e.args[0]) argumentType(e.args[0], env, 'span');
        e.args.slice(2).forEach((a) => {
          const type = argumentType(a, env);
          if (!scalar.has(type) && type !== 'span' && type !== 'unknown')
            error('R003', 'Per values require constant scalars', a.span);
        });
        return expected === 'number' ? 'number' : 'values';
      }
      if (e.name === 'rest') {
        if (e.args[0]) argumentType(e.args[0], env, 'span');
        return expected && timed.has(expected) ? expected : 'timed';
      }
      if (e.name === 'extent') {
        if (e.args[0]) argumentType(e.args[0], env);
        return 'span';
      }
      if (e.name === 'trigger') {
        if (e.args[0]) argumentType(e.args[0], env, 'part');
        return 'values';
      }
      if (e.name === 'together') {
        const types = e.args.map((a) => argumentType(a, env, expected));
        const t = types.find((t) => t !== 'timed') ?? expected ?? 'timed';
        if (
          types.some((a) => !compatible(a, t)) ||
          !['notes', 'hits', 'timed', 'unknown'].includes(t)
        )
          error('R003', 'together requires notes or hits of one type', e.span);
        return t;
      }
      if (['min', 'max', 'clamp', 'pick', 'cycle', 'pow'].includes(e.name)) {
        if (e.name === 'pow' && e.args.length !== 2)
          error('R003', 'pow requires two arguments', e.span);
        e.args.forEach((a, i) =>
          argumentType(a, env, e.name === 'pick' && i === 0 ? 'condition' : 'values'),
        );
        return e.name === 'pow' && e.args.every((a) => argumentType(a, env) === 'number')
          ? 'number'
          : 'values';
      }
      unknown(e.name, e.span);
      return 'unknown';
    }
    if (e.name === 'modulate' && !formContext)
      error('R015', 'modulate is only valid on a section reference in form', e.span);
    const receiver = infer(e.receiver, env, e.name === 'rhythm' ? 'notes' : expected);
    const allowed = operationTypes[e.name];
    if (!allowed) {
      unknown(e.name, e.span);
      return 'unknown';
    }
    if (
      receiver !== 'unknown' &&
      !allowed.includes(receiver) &&
      !(receiver === 'timed' && allowed.includes('timed'))
    )
      error('R010', `${e.name} is not valid on ${receiver}`, e.span);
    const argType = ['fit', 'loop', 'extend', 'lengthen', 'rotate'].includes(e.name)
      ? 'span'
      : e.name === 'on'
        ? 'hits'
        : ['velocity', 'accent'].includes(e.name)
          ? 'values'
          : ['shift'].includes(e.name)
            ? 'steps'
            : 'number';
    e.args.forEach((arg) => {
      if (arg.kind === 'sequence') {
        const actual = argumentType(arg, env, argType);
        if (
          !compatible(actual, argType) &&
          !(e.name === 'rotate' && actual === 'steps') &&
          !(e.name === 'length' && ['span', 'percent'].includes(actual))
        )
          error('R003', `${e.name} requires ${argType}; found ${actual}`, arg.span);
      }
    });
    return e.name === 'rhythm' ? 'hits' : receiver;
  }
  function checkField(f: Field, env: Map<string, ValueType>, path: string): void {
    if (f.name === 'play') {
      stage2(f.value, f.value.span, path);
      return;
    }
    if (f.value.kind !== 'sequence') return;
    if (f.name === 'plays') {
      stage2(f.value, f.value.span, path);
      if (f.playKind === 'melody') {
        inferSequence(f.value, new Map([...env, ['__form_melody', 'notes']]), 'notes');
        return;
      }
      const [head, ...elements] = f.value.elements;
      if (head?.kind === 'operation') {
        infer(head, new Map([...env, ['melody', 'notes']]), 'notes');
        return;
      }
      if (head?.kind === 'name' && elements.length)
        inferSequence(
          { ...f.value, elements },
          env,
          ['hits', 'roots', 'chords', 'arpeggio'].includes(head.name) ? 'hits' : 'notes',
        );
    } else if (f.name === 'use') inferSequence(f.value, env, 'fields');
    else inferSequence(f.value, new Map([...env, ['velocity', 'values']]), 'values');
  }
  for (const s of [...prelude.ast.statements, ...ast.statements]) {
    if (s.kind === 'binding') {
      const value = normalizedDefinitions.get(s.name);
      const material = s.keyword !== 'signal';
      if (!material || !stage2(value, s.value.span, `${s.keyword} ${s.name}`))
        inferSequence(s.value, new Map(), bindingTypes[s.keyword]);
    } else if (s.kind === 'define') {
      const env = new Map(s.params.map((p) => [p.name, p.type as ValueType]));
      if (s.value) inferSequence(s.value, env);
      else
        s.fields?.forEach((f) => {
          if (f.name === 'use') error('S001', 'Field function bodies cannot contain use', f.span);
          checkField(f, env, `define ${s.name}`);
        });
    } else if (s.kind === 'harmony') inferSequence(s.value, new Map(), 'harmony');
    else if (s.kind === 'form') {
      formContext = true;
      inferSequence(s.value, new Map(), 'notes');
      formContext = false;
    }
  }
  for (const s of normalized.statements)
    if (s.kind === 'part')
      for (const f of s.fields) {
        if (f.kind === 'field') checkField(f, new Map(), `part ${s.name}`);
        else {
          stage2(f.condition, f.condition.span, `part ${s.name}/when`);
          f.fields.forEach((field) => checkField(field, new Map(), `part ${s.name}/when`));
        }
      }
  return { ast, normalized, symbols, parts, eventDerived, diagnostics };
}
function compatible(actual: ValueType, expected: ValueType): boolean {
  return (
    actual === expected ||
    actual === 'unknown' ||
    expected === 'unknown' ||
    (actual === 'timed' && timed.has(expected)) ||
    (expected === 'timed' && timed.has(actual)) ||
    (actual === 'number' && (scalar.has(expected) || expected === 'values')) ||
    (actual === 'percent' && ['number', 'values'].includes(expected))
  );
}
function nearest(name: string, candidates: string[]): string | undefined {
  const distance = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (const ch of a) {
      const next = [row[0] + 1];
      for (let j = 0; j < b.length; j++)
        next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (ch === b[j] ? 0 : 1)));
      row = next;
    }
    return row[b.length];
  };
  const first = candidates.sort(
    (a, b) => distance(name, a) - distance(name, b) || (a < b ? -1 : 1),
  )[0];
  return first && distance(name, first) <= 2 ? first : undefined;
}
