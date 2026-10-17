/** Canonical indentation and whitespace, preserving authored tokens and comments. */
export function formatSource(source: string): string {
  const widths = [0],
    lines: string[] = [];
  for (const raw of source.replace(/\r\n/g, '\n').split('\n')) {
    if (!raw.trim()) {
      if (lines.length && lines.at(-1) !== '') lines.push('');
      continue;
    }
    const width = raw.match(/^ */)![0].length;
    while (widths.length > 1 && width < widths.at(-1)!) widths.pop();
    if (width > widths.at(-1)!) widths.push(width);
    lines.push('  '.repeat(widths.length - 1) + raw.trimEnd().slice(width));
  }
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n') + '\n';
}
