import { SCORE_FORMAT_VERSION } from './ast.ts';
import { lex, reserved, type Token } from './lexer.ts';
import { combineSpan, diagnostic, type Diagnostic, type Span } from './diag.ts';
import { expandTemplates, restoreTemplateOrigins, type TemplateExpansion } from './templates.ts';
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
const bindings = new Set(['motif', 'rhythm', 'signal', 'progression', 'phrase', 'section']);
const units = new Set(['bar', 'bars', 'beat', 'beats', 'pulse', 'pulses', 'step', 'steps', 'ms']);
const shapes = new Set([
  'ramp',
  'sine',
  'triangle',
  'saw',
  'square',
  'random',
  'hold',
  'exp',
  'log',
]);
const settings = new Set([
  'literal',
  'tempo',
  'meter',
  'key',
  'seed',
  'humanize',
  'dynamics',
  'sound',
]);
const fields = new Set([
  'group',
  'role',
  'lane',
  'range',
  'octave',
  'length',
  'voices',
  'order',
  'restart',
  'play',
  'swing',
  'humanize',
  'dynamics',
  'sound',
  'plays',
  'use',
]);
class ParseFailure extends Error {}
class Parser {
  readonly tokens: Token[];
  readonly diagnostics: Diagnostic[];
  readonly source: string;
  position = 0;
  path: string | undefined;
  constructor(source: string) {
    this.source = source;
    const result = lex(source);
    this.tokens = result.tokens;
    this.diagnostics = result.diagnostics;
  }
  get token(): Token {
    return this.tokens[this.position];
  }
  is(text: string): boolean {
    return this.token.text === text || this.token.kind === text;
  }
  take(): Token {
    const token = this.token;
    if (token.kind !== 'EOF') this.position++;
    return token;
  }
  match(text: string): boolean {
    if (!this.is(text)) return false;
    this.take();
    return true;
  }
  error(
    code: string,
    message: string,
    span = this.token.span,
    details: Partial<Diagnostic> = {},
  ): void {
    this.diagnostics.push(diagnostic(code, message, span, { path: this.path, ...details }));
  }
  fail(message: string): never {
    this.error('S001', message);
    throw new ParseFailure(message);
  }
  require(text: string): Token {
    if (!this.is(text)) this.fail(`Expected ${text}; found ${this.token.text || this.token.kind}`);
    return this.take();
  }
  name(): Token {
    if (this.token.kind !== 'word') this.fail('Expected an identifier');
    const token = this.take();
    if (reserved.has(token.text))
      this.error(
        'S040',
        `Reserved word ${token.text} cannot be a name; use ${token.text}-1`,
        token.span,
        {
          fixes: [
            {
              title: `rename to ${token.text}-1`,
              edits: [{ span: token.span, insert: `${token.text}-1` }],
            },
          ],
        },
      );
    return token;
  }
  endLine(): void {
    if (!this.match('NL') && !this.is('EOF')) this.fail('Expected end of statement');
  }
  recover(): void {
    while (!['NL', 'DEDENT', 'EOF'].includes(this.token.kind)) this.take();
    this.match('NL');
    // Discard the failed statement's block without treating its fields as top-level statements.
    if (this.match('INDENT')) {
      let depth = 1;
      while (depth && !this.is('EOF')) {
        if (this.match('INDENT')) depth++;
        else if (this.match('DEDENT')) depth--;
        else this.take();
      }
    }
  }
  file(): File {
    const start = this.token.span;
    try {
      this.require('mm');
      this.require(SCORE_FORMAT_VERSION);
      this.endLine();
    } catch (error) {
      if (!(error instanceof ParseFailure)) throw error;
      this.recover();
    }
    const statements: Statement[] = [];
    while (!this.is('EOF')) {
      if (this.match('NL')) continue;
      if (this.is('DEDENT') || this.is('INDENT')) {
        this.error('S001', 'Unexpected indentation at top level');
        this.take();
        continue;
      }
      try {
        statements.push(this.statement());
      } catch (error) {
        if (!(error instanceof ParseFailure)) throw error;
        this.recover();
      }
    }
    return {
      kind: 'file',
      version: SCORE_FORMAT_VERSION,
      statements,
      span: combineSpan(start, this.token.span),
    };
  }
  statement(): Statement {
    const start = this.take();
    this.path = undefined;
    if (bindings.has(start.text)) {
      const name = this.name();
      this.path = `${start.text} ${name.text}`;
      this.require('=');
      const value = this.sequence();
      this.endLine();
      return {
        kind: 'binding',
        keyword: start.text,
        name: name.text,
        value,
        span: combineSpan(start.span, value.span),
      };
    }
    if (start.text === 'song') {
      const title = this.require('string');
      this.endLine();
      const body = this.block(true, false) as Field[];
      return {
        kind: 'song',
        title: title.text.slice(1, -1),
        fields: body,
        span: combineSpan(start.span, body.at(-1)?.span ?? title.span),
      };
    }
    if (start.text === 'part') {
      const name = this.name();
      this.path = `part ${name.text}`;
      this.endLine();
      const body = this.block(false, true);
      return {
        kind: 'part',
        name: name.text,
        fields: body,
        span: combineSpan(start.span, body.at(-1)?.span ?? name.span),
      };
    }
    if (start.text === 'define') {
      const name = this.name();
      this.path = `define ${name.text}`;
      this.require('(');
      const params: { name: string; type: string; span: Span }[] = [];
      if (!this.is(')'))
        do {
          const param = this.name();
          this.require(':');
          const type = this.require('word');
          params.push({
            name: param.text,
            type: type.text,
            span: combineSpan(param.span, type.span),
          });
        } while (this.match(','));
      this.require(')');
      if (this.match('=')) {
        const value = this.sequence();
        this.endLine();
        return {
          kind: 'define',
          name: name.text,
          params,
          value,
          span: combineSpan(start.span, value.span),
        };
      }
      this.require(':');
      this.endLine();
      const body = this.block(false, false) as Field[];
      return {
        kind: 'define',
        name: name.text,
        params,
        fields: body,
        span: combineSpan(start.span, body.at(-1)?.span ?? name.span),
      };
    }
    if (start.text === 'form' || start.text === 'harmony') {
      const targets: string[] = [];
      if (start.text === 'harmony' && this.match('in'))
        do {
          targets.push(this.name().text);
        } while (this.match(','));
      this.require('=');
      const value = this.sequence();
      this.endLine();
      return start.text === 'form'
        ? { kind: 'form', value, span: combineSpan(start.span, value.span) }
        : { kind: 'harmony', targets, value, span: combineSpan(start.span, value.span) };
    }
    if (start.text === 'when') {
      const name = this.name();
      this.require('=');
      const condition = this.condition(new Set(['NL']));
      this.endLine();
      return {
        kind: 'when',
        name: name.text,
        condition,
        span: combineSpan(start.span, condition.span),
      };
    }
    if (start.text === 'curve') {
      const name = this.name();
      this.require('=');
      const entries: Clause[] = [];
      do {
        entries.push(this.clause(new Set([',', 'NL'])));
      } while (this.match(','));
      this.endLine();
      return {
        kind: 'curve',
        name: name.text,
        entries,
        span: combineSpan(start.span, entries.at(-1)!.span),
      };
    }
    if (start.text === 'silence' || start.text === 'expect') {
      const value = this.clause(new Set(['NL']));
      this.endLine();
      return { kind: start.text, value, span: combineSpan(start.span, value.span) };
    }
    const suggestion = nearest(start.text, [
      ...bindings,
      'song',
      'part',
      'define',
      'form',
      'harmony',
      'when',
      'curve',
      'silence',
      'expect',
    ]);
    this.error(
      'S001',
      `Unknown statement ${start.text}${suggestion ? `; did you mean ${suggestion}?` : ''}`,
      start.span,
      {
        fixes: suggestion
          ? [{ title: `use ${suggestion}`, edits: [{ span: start.span, insert: suggestion }] }]
          : [],
      },
    );
    throw new ParseFailure();
  }
  block(song: boolean, overrides: boolean): (Field | Override)[] {
    this.require('INDENT');
    const body: (Field | Override)[] = [];
    while (!this.is('DEDENT') && !this.is('EOF')) {
      if (this.match('NL')) continue;
      try {
        if (this.is('when') && overrides) {
          const start = this.take();
          const condition = this.condition(new Set([':']));
          this.require(':');
          this.endLine();
          const nested = this.block(false, false) as Field[];
          body.push({
            kind: 'override',
            condition,
            fields: nested,
            span: combineSpan(start.span, nested.at(-1)?.span ?? condition.span),
          });
        } else body.push(this.field(song));
      } catch (error) {
        if (!(error instanceof ParseFailure)) throw error;
        this.recover();
      }
    }
    this.require('DEDENT');
    return body;
  }
  field(song: boolean): Field {
    const start = this.require('word');
    let name = start.text;
    while (this.match('.')) name += `.${this.require('word').text}`;
    let value: Sequence | Clause | Condition;
    if (this.match('=')) value = this.sequence(new Set(['NL']), true);
    else if (song) {
      if (!settings.has(name)) this.fail(`Unknown song setting ${name}`);
      value = this.clause(new Set(['NL']));
    } else if (name === 'plays') value = this.sequence();
    else if (name === 'use') value = this.sequence();
    else if (name === 'play') {
      this.require('when');
      value = this.condition(new Set(['NL']));
    } else {
      if (!fields.has(name))
        this.fail(
          name === 'sync'
            ? `Parameter sync requires =; use sync = ${this.token.text}`
            : `Unknown field ${name}; parameter expressions require =`,
        );
      value = this.clause(new Set(['NL']));
      if (
        name === 'length' &&
        value.tokens.length === 1 &&
        /^[+-]?\d+(\.\d+)?$/.test(value.tokens[0])
      ) {
        const text = value.tokens[0];
        this.error('R003', `length ${text} needs a span or percent`, value.span, {
          measured: { value: text, required: ['span', 'percent'] },
          fixes: [
            {
              title: 'use a percentage of the written span',
              edits: [{ span: value.span, insert: `${Number(text) * 100}%` }],
            },
            { title: 'use a sixteenth-note gate', edits: [{ span: value.span, insert: '1/16' }] },
          ],
        });
      }
    }
    this.endLine();
    return { kind: 'field', name, value, span: combineSpan(start.span, value.span) };
  }
  stopped(stops: Set<string>): boolean {
    return (
      stops.has(this.token.text) ||
      stops.has(this.token.kind) ||
      ['EOF', 'DEDENT', 'NL'].includes(this.token.kind)
    );
  }
  sequence(stops = new Set(['NL']), expressionOnly = false): Sequence {
    const start = this.token.span,
      elements: Expression[] = [];
    let rate: Expression | undefined;
    while (!this.stopped(stops)) {
      if (elements.length && this.match('every')) {
        rate = this.expression(0, stops);
        break;
      }
      if (elements.length && this.match('twice')) {
        this.require('per');
        const unit = this.require('bar');
        rate = {
          kind: 'span',
          value: { kind: 'number', text: '1/2', span: unit.span },
          unit: 'bar',
          span: unit.span,
        };
        break;
      }
      if (expressionOnly && elements.length) {
        if (/^[+-]\d/.test(this.token.text)) this.spacing(this.token);
        else this.error('S001', 'Expected one expression in parameter assignment');
      }
      let element = this.expression(0, stops);
      if (this.match('as')) {
        const name = this.name();
        element = {
          kind: 'label',
          name: name.text,
          value: element,
          span: combineSpan(element.span, name.span),
        };
      }
      elements.push(element);
    }
    if (!elements.length) this.fail('Expected a value');
    return {
      kind: 'sequence',
      elements,
      rate,
      span: combineSpan(start, rate?.span ?? elements.at(-1)!.span),
    };
  }
  spacing(token: Token): void {
    this.error(
      'S030',
      'Binary operators need spaces on both sides; signed numbers are separate sequence elements',
      token.span,
      {
        fixes: [
          {
            title: 'read as a binary operator',
            edits: [
              {
                span: token.span,
                insert: /^[+-]\d/.test(token.text)
                  ? `${token.text[0]} ${token.text.slice(1)}`
                  : ` ${token.text} `,
              },
            ],
          },
          {
            title: 'read as a signed sequence element',
            edits: [{ span: token.span, insert: `(${token.text})` }],
          },
        ],
      },
    );
  }
  expression(minimum = 0, stops = new Set(['NL'])): Expression {
    let left = this.primary(stops);
    while (!this.stopped(stops)) {
      if (this.is('.') && this.tokens[this.position + 1]?.kind === 'word') {
        this.take();
        const operation = this.take();
        const args = this.match('(') ? this.arguments(operation.text) : [];
        left = {
          kind: 'operation',
          receiver: left,
          name: operation.text,
          args,
          span: combineSpan(left.span, this.tokens[this.position - 1].span),
        };
        continue;
      }
      if (this.is('..')) {
        this.take();
        const to = this.stopped(stops) ? undefined : this.primary(stops);
        left = {
          kind: 'range',
          from: left,
          to,
          span: combineSpan(left.span, to?.span ?? this.tokens[this.position - 1].span),
        };
        continue;
      }
      const op = this.token,
        precedence =
          op.text === '+' || op.text === '-'
            ? 1
            : op.text === '*' || op.text === '/'
              ? 2
              : op.text === '^'
                ? 3
                : 0;
      if (!precedence || precedence < minimum) break;
      this.take();
      if (!op.spaceBefore || !op.spaceAfter) this.spacing(op);
      const right = this.expression(precedence + (op.text === '^' ? 0 : 1), stops);
      left = {
        kind: 'binary',
        operator: op.text,
        left,
        right,
        span: combineSpan(left.span, right.span),
      };
    }
    return left;
  }
  primary(stops: Set<string>): Expression {
    const token = this.token;
    if (this.match('per')) {
      let duration: Sequence;
      if (['bar', 'bars', 'beat', 'beats'].includes(this.token.text)) {
        const unit = this.take();
        const one: Expression = { kind: 'number', text: '1', span: unit.span };
        duration = {
          kind: 'sequence',
          elements: [{ kind: 'span', value: one, unit: unit.text, span: unit.span }],
          span: unit.span,
        };
      } else duration = this.sequence(new Set(['smooth', ':']));
      const smooth = this.match('smooth');
      this.require(':');
      const args: Argument[] = [
        duration,
        {
          kind: 'sequence',
          elements: [{ kind: 'number', text: smooth ? '1' : '0', span: token.span }],
          span: token.span,
        },
      ];
      do {
        args.push(this.sequence(new Set([...stops, ',', ')', 'NL'])));
      } while (this.match(','));
      return {
        kind: 'call',
        name: '__per',
        args,
        span: combineSpan(token.span, this.tokens[this.position - 1].span),
      };
    }
    if (this.match('(')) {
      const value = this.sequence(new Set([')']));
      const close = this.require(')');
      return { kind: 'group', value, span: combineSpan(token.span, close.span) };
    }
    if (this.match('<')) {
      const branches = this.sequence(new Set(['>']));
      const close = this.require('>');
      return {
        kind: 'alternation',
        branches: branches.elements,
        span: combineSpan(token.span, close.span),
      };
    }
    if (this.is('|')) return this.literal('bars');
    if (this.is('steps') || this.is('across'))
      return this.literal(this.token.text as 'steps' | 'across');
    if (shapes.has(token.text)) {
      this.take();
      const value = this.expression(3, new Set([...stops, 'every']));
      const every = this.match('every') ? this.sequence(stops) : undefined;
      return {
        kind: 'shape',
        name: token.text,
        value,
        every,
        span: combineSpan(token.span, every?.span ?? value.span),
      };
    }
    if (this.match('..')) {
      const to = this.stopped(stops) ? undefined : this.primary(stops);
      return { kind: 'range', to, span: combineSpan(token.span, to?.span ?? token.span) };
    }
    if (token.kind === 'number') {
      this.take();
      let value: Expression = { kind: 'number', text: token.text, span: token.span };
      if (units.has(this.token.text)) {
        const unit = this.take();
        value = { kind: 'span', value, unit: unit.text, span: combineSpan(token.span, unit.span) };
      }
      return value;
    }
    if (token.kind === 'word') {
      this.take();
      let name = token.text;
      // Chord alterations, extensions and inversions are lexical spellings, not arithmetic.
      while (
        !this.token.spaceBefore &&
        (['#', 'ø', '/', '^'].includes(this.token.text) ||
          (this.token.text === '+' && /^[b#]?[IViv]+(?:\d+)?$/.test(name)))
      ) {
        name += this.take().text;
        if (!this.token.spaceBefore && ['word', 'number'].includes(this.token.kind))
          name += this.take().text;
      }
      if (this.match('(')) {
        const args = this.arguments(name);
        return {
          kind: 'call',
          name,
          args,
          span: combineSpan(token.span, this.tokens[this.position - 1].span),
        };
      }
      return {
        kind: 'name',
        name,
        span: combineSpan(token.span, this.tokens[this.position - 1].span),
      };
    }
    this.fail(`Expected expression; found ${token.text || token.kind}`);
  }
  arguments(name: string): Argument[] {
    if (this.match(')')) return [];
    if (name === 'where') {
      const condition = this.condition(new Set([':']));
      this.require(':');
      const operations: Sequence[] = [];
      do {
        operations.push(this.sequence(new Set([',', ')'])));
      } while (this.match(','));
      const close = this.require(')');
      return [
        { kind: 'where', condition, operations, span: combineSpan(condition.span, close.span) },
      ];
    }
    const args: Argument[] = [];
    do {
      if (
        [
          'attack',
          'decay',
          'env',
          'in',
          'first',
          'last',
          'every',
          'not',
          'bar',
          'on',
          'off',
          'highest',
          'lowest',
        ].includes(this.token.text)
      ) {
        args.push(this.clause(new Set([',', ')'])));
      } else args.push(this.sequence(new Set([',', ')'])));
    } while (this.match(','));
    this.require(')');
    return args;
  }
  literal(mode: 'bars' | 'steps' | 'across'): Expression {
    const start = this.take();
    let duration: Sequence | undefined,
      smooth = false;
    const groups: Item[][] = [];
    let shape: Expression | undefined;
    if (mode !== 'bars') {
      duration = this.sequence(new Set([':', 'smooth']));
      smooth = this.match('smooth');
      this.require(':');
      if (shapes.has(this.token.text)) shape = this.primary(new Set(['NL', ',', ')']));
      else groups.push(this.items(new Set(['NL', ',', ')'])));
    } else {
      do {
        groups.push(this.items(new Set(['|'])));
        this.require('|');
      } while (this.itemStart());
    }
    const end = this.tokens[this.position - 1];
    const span = combineSpan(start.span, end.span);
    const spacingError = this.diagnostics.at(-1);
    if (mode !== 'bars' && spacingError?.code === 'S031') {
      const operationDot = this.tokens.find(
        (t) => t.span.line === spacingError.span.line && t.span.col === spacingError.span.col,
      )!;
      spacingError.fixes = [
        {
          title: 'parenthesize the literal',
          edits: [
            {
              span,
              insert: `(${this.source.slice(start.start, operationDot.end)}).${this.source.slice(operationDot.end, end.end)}`,
            },
          ],
        },
      ];
    }
    return { kind: 'literal', mode, duration, smooth, groups, shape, span };
  }
  itemStart(): boolean {
    return (
      ['number'].includes(this.token.kind) ||
      (['.', '_', '[', '<', '('].includes(this.token.text) &&
        !(
          this.token.text === '.' &&
          this.tokens[this.position + 1]?.kind === 'word' &&
          !this.tokens[this.position + 1].spaceBefore
        )) ||
      /^(?:[A-G](?:b)?\d*|c\d+|x|X|o)$/.test(this.token.text)
    );
  }
  items(stops: Set<string>): Item[] {
    const items: Item[] = [];
    while (!this.stopped(stops)) {
      if (
        this.is('.') &&
        this.tokens[this.position + 1]?.kind === 'word' &&
        !this.tokens[this.position + 1].spaceBefore
      ) {
        const dot = this.take(),
          operation = this.take();
        if (this.match('(')) this.arguments(operation.text);
        const span = combineSpan(dot.span, this.tokens[this.position - 1].span);
        // Preserve a final rest before the mistakenly chained operation.
        items.push({
          kind: 'item',
          atoms: [{ kind: 'clause', tokens: ['.'], span: dot.span }],
          options: [],
          span: dot.span,
        });
        this.error('S031', 'Parenthesize an unbracketed literal before chaining operations', span);
        break;
      }
      const start = this.token.span,
        atoms: Item['atoms'] = [];
      do {
        atoms.push(this.itemAtom());
      } while (this.match('+'));
      const item: Item = { kind: 'item', atoms, options: [], span: start };
      if (this.match('@')) item.weight = this.require('number').text;
      if (this.match('*')) item.ratchet = this.require('number').text;
      if (this.is('(') && this.tokens[this.position + 1]?.kind === 'number') {
        this.take();
        item.euclid = [this.require('number').text];
        this.require(',');
        item.euclid.push(this.require('number').text);
        if (this.match(',')) item.euclid.push(this.require('number').text);
        this.require(')');
      }
      if (this.match('{')) {
        do {
          item.options.push(this.clause(new Set([',', '}'])));
        } while (this.match(','));
        this.require('}');
      }
      item.span = combineSpan(start, this.tokens[this.position - 1].span);
      items.push(item);
    }
    if (!items.length) this.fail('Expected at least one literal item');
    return items;
  }
  itemAtom(): Item['atoms'][number] {
    const token = this.take();
    if (token.text === '[' || token.text === '<') {
      const items = this.items(new Set([token.text === '[' ? ']' : '>']));
      const close = this.require(token.text === '[' ? ']' : '>');
      return {
        kind: token.text === '[' ? 'subdivision' : 'alternation',
        items,
        span: combineSpan(token.span, close.span),
      };
    }
    if (token.text === '(') {
      this.require('across');
      this.position--;
      const value = this.literal('across');
      this.require(')');
      return value;
    }
    if (!(
      token.kind === 'word' ||
      token.kind === 'number' ||
      ['.', '_', '#'].includes(token.text)
    )) {
      this.error('S001', `Unexpected literal item ${token.text}`, token.span);
      throw new ParseFailure();
    }
    const parts = [token.text];
    while (!this.token.spaceBefore && ['#', '^', 'v', 'b'].includes(this.token.text)) {
      const suffix = this.take().text;
      parts.push(suffix);
      if (
        suffix === '#' &&
        /^[A-G]$/.test(token.text) &&
        this.token.kind === 'number' &&
        !this.token.spaceBefore
      )
        parts.push(this.take().text);
    }
    if (
      ['x', 'X', 'o'].includes(token.text) &&
      !this.token.spaceBefore &&
      this.is('+') &&
      this.tokens[this.position + 1]?.kind === 'number'
    )
      parts.push(this.take().text, this.take().text);
    if (['x', 'X', 'o'].includes(token.text) && !this.token.spaceBefore && this.match('-'))
      parts.push('-', this.require('number').text);
    return {
      kind: 'clause',
      tokens: parts,
      span: combineSpan(token.span, this.tokens[this.position - 1].span),
    };
  }
  clause(stops: Set<string>): Clause {
    const start = this.token.span,
      tokens: string[] = [],
      stack: string[] = [];
    while (!this.is('EOF') && !this.is('NL') && !this.is('DEDENT')) {
      if (!stack.length && this.stopped(stops)) break;
      const token = this.take();
      if (['(', '[', '{'].includes(token.text))
        stack.push({ '(': ')', '[': ']', '{': '}' }[token.text]!);
      else if ([')', ']', '}'].includes(token.text)) {
        if (stack.pop() !== token.text) this.error('S001', `Unexpected ${token.text}`, token.span);
      }
      tokens.push(token.text);
    }
    if (stack.length) this.error('S001', `Unclosed delimiter; expected ${stack.at(-1)}`);
    if (!tokens.length) this.fail('Expected a value or condition');
    return {
      kind: 'clause',
      tokens,
      span: combineSpan(start, this.tokens[this.position - 1].span),
    };
  }
  condition(stops: Set<string>, minimum = 0): Condition {
    let left: Condition;
    if (this.match('not')) {
      const start = this.tokens[this.position - 1].span;
      const value = this.condition(stops, 3);
      left = { kind: 'not', value, span: combineSpan(start, value.span) };
    } else if (this.match('(')) {
      left = this.condition(new Set([')']));
      this.require(')');
    } else left = this.clause(new Set([...stops, 'and', 'or']));
    while (!this.stopped(stops)) {
      const operator = this.token.text,
        precedence = operator === 'or' ? 1 : operator === 'and' ? 2 : 0;
      if (!precedence || precedence < minimum) break;
      this.take();
      const right = this.condition(stops, precedence + 1);
      left = {
        kind: 'condition',
        operator: operator as 'and' | 'or',
        left,
        right,
        span: combineSpan(left.span, right.span),
      };
    }
    return left;
  }
}
export function parse(
  source: string,
  context?: TemplateExpansion,
): { ast: File; diagnostics: Diagnostic[] } {
  const expansion = context ?? expandTemplates(source);
  const parser = new Parser(context ? source : expansion.source);
  const ast = parser.file();
  restoreTemplateOrigins(ast, parser.diagnostics, expansion);
  return {
    ast,
    diagnostics: [...parser.diagnostics, ...expansion.diagnostics].sort(
      (a, b) => a.span.line - b.span.line || a.span.col - b.span.col,
    ),
  };
}
export function parseExpression(source: string): {
  expression?: Expression;
  diagnostics: Diagnostic[];
} {
  const parser = new Parser(source);
  let expression: Expression | undefined;
  try {
    const value = parser.sequence(new Set(['NL']), true);
    expression = value.elements[0];
  } catch (error) {
    if (!(error instanceof ParseFailure)) throw error;
  }
  return { expression, diagnostics: parser.diagnostics };
}

function nearest(name: string, candidates: string[]): string | undefined {
  function distance(a: string, b: string): number {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 0; i < a.length; i++) {
      const next = [i + 1];
      for (let j = 0; j < b.length; j++)
        next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
      row = next;
    }
    return row[b.length];
  }
  const best = [...candidates].sort(
    (a, b) => distance(name, a) - distance(name, b) || a.localeCompare(b),
  )[0];
  return best && distance(name, best) <= 2 ? best : undefined;
}
