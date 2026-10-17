import { diagnostic, type Diagnostic, type Span } from './diag.ts';
export type Token = {
  kind: 'word' | 'number' | 'string' | 'symbol' | 'NL' | 'INDENT' | 'DEDENT' | 'EOF';
  text: string;
  span: Span;
  start: number;
  end: number;
  spaceBefore: boolean;
  spaceAfter: boolean;
};
export const reserved = new Set(
  'mm song motif rhythm signal progression phrase section form define harmony curve when part silence expect as in of on by with from to at for template per every since after before not and or always rest across steps'.split(
    ' ',
  ),
);
export function lex(source: string): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const tokens: Token[] = [],
    diagnostics: Diagnostic[] = [],
    indents = [0];
  let offset = 0,
    lineNumber = 1;
  const lines = source.split('\n');
  function push(
    kind: Token['kind'],
    text: string,
    line: number,
    col: number,
    start: number,
    end: number,
  ) {
    tokens.push({
      kind,
      text,
      span: { line, col, endLine: line, endCol: col + end - start },
      start,
      end,
      spaceBefore: start === 0 || /\s/.test(source[start - 1]),
      spaceAfter: end === source.length || /\s/.test(source[end]),
    });
  }
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const indentText = line.match(/^[ \t]*/)![0];
    for (let i = 0; i < line.length; i++)
      if (line[i] === '\t')
        diagnostics.push(
          diagnostic(
            'S010',
            'Tabs are not allowed; use spaces',
            { line: lineNumber, col: i + 1, endLine: lineNumber, endCol: i + 2 },
            {
              fixes: [
                {
                  title: 'replace tab with two spaces',
                  edits: [
                    {
                      span: { line: lineNumber, col: i + 1, endLine: lineNumber, endCol: i + 2 },
                      insert: '  ',
                    },
                  ],
                },
              ],
            },
          ),
        );
    if (!line.slice(indentText.length).trim() || line.slice(indentText.length).startsWith('//')) {
      offset += rawLine.length + 1;
      lineNumber++;
      continue;
    }
    const indent = indentText.length;
    if (indent > indents.at(-1)!) {
      indents.push(indent);
      push('INDENT', '', lineNumber, 1, offset, offset);
    } else {
      while (indent < indents.at(-1)!) {
        indents.pop();
        push('DEDENT', '', lineNumber, 1, offset, offset);
      }
      if (indent !== indents.at(-1))
        diagnostics.push(
          diagnostic('S001', 'Indentation must match a previous block level', {
            line: lineNumber,
            col: 1,
            endLine: lineNumber,
            endCol: indent + 1,
          }),
        );
    }
    let i = indent;
    while (i < line.length) {
      if (/\s/.test(line[i])) {
        i++;
        continue;
      }
      if (line.slice(i, i + 2) === '//') break;
      const start = i;
      let kind: Token['kind'] = 'symbol',
        text = '';
      if (line[i] === '"') {
        i++;
        let escaped = false;
        while (i < line.length) {
          const ch = line[i++];
          if (ch === '"' && !escaped) break;
          escaped = ch === '\\' && !escaped;
        }
        text = line.slice(start, i);
        kind = 'string';
        if (text.length === 1 || !text.endsWith('"'))
          diagnostics.push(
            diagnostic('S001', 'Unclosed string', {
              line: lineNumber,
              col: start + 1,
              endLine: lineNumber,
              endCol: i + 1,
            }),
          );
      } else {
        const tail = line.slice(i);
        const leadingDecimal = tail.match(/^\.\d+/);
        const word =
          tail.match(/^[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9][A-Za-z0-9_]*)*/) ??
          tail.match(/^#[IViv]+[A-Za-z0-9]*/);
        const signed =
          (line[i] === '+' || line[i] === '-') &&
          /\d/.test(line[i + 1] ?? '') &&
          (i === indent || /[\s(:,=]/.test(line[i - 1]) || line.slice(i - 2, i) === '..');
        const number = (signed ? tail.slice(1) : tail).match(
          /^\d+(?:\.(?!\.)\d+)?(?:\/\d+(?:\.(?!\d)|t)?)?%?/,
        );
        if (leadingDecimal) {
          text = leadingDecimal[0];
          kind = 'number';
          const span = {
            line: lineNumber,
            col: i + 1,
            endLine: lineNumber,
            endCol: i + text.length + 1,
          };
          diagnostics.push(
            diagnostic('S020', 'Decimals need a leading digit', span, {
              fixes: [{ title: 'add leading zero', edits: [{ span, insert: `0${text}` }] }],
            }),
          );
        } else if (word) {
          text = word[0];
          kind = 'word';
        } else if (number) {
          text = (signed ? line[i] : '') + number[0];
          kind = 'number';
        } else
          text = ['..', '<=', '>=', '->'].includes(tail.slice(0, 2)) ? tail.slice(0, 2) : line[i];
        i += text.length;
      }
      push(kind, text, lineNumber, start + 1, offset + start, offset + i);
    }
    push('NL', '\n', lineNumber, line.length + 1, offset + line.length, offset + line.length);
    offset += rawLine.length + 1;
    lineNumber++;
  }
  const endOffset = source.length,
    endLine = lines.length,
    endCol = lines.at(-1)!.length + 1;
  while (indents.length > 1) {
    indents.pop();
    push('DEDENT', '', endLine, endCol, endOffset, endOffset);
  }
  push('EOF', '', endLine, endCol, endOffset, endOffset);
  return { tokens, diagnostics };
}
