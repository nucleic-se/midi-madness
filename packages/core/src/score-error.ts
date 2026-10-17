import type { Diagnostic, Span } from './diag.ts';

/** An invalid score setting, distinct from command usage and filesystem errors. */
export class ScoreError extends RangeError {
  readonly span: Span;
  constructor(message: string, span: Span) {
    super(message);
    this.name = 'ScoreError';
    this.span = span;
  }
}

export function scoreContext<T>(span: Span, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ScoreError || !(error instanceof RangeError)) throw error;
    throw new ScoreError(error.message, span);
  }
}

export function scoreLine<T>(line: number, operation: () => T): T {
  return scoreContext({ line, col: 1, endLine: line, endCol: 1 }, operation);
}

/** A failed compilation with the original structured diagnostics. */
export class ScoreDiagnosticsError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(
      diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => `${d.code}: ${d.message} (line ${d.span.line})`)
        .join('\n') || 'No song',
    );
    this.name = 'ScoreDiagnosticsError';
    this.diagnostics = diagnostics;
  }
}
