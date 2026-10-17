import type { RealizationResult } from '../../core/src/index.ts';
import { perData } from '../../core/src/constants.ts';
import type { Expression } from '../../core/src/ast.ts';
import { parseDuration } from '../../core/src/literals.ts';
import { sequenceText } from '../../core/src/source.ts';
import type { Sequence } from '../../core/src/ast.ts';
/** Detect rapid periodic controls before the coarse IR can alias them away. */
export function fastShapeControl(
  realized: RealizationResult,
  part: string,
  name: string,
  bpm: number,
): boolean {
  const seen = new Set<string>();
  function walk(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(walk);
    const e = value as Record<string, unknown>;
    if (e.kind === 'call' && e.name === '__sections') {
      // The original AST retains authored selectors; the normalized counterpart
      // has the compiled grid needed to choose the same rate as explicit per.
      const normalized = realized.resolution.normalized.statements.find(
        (s) => s.kind === 'part' && s.name === part,
      );
      const span = JSON.stringify(e.span);
      const compiled = (value: unknown): boolean => {
        if (!value || typeof value !== 'object') return false;
        if (Array.isArray(value)) return value.some(compiled);
        const node = value as Record<string, unknown>;
        if (node.kind === 'call' && node.name === '__per' && JSON.stringify(node.span) === span)
          return walk(node);
        return Object.entries(node).some(
          ([key, child]) => !['span', 'origin', 'callSites'].includes(key) && compiled(child),
        );
      };
      return (
        (normalized?.kind === 'part' &&
          normalized.fields.some((f) =>
            f.kind === 'field'
              ? f.name === name && compiled(f.value)
              : f.fields.some((field) => field.name === name && compiled(field.value)),
          )) ||
        false
      );
    }
    if (e.kind === 'call' && e.name === '__per') {
      try {
        const span = perData(
          e as Extract<Expression, { kind: 'call' }>,
          realized.song?.meter ?? [4, 4],
        ).step;
        if (((Number(span.numerator) / Number(span.denominator)) * 240) / bpm <= 0.1) return true;
      } catch {
        /* The compiler reports invalid spans. */
      }
    }
    if (e.kind === 'name' && typeof e.name === 'string' && !seen.has(e.name)) {
      seen.add(e.name);
      const symbol = realized.resolution.symbols.get(e.name);
      if (symbol && walk(symbol)) return true;
    }
    if (e.kind === 'operation' && e.name === 'fast') return true;
    if (e.kind === 'literal' && e.shape && e.duration) {
      try {
        const span = parseDuration(sequenceText(e.duration as Sequence));
        const seconds = ((Number(span.numerator) / Number(span.denominator)) * 240) / bpm;
        if (seconds > 0 && seconds <= 0.1) return true;
      } catch {
        /* Section/bar-relative slow shapes keep the base sampling rate. */
      }
    }
    return Object.entries(e).some(
      ([key, v]) => !['span', 'origin', 'callSites'].includes(key) && walk(v),
    );
  }
  const statement = realized.resolution.parts.get(part);
  if (!statement) return false;
  return statement.fields.some((f) =>
    f.kind === 'field'
      ? f.name === name && walk(f.value)
      : f.fields.some((field) => field.name === name && walk(field.value)),
  );
}

export function constantControl(realized: RealizationResult, part: string, name: string): boolean {
  const fields =
    realized.resolution.parts
      .get(part)
      ?.fields.flatMap((f) => (f.kind === 'field' ? [f] : f.fields))
      .filter((f) => f.name === name) ?? [];
  return fields.every(
    (f) =>
      f.value.kind === 'sequence' &&
      f.value.elements.length === 1 &&
      f.value.elements[0].kind === 'number',
  );
}
