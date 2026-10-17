import { resolve } from 'node:path';
import type { LoadedScore } from './include.ts';
import type { Diagnostic, Span } from './diag.ts';

/** Translate compiler diagnostics and fix locations to the authored fragments. */
export function mapScoreDiagnostic(d: Diagnostic, score: LoadedScore): Diagnostic {
  const location = score.lineMap[d.span.line - 1];
  if (!location || (d.file && resolve(d.file) !== score.file)) return d;
  const mapSpan = (span: Span): Span => {
    const start = score.lineMap[span.line - 1];
    const end = score.lineMap[span.endLine - 1];
    if (!start) return span;
    return {
      ...span,
      file: start.file,
      line: start.line,
      col: Math.max(1, span.col - start.indent),
      endLine: end?.file === start.file ? end.line : start.line,
      endCol: Math.max(1, span.endCol - (end?.indent ?? start.indent)),
    };
  };
  return {
    ...d,
    file: location.file,
    span: mapSpan(d.span),
    includedFrom: location.from,
    fixes: d.fixes.map((fix) => ({
      ...fix,
      edits: fix.edits.map((edit) => ({ ...edit, span: mapSpan(edit.span) })),
    })),
  };
}
