import { decimalText } from './constants.ts';
import { readFileSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Apply `map` to the quoted `data "..."` path on one lane line, using the same
 * detection as loadDataLanes (a complete lane expression after `=`, never a title or comment).
 */
export function mapDataPaths(line: string, map: (path: string) => string): string {
  const equal = line.indexOf('=');
  if (equal < 0 || line.slice(0, equal).includes('//')) return line;
  const tail = line.slice(equal + 1);
  if (!/^\s*data\s+"/.test(tail)) return line;
  return (
    line.slice(0, equal + 1) +
    tail.replace(
      /^(\s*data\s+)("(?:[^"\\]|\\.)*")/,
      (_, space: string, quoted: string) => `${space}${JSON.stringify(map(JSON.parse(quoted)))}`,
    )
  );
}

/** Resolve external numeric lanes once, before compilation, relative to the score. */
export function loadDataLanes(
  source: string,
  filename?: string,
  read: (path: string) => Buffer | string = readFileSync,
) {
  const dependencies: { path: string; hash: string }[] = [];
  const expanded = source
    .split(/\r?\n/)
    .map((line, index) => {
      try {
        const equal = line.indexOf('=');
        if (equal < 0 || line.slice(0, equal).includes('//')) return line;
        const prefix = line.slice(0, equal + 1);
        const tail = line.slice(equal + 1);
        // Data is a complete lane expression, never a quoted title or comment.
        if (!/^\s*data\s+"/.test(tail)) return line;
        return (
          prefix +
          tail.replace(
            /^\s*data\s+("(?:[^"\\]|\\.)*")\s+key\s+([\w.-]+)(?:\s+per\s+(\d+(?:\/\d+|\.\d+)?)(?:\s+(bars?|beats?))?)?(?:\s+(smooth|hold))?/g,
            (
              _,
              quoted: string,
              key: string,
              step: string | undefined,
              unit: string | undefined,
              mode = 'smooth',
            ) => {
              const path = resolve(filename ? dirname(filename) : '.', JSON.parse(quoted));
              const bytes = read(path);
              const text = bytes.toString();
              if (!dependencies.some((d) => d.path === path))
                dependencies.push({ path, hash: createHash('sha256').update(bytes).digest('hex') });
              let values: unknown;
              if (extname(path).toLowerCase() === '.csv') {
                // Numeric CSV with a header; quoted fields are accepted (no embedded newlines).
                const rows = text
                  .trim()
                  .split(/\r?\n/)
                  .map((line) => {
                    const fields: string[] = [];
                    let field = '',
                      quoted = false;
                    for (let i = 0; i < line.length; i++) {
                      const c = line[i];
                      if (c === '"') {
                        if (quoted && line[i + 1] === '"') {
                          field += '"';
                          i++;
                        } else quoted = !quoted;
                      } else if (c === ',' && !quoted) {
                        fields.push(field.trim());
                        field = '';
                      } else field += c;
                    }
                    if (quoted) throw new RangeError('Unclosed CSV field');
                    fields.push(field.trim());
                    return fields;
                  });
                const index = rows[0].indexOf(key);
                if (index < 0) throw new RangeError(`Data column ${key} missing in ${path}`);
                values = rows
                  .slice(1)
                  .map((row) =>
                    row[index] === undefined || row[index] === '' ? NaN : Number(row[index]),
                  );
              } else {
                let lane: unknown = JSON.parse(text);
                for (const field of key.split('.'))
                  lane = (lane as Record<string, unknown>)?.[field];
                values = lane;
              }
              if (
                !Array.isArray(values) ||
                !values.length ||
                !values.every((v) => typeof v === 'number' && Number.isFinite(v))
              )
                throw new RangeError(`Data lane ${key} must be a nonempty array of finite numbers`);
              const numeric = values.map((v) => decimalText(v as number));
              return ` per ${step ?? '1'} ${unit ?? (step === undefined ? 'bar' : '')} ${mode === 'smooth' ? 'smooth' : ''}: ${numeric.join(', ')}`;
            },
          )
        );
      } catch (error) {
        throw Object.assign(error as Error, { line: index + 1 });
      }
    })
    .join('\n');
  return { source: expanded, dependencies };
}
