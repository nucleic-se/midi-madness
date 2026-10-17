/** Local literal validation; name-dependent extents are deliberately deferred to resolution. */
import type { Expression, Field, File, Sequence } from './ast.ts';
import { diagnostic, type Diagnostic, type Span } from './diag.ts';
import { compileLiteral, literalType, type LiteralContext } from './literals.ts';
import { Rational } from '@midi-madness/foundation/time';
import type { TimedType, TimedValue } from './timed.ts';
export function checkLiterals(file: File): {
  diagnostics: Diagnostic[];
  literals: { path: string; span: Span; value: TimedValue }[];
} {
  const diagnostics: Diagnostic[] = [],
    literals: { path: string; span: Span; value: TimedValue }[] = [];
  let meter: readonly [number, number] = [4, 4],
    pulse: Rational | undefined,
    contextualPulses = false;
  for (const statement of file.statements)
    if (statement.kind === 'song') {
      for (const field of statement.fields)
        if (field.name === 'meter' && field.value.kind === 'clause') {
          const match = field.value.tokens[0]?.match(/^(\d+)\/(\d+)$/);
          if (
            !match ||
            !match.slice(1).every((x) => Number.isSafeInteger(Number(x)) && Number(x) > 0)
          ) {
            diagnostics.push(
              diagnostic(
                'R003',
                'Meter needs positive integer numerator and denominator',
                field.value.span,
              ),
            );
            continue;
          }
          meter = [Number(match[1]), Number(match[2])];
          const group = field.value.tokens.indexOf('pulses');
          if (group >= 0) {
            const groups = field.value.tokens
              .slice(group + 1)
              .filter((x) => x !== '+')
              .map(Number);
            contextualPulses = groups.some((x) => x !== groups[0]);
            if (!contextualPulses && groups.every((x) => Number.isSafeInteger(x) && x > 0))
              pulse = new Rational(groups[0], meter[1]);
          }
        }
    }
  function inferred(expression: Expression): TimedType {
    if (expression.kind === 'shape') return 'values';
    if (expression.kind === 'literal') return literalType(expression);
    return 'notes';
  }
  function dynamicDuration(expression: Expression): boolean {
    if (expression.kind === 'name') return true;
    if (expression.kind === 'binary')
      return dynamicDuration(expression.left) || dynamicDuration(expression.right);
    if (expression.kind === 'group') return expression.value.elements.some(dynamicDuration);
    if (expression.kind === 'span')
      return (
        (contextualPulses && ['pulse', 'pulses'].includes(expression.unit)) ||
        dynamicDuration(expression.value)
      );
    return expression.kind === 'call' || expression.kind === 'operation';
  }
  function sequence(
    value: Sequence,
    path: string,
    type?: TimedType,
    contextual = false,
    pattern = false,
  ): void {
    let previousMaterial = false;
    for (const element of value.elements) {
      const before = literals.length;
      visit(element, path, type, contextual, pattern || previousMaterial);
      previousMaterial ||=
        literals.slice(before).some((literal) => literal.value.events.length > 0) ||
        unresolvedMaterial(element);
    }
  }
  function unresolvedMaterial(expression: Expression): boolean {
    if (expression.kind === 'name' || expression.kind === 'call' || expression.kind === 'operation')
      return true;
    if (expression.kind === 'group') return expression.value.elements.some(unresolvedMaterial);
    if (expression.kind === 'label') return unresolvedMaterial(expression.value);
    return false;
  }
  function visit(
    expression: Expression,
    path: string,
    type?: TimedType,
    contextual = false,
    allowLeadingHold = false,
  ): void {
    if (expression.kind === 'literal' || expression.kind === 'shape') {
      if (expression.kind === 'literal' && expression.duration?.elements.some(dynamicDuration)) {
        const source = expression.duration.elements;
        const contextualSpan = source.some(
          (e) => e.kind === 'name' && ['section', 'phrase'].includes(e.name),
        );
        if (contextualSpan && !contextual)
          diagnostics.push(
            diagnostic(
              'R010',
              'Contextual section/phrase literals require a part plays or field expression',
              expression.span,
              { path },
            ),
          );
        return;
      }
      const context: LiteralContext = {
        type: type ?? inferred(expression),
        meter,
        pulse,
        path,
        allowLeadingHold,
      };
      const result = compileLiteral(expression, context);
      diagnostics.push(...result.diagnostics);
      if (result.value) literals.push({ path, span: expression.span, value: result.value });
    } else if (expression.kind === 'group')
      sequence(expression.value, path, type, contextual, allowLeadingHold);
    else if (expression.kind === 'label')
      visit(expression.value, path, type, contextual, allowLeadingHold);
    else if (expression.kind === 'alternation')
      expression.branches.forEach((branch) =>
        visit(branch, path, type, contextual, allowLeadingHold),
      );
    else if (expression.kind === 'binary') {
      visit(expression.left, path, type, contextual, allowLeadingHold);
      visit(expression.right, path, type, contextual, allowLeadingHold);
    } else if (expression.kind === 'operation' || expression.kind === 'call') {
      if (expression.kind === 'operation')
        visit(
          expression.receiver,
          path,
          expression.name === 'rhythm' ? 'notes' : type,
          contextual,
          allowLeadingHold,
        );
      for (const arg of expression.args) {
        if (arg.kind === 'sequence')
          sequence(arg, path, expression.name === 'on' ? 'hits' : undefined, contextual);
        else if (arg.kind === 'where')
          arg.operations.forEach((operation) => sequence(operation, path, undefined, contextual));
      }
    }
  }
  function field(field: Field, path: string): void {
    if (field.value.kind !== 'sequence') return;
    if (field.name === 'plays') {
      const [kind, ...elements] = field.value.elements;
      const type: TimedType =
        kind?.kind === 'name' && ['hits', 'roots', 'chords', 'arpeggio'].includes(kind.name)
          ? 'hits'
          : 'notes';
      sequence({ ...field.value, elements }, path, type, true, true);
    } else sequence(field.value, path, field.name === 'use' ? undefined : 'values', true);
  }
  for (const statement of file.statements) {
    if (statement.kind === 'binding')
      sequence(
        statement.value,
        `${statement.keyword} ${statement.name}`,
        statement.keyword === 'rhythm'
          ? 'hits'
          : statement.keyword === 'signal'
            ? 'values'
            : statement.keyword === 'progression'
              ? 'harmony'
              : 'notes',
      );
    else if (statement.kind === 'form' || statement.kind === 'harmony')
      sequence(statement.value, statement.kind, statement.kind === 'harmony' ? 'harmony' : 'notes');
    else if (statement.kind === 'define') {
      if (statement.value) sequence(statement.value, `define ${statement.name}`);
      statement.fields?.forEach((f) => field(f, `define ${statement.name}`));
    } else if (statement.kind === 'part')
      for (const item of statement.fields) {
        if (item.kind === 'field') field(item, `part ${statement.name}`);
        else item.fields.forEach((f) => field(f, `part ${statement.name}/when`));
      }
  }
  return { diagnostics, literals };
}
