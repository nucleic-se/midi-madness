export type Span = { line: number; col: number; endLine: number; endCol: number; file?: string };
export type Edit = { span: Span; insert: string };
export type Diagnostic = {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  span: Span;
  file?: string;
  path?: string;
  measured?: Record<string, unknown>;
  includedFrom?: { file: string; line: number }[];
  causes: string[];
  fixes: { title: string; edits: Edit[] }[];
  help: string;
};
export function diagnostic(
  code: string,
  message: string,
  span: Span,
  details: Partial<Omit<Diagnostic, 'code' | 'message' | 'span'>> = {},
): Diagnostic {
  return {
    file: span.file,
    code,
    severity: 'error',
    message,
    span,
    causes: [],
    fixes: [],
    help: code,
    ...details,
  };
}
export function combineSpan(a: Span, b: Span): Span {
  return { line: a.line, col: a.col, endLine: b.endLine, endCol: b.endCol };
}
export function summary(diagnostics: Diagnostic[]): {
  errors: number;
  warnings: number;
  infos: number;
} {
  return {
    errors: diagnostics.filter((d) => d.severity === 'error').length,
    warnings: diagnostics.filter((d) => d.severity === 'warning').length,
    infos: diagnostics.filter((d) => d.severity === 'info').length,
  };
}
