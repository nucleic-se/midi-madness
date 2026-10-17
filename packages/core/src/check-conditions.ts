import type { Condition } from './ast.ts';
import { diagnostic, type Diagnostic } from './diag.ts';
import { evaluateCondition, parseCondition } from './conditions.ts';
import type { Resolution } from './resolve.ts';
import { Rational as R } from '@midi-madness/foundation/time';
export function checkConditions(resolution: Resolution): Diagnostic[] {
  const diagnostics: Diagnostic[] = [],
    named = new Map<string, Condition>();
  for (const s of resolution.normalized.statements)
    if (s.kind === 'when') named.set(s.name, s.condition);
  function visit(c: Condition, eventContext: boolean, stack: string[] = []): void {
    if (c.kind === 'not') {
      visit(c.value, eventContext, stack);
      return;
    }
    if (c.kind === 'condition') {
      visit(c.left, eventContext, stack);
      visit(c.right, eventContext, stack);
      return;
    }
    const text = c.tokens.join(' ');
    if (text.startsWith('(') && text.endsWith(')')) {
      visit(parseCondition(text), eventContext, stack);
      return;
    }
    if (!eventContext && /^(first|last|highest|lowest) note of /.test(text))
      diagnostics.push(
        diagnostic('C006', 'Note selectors need an event; use them in material or .where', c.span),
      );
    if (named.has(text)) {
      if (stack.includes(text))
        diagnostics.push(diagnostic('C004', 'Condition definitions form a cycle', c.span));
      else visit(named.get(text)!, eventContext, [...stack, text]);
      return;
    }
    const recognized =
      /^(always|fill bar|on pulse|off pulse)$/.test(text) ||
      /^in [\w-]+/.test(text) ||
      /^(every|euclid|after) /.test(text) ||
      /^bar /.test(text) ||
      /^(first|last|highest|lowest) (bar|note) of /.test(text) ||
      /^[\w-]+ (<=|>=|<|>|=) [+-]?[\d.]+%?$/.test(text);
    if (!recognized)
      diagnostics.push(
        diagnostic('C001', `Unknown condition atom ${text}`, c.span, {
          causes: ['Use a named condition, in <name>, or a documented position/signal comparison.'],
        }),
      );
    if (/^(every|euclid|after) /.test(text)) {
      try {
        evaluateCondition(c, { time: new R(0), bar: new R(1) });
      } catch (error) {
        diagnostics.push(diagnostic('C005', String(error), c.span));
      }
    }
  }
  for (const s of resolution.normalized.statements) {
    if (s.kind === 'when') visit(s.condition, true, [s.name]);
    if (s.kind === 'part')
      for (const f of s.fields) {
        if (f.kind === 'override') visit(f.condition, false);
        else if (f.name === 'play' && f.value.kind !== 'sequence') visit(f.value, false);
      }
  }
  return diagnostics;
}
