import { readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { mapDataPaths } from './data.ts';

/** One site in an include chain: an absolute file and a 1-based line. */
export type IncludeSite = { file: string; line: number };
/** Where one expanded line came from: its file, its line there, the indentation added, and the include chain (innermost first). */
export type LineOrigin = IncludeSite & { indent: number; from: IncludeSite[] };
export type ScoreDependency = { path: string; hash: string; kind: 'score' | 'include' | 'data' };
export type LoadedScore = {
  /** The fully include-expanded score; identical to `raw` for dependency-free scores. */
  source: string;
  /** The main score file's own text. */
  raw: string;
  /** Absolute path of the main score. */
  file: string;
  /** The score, every included file and every data file, each with its sha256, in discovery order. */
  files: ScoreDependency[];
  /** Provenance hash: the score's sha256 when it has no dependencies, else a hash over `files`. */
  hash: string;
  /** Origin of each expanded line (index 0 is line 1). */
  lineMap: LineOrigin[];
};
export type LoadOptions = {
  /** Reads a file by absolute path; defaults to the filesystem (snapshots read git revisions). */
  read?: (path: string) => Buffer | string;
};

/** A structural include problem, located in the file that caused it. */
export class IncludeError extends Error {
  file: string;
  line: number;
  from: IncludeSite[];
  constructor(message: string, at: IncludeSite, from: IncludeSite[]) {
    super(message);
    this.name = 'IncludeError';
    this.file = at.file;
    this.line = at.line;
    this.from = from;
  }
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const includeLine = /^([ \t]*)include\s+("(?:[^"\\]|\\.)*")\s*(?:\/\/.*)?$/;
const header = /^\s*mm\s+\d+\s*(?:\/\/.*)?$/;
const songBlock = /^\s*song(?:\s|$)/;
const posix = (path: string) => path.split(sep).join('/');

/** Display a chain as `frag.mmi:12, included from main.mm:3`. */
export function describeSite(at: IncludeSite, from: IncludeSite[], base = process.cwd()): string {
  return [at, ...from]
    .map((s) => `${relative(base, s.file) || s.file}:${s.line}`)
    .join(', included from ');
}

/** Hash rule: a dependency-free score keeps the sha256 of its own bytes. */
export function provenanceHash(files: ScoreDependency[]): string {
  if (files.length === 1) return files[0].hash;
  const base = dirname(files[0].path);
  return sha256(files.map((f) => `${f.hash}  ${posix(relative(base, f.path))}\n`).join(''));
}

/**
 * Read a score and textually expand `include "path"` lines before any other stage.
 * Paths are relative to the including file; the include line's indentation is added
 * to every included line; data paths are made absolute so the expansion can be saved anywhere.
 */
export function loadScore(file: string, options: LoadOptions = {}): LoadedScore {
  const main = resolve(file);
  const read = options.read ?? ((path: string) => readFileSync(path));
  const files: ScoreDependency[] = [];
  const text = (path: string, site: IncludeSite | undefined, from: IncludeSite[]) => {
    let bytes: Buffer | string;
    try {
      bytes = read(path);
    } catch (error) {
      if (!site) throw error;
      throw new IncludeError(
        `Cannot read included file ${relative(dirname(site.file), path)}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
        site,
        from,
      );
    }
    if (!files.some((f) => f.path === path))
      files.push({ path, hash: sha256(bytes), kind: site ? 'include' : 'score' });
    return typeof bytes === 'string' ? bytes : bytes.toString('utf8');
  };
  const raw = text(main, undefined, []);
  const lines: string[] = [];
  const lineMap: LineOrigin[] = [];
  let includes = false;
  let rewritten = false;
  const expand = (
    path: string,
    content: string,
    indent: string,
    from: IncludeSite[],
    stack: string[],
  ) => {
    const parts = content.split(/\r?\n/);
    if (parts.length > 1 && parts.at(-1) === '') parts.pop();
    parts.forEach((line, index) => {
      const site = { file: path, line: index + 1 };
      if (path !== main && (header.test(line) || songBlock.test(line)))
        throw new IncludeError(
          `Include fragment ${relative(dirname(main), path)} must not contain ${header.test(line) ? 'the mm header' : 'a song block'}`,
          site,
          from,
        );
      const include = line.match(includeLine);
      if (include) {
        includes = true;
        let target: string;
        try {
          target = resolve(dirname(path), JSON.parse(include[2]) as string);
        } catch {
          throw new IncludeError('Invalid quoted include path', site, from);
        }
        if (
          stack.includes(target) ||
          (!options.read &&
            stack.some((p) => {
              try {
                return realpathSync(p) === realpathSync(target);
              } catch {
                return false;
              }
            }))
        )
          throw new IncludeError(
            `Include cycle: ${[...stack.slice(Math.max(0, stack.indexOf(target))), target].map((p) => relative(dirname(main), p)).join(' -> ')}`,
            site,
            from,
          );
        expand(
          target,
          text(target, site, from),
          indent + include[1],
          [site, ...from],
          [...stack, target],
        );
        return;
      }
      if (/^\s*include\b/.test(line))
        throw new IncludeError('Expected include "<path>" on its own line', site, from);
      const original = line;
      try {
        line = mapDataPaths(line, (data) => resolve(dirname(path), data));
      } catch {
        throw new IncludeError('Invalid quoted data path', site, from);
      }
      rewritten ||= line !== original;
      lines.push(line.trim() ? indent + line : '');
      lineMap.push({ file: path, line: index + 1, indent: indent.length, from });
    });
  };
  expand(main, raw, '', [], [main]);
  // Dependency-free scores are passed through byte for byte.
  const source = includes || rewritten ? lines.join('\n') + (raw.endsWith('\n') ? '\n' : '') : raw;
  source.split(/\r?\n/).forEach((line, index) =>
    mapDataPaths(line, (data) => {
      const path = resolve(dirname(main), data);
      if (!files.some((f) => f.path === path))
        try {
          files.push({ path, hash: sha256(read(path)), kind: 'data' });
        } catch (error) {
          const origin = lineMap[index];
          throw new IncludeError(
            `Cannot read data file ${path}: ${(error as Error).message}`,
            origin,
            origin.from,
          );
        }
      return data;
    }),
  );
  return { source, raw, file: main, files, hash: provenanceHash(files), lineMap };
}

/** Map a 1-based line of the expanded source back to its original file and line. */
export function originOf(
  loaded: Pick<LoadedScore, 'lineMap'>,
  line: number,
): LineOrigin | undefined {
  return loaded.lineMap[line - 1];
}
