import type { Diagnostic, Span } from './diag.ts';
import { diagnostic } from './diag.ts';
import { parseExpression } from './parser.ts';
import { constant } from './constants.ts';
export type TemplateOrigin = {
  name: string;
  arguments: Record<string, string>;
  definitionLine: number;
  invocationLine: number;
};
type Line = { text: string; line: number; generated?: boolean; origin?: TemplateOrigin };
export type TemplateExpansion = {
  source: string;
  locations: { line: number; generated?: boolean }[];
  origins: Record<number, TemplateOrigin>;
  diagnostics: Diagnostic[];
};
const identifier = /^[A-Za-z_][\w-]*$/;
function split(text: string, delimiter: ',' | ' ') {
  const values: string[] = [];
  let depth = 0,
    quoted = false,
    literal = false,
    start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && text[i - 1] !== '\\') quoted = !quoted;
    if (quoted) continue;
    if (c === '|') literal = !literal;
    if (literal) continue;
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (!depth && (delimiter === ',' ? c === ',' : /\s/.test(c))) {
      if (text.slice(start, i).trim()) values.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (depth || quoted || literal) throw new RangeError('Unbalanced template argument/list');
  if (text.slice(start).trim()) values.push(text.slice(start).trim());
  return values;
}
function substitute(text: string, env: Record<string, string>) {
  return text.replace(
    /"(?:\\.|[^"\\])*"|\/\/.*|\{([A-Za-z_][\w-]*)\}|[A-Za-z_][\w-]*/g,
    (token, interpolation, offset: number) => {
      if (token.startsWith('"') || token.startsWith('//')) return token;
      const assignment = text.match(/^\s*(?:part\s+)?[\w.{}-]+\s*=/);
      if (
        !interpolation &&
        ((assignment && offset < assignment[0].indexOf('=')) || text[offset - 1] === '.')
      )
        return token;
      const prefix = text.slice(0, offset);
      const open = prefix.lastIndexOf('{'),
        close = prefix.lastIndexOf('}');
      if (
        !interpolation &&
        open > close &&
        !prefix.slice(Math.max(open, prefix.lastIndexOf(',')) + 1).trim()
      )
        return token;
      const value = interpolation ? (env[interpolation] ?? token) : (env[token] ?? token);
      if (
        !interpolation &&
        value.startsWith('(') &&
        prefix.lastIndexOf('{') > prefix.lastIndexOf('}')
      ) {
        const e = parseExpression(value).expression;
        if (e) {
          const v = constant(e);
          return String(Number(v.numerator) / Number(v.denominator));
        }
      }
      return value;
    },
  );
}
export function expandTemplates(source: string): TemplateExpansion {
  const input: Line[] = source.split(/\r?\n/).map((text, i) => ({ text, line: i + 1 }));
  const definitions = new Map<
    string,
    { params: { name: string; type: string }[]; body: Line[]; line: number }
  >();
  const diagnostics: Diagnostic[] = [];
  const error = (line: number, message: string, code = 'S001') =>
    diagnostics.push(
      diagnostic(code, message, {
        line,
        col: 1,
        endLine: line,
        endCol: Math.max(2, input[line - 1]?.text.length ?? 2),
      }),
    );
  const blockEnd = (lines: Line[], i: number) => {
    let end = i + 1;
    while (
      end < lines.length &&
      (!lines[end].text.replace(/\/\/.*$/, '').trim() || /^\s/.test(lines[end].text))
    )
      end++;
    return end;
  };
  for (let i = 0; i < input.length; i++) {
    const line = input[i],
      text = line.text.replace(/\/\/.*$/, '');
    if (!/^template\b/.test(text)) continue;
    const end = blockEnd(input, i);
    try {
      const m = text.match(/^template ([\w-]+)\((.*)\):\s*$/);
      if (!m || !identifier.test(m[1]))
        throw new RangeError('Expected template NAME(parameter: type, ...):');
      const params = split(m[2], ',').map((s) => {
        const p = s.match(/^([\w-]+)\s*:\s*(number|percent|notes|hits|span)$/);
        if (!p || !identifier.test(p[1]))
          throw new RangeError('Template parameters support number, percent, notes, hits and span');
        return { name: p[1], type: p[2] };
      });
      if (new Set(params.map((p) => p.name)).size !== params.length)
        throw new RangeError('Duplicate template parameter');
      if (definitions.has(m[1])) error(line.line, `Duplicate template ${m[1]}`, 'R004');
      else definitions.set(m[1], { params, body: input.slice(i + 1, end), line: line.line });
    } catch (e) {
      error(line.line, (e as Error).message);
    }
    for (let j = i; j < end; j++) input[j] = { ...input[j], text: '' };
    i = end - 1;
  }
  const output: Line[] = [];
  let partCount = 0,
    exhausted = false;
  function expand(lines: Line[], env: Record<string, string> = {}, depth = 0) {
    if (depth > 16) throw new RangeError('Template/for nesting exceeds 16 levels');
    for (let i = 0; i < lines.length; i++) {
      if (exhausted) break;
      const row = lines[i],
        replaced = substitute(row.text, env),
        text = replaced.replace(/\/\/.*$/, '');
      try {
        const forText = row.text.replace(/\/\/.*$/, '');
        if (/^for\b/.test(forText)) {
          const end = blockEnd(lines, i),
            m = forText.match(/^for ([\w, -]+) in \[(.*)\]:\s*$/);
          if (!m)
            throw new RangeError('For needs a literal row list: for n, note in [0 G3, 1 A3]:');
          const variables = split(m[1], ',');
          if (
            variables.some((v) => !identifier.test(v)) ||
            new Set(variables).size !== variables.length
          )
            throw new RangeError('Invalid or repeated for variable');
          const rows = split(substitute(m[2], env), ',');
          if (rows.length > 1024) throw new RangeError('For lists are limited to 1024 rows');
          const body = lines
            .slice(i + 1, end)
            .map((l) => ({ ...l, text: l.text.slice(2), line: row.line, generated: true }));
          for (const item of rows) {
            if (exhausted) break;
            const values = split(item, ' ');
            if (values.length !== variables.length)
              throw new RangeError(`For row needs ${variables.length} values: ${item}`);
            expand(
              body,
              { ...env, ...Object.fromEntries(variables.map((v, j) => [v, values[j]])) },
              depth + 1,
            );
          }
          i = end - 1;
          continue;
        }
        const invocation = text.match(/^part ([^\s]+)\s*=\s*([\w-]+)\((.*)\)\s*$/);
        if (invocation) {
          const [, name, template, argText] = invocation,
            def = definitions.get(template);
          if (!identifier.test(name)) throw new RangeError(`Invalid generated part name ${name}`);
          if (!def) throw new RangeError(`Unknown template ${template}`);
          const args = split(argText, ',');
          if (args.length !== def.params.length)
            throw new RangeError(`Template ${template} needs ${def.params.length} arguments`);
          const bindings: Record<string, string> = {};
          def.params.forEach((p, j) => {
            let value = args[j];
            if (p.type === 'number' || p.type === 'percent') {
              const r = parseExpression(value);
              if (r.diagnostics.length || !r.expression)
                throw new RangeError(`Invalid scalar argument ${value}`);
              const v = constant(r.expression);
              value =
                v.denominator === 1n ? String(v.numerator) : `(${v.numerator} / ${v.denominator})`;
            }
            bindings[p.name] = value;
          });
          if (++partCount > 1024)
            throw new RangeError('Template expansion is limited to 1024 parts');
          const origin: TemplateOrigin = {
            name: template,
            arguments: bindings,
            definitionLine: def.line,
            invocationLine: row.line,
          };
          output.push({ text: `part ${name}`, line: row.line, generated: true, origin });
          for (const field of def.body)
            output.push({
              text: substitute(field.text, bindings),
              line: row.line,
              generated: true,
              origin,
            });
          continue;
        }
        if (row.generated && text.trim() && !/^(part\b|\s)/.test(text))
          throw new RangeError('For bodies contain ordinary parts or template part invocations');
        if (output.length > 50000) throw new RangeError('Expanded score exceeds 50000 lines');
        output.push({ ...row, text: replaced });
      } catch (e) {
        const message = (e as Error).message;
        error(row.line, message, /Duplicate/.test(message) ? 'R004' : 'S001');
        if (/limited to|exceeds 50000/.test(message)) exhausted = true;
      }
    }
  }
  expand(input);
  return {
    source: output.map((l) => l.text).join('\n'),
    locations: output.map((l) => ({ line: l.line, generated: l.generated })),
    origins: Object.fromEntries(
      output.flatMap((l, i) => (l.origin && /^part /.test(l.text) ? [[i + 1, l.origin]] : [])),
    ),
    diagnostics,
  };
}
export function restoreTemplateOrigins(
  ast: import('./ast.ts').File,
  diagnostics: Diagnostic[],
  expansion: TemplateExpansion,
) {
  for (const s of ast.statements)
    if (s.kind === 'part' && expansion.origins[s.span.line])
      s.template = expansion.origins[s.span.line];
  const visited = new WeakSet<object>();
  function walk(value: unknown) {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if ('line' in value && 'col' in value) {
      const span = value as Span,
        a = expansion.locations[span.line - 1],
        b = expansion.locations[span.endLine - 1];
      if (a) {
        span.line = a.line;
        if (a.generated) span.col = 1;
      }
      if (b) {
        span.endLine = b.line;
        if (b.generated) span.endCol = 2;
      }
    } else Object.values(value).forEach(walk);
  }
  walk(ast);
  walk(diagnostics);
}
