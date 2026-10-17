import type { Span } from './diag.ts';
export type Sequence = { kind: 'sequence'; elements: Expression[]; span: Span; rate?: Expression };
export type Clause = { kind: 'clause'; tokens: string[]; span: Span };
export type Condition =
  | {
      kind: 'condition';
      operator: 'and' | 'or';
      left: Condition | Clause;
      right: Condition | Clause;
      span: Span;
    }
  | { kind: 'not'; value: Condition | Clause; span: Span }
  | Clause;
export type Expression = (
  | { kind: 'number'; text: string; span: Span }
  | { kind: 'name'; name: string; span: Span }
  | { kind: 'binary'; operator: string; left: Expression; right: Expression; span: Span }
  | { kind: 'range'; from?: Expression; to?: Expression; span: Span }
  | { kind: 'span'; value: Expression; unit: string; span: Span }
  | { kind: 'call'; name: string; args: Argument[]; span: Span; clock?: 'song' }
  | { kind: 'operation'; receiver: Expression; name: string; args: Argument[]; span: Span }
  | { kind: 'group'; value: Sequence; span: Span }
  | { kind: 'label'; value: Expression; name: string; span: Span }
  | { kind: 'alternation'; branches: Expression[]; span: Span }
  | {
      kind: 'literal';
      mode: 'bars' | 'steps' | 'across';
      duration?: Sequence;
      smooth?: boolean;
      groups: Item[][];
      shape?: Expression;
      span: Span;
    }
  | { kind: 'shape'; name: string; value: Expression; every?: Sequence; span: Span }
) & { origin?: { name: string; kind: string; span: Span }; callSites?: Span[] };
export type Argument =
  Sequence | Clause | { kind: 'where'; condition: Condition; operations: Sequence[]; span: Span };
export type Item = {
  kind: 'item';
  atoms: (
    Clause | { kind: 'subdivision' | 'alternation'; items: Item[]; span: Span } | Expression
  )[];
  weight?: string;
  ratchet?: string;
  euclid?: string[];
  options: Clause[];
  span: Span;
};
export type Field = {
  kind: 'field';
  playKind?: string;
  name: string;
  value: Sequence | Clause | Condition;
  span: Span;
};
export type Override = { kind: 'override'; condition: Condition; fields: Field[]; span: Span };
export type Statement =
  | { kind: 'song'; title: string; fields: Field[]; span: Span }
  | { kind: 'binding'; keyword: string; name: string; value: Sequence; span: Span }
  | { kind: 'form'; value: Sequence; span: Span }
  | {
      kind: 'define';
      name: string;
      params: { name: string; type: string; span: Span }[];
      value?: Sequence;
      fields?: Field[];
      span: Span;
    }
  | { kind: 'harmony'; targets: string[]; value: Sequence; span: Span }
  | { kind: 'when'; name: string; condition: Condition; span: Span }
  | { kind: 'curve'; name: string; entries: Clause[]; span: Span }
  | {
      kind: 'part';
      name: string;
      fields: (Field | Override)[];
      span: Span;
      template?: import('./templates.ts').TemplateOrigin;
    }
  | { kind: 'silence' | 'expect'; value: Clause; span: Span };
export const SCORE_FORMAT_VERSION = '1';
export type File = {
  kind: 'file';
  version: typeof SCORE_FORMAT_VERSION;
  statements: Statement[];
  span: Span;
};
