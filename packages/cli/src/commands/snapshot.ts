import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, relative, resolve } from 'node:path';
import type { SongIR } from '../../../core/src/ir.ts';
import { eventMeaning, controlMeaning } from '../../../core/src/inspect.ts';
import { loadDataLanes } from '../../../core/src/data.ts';
import { loadScore, type LoadedScore, type ScoreDependency } from '../../../core/src/include.ts';
import { engine } from '../version.ts';
export { engine } from '../version.ts';
export function hash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}
export function digests(song: SongIR): Record<string, string> {
  return Object.fromEntries(
    song.parts.map((p) => [
      p.name,
      hash(
        JSON.stringify({
          events: p.events.map(eventMeaning),
          controls: controlMeaning(p.controls),
        }),
      ),
    ]),
  );
}
export type Accepted = {
  sourceHash: string;
  gitRevision: string | null;
  dirty: boolean;
  engine: string;
  parts: Record<string, string>;
  /** Provenance hash and dependency list of the score at acceptance (absent in older snapshots). */
  scoreHash?: string;
  dependencies?: ScoreDependency[];
};
/**
 * The self-contained source a snapshot stores: includes expanded and, when the score
 * reads data files, their lanes inlined. A dependency-free score is stored byte for byte.
 */
export function frozenSource(loaded: LoadedScore): string {
  return loaded.files.some((f) => f.kind === 'data')
    ? loadDataLanes(loaded.source, loaded.file).source
    : loaded.source;
}
export function accept(file: string, source: string, song: SongIR, loaded?: LoadedScore): Accepted {
  loaded ??= loadScore(file);
  source = frozenSource(loaded);
  const dependencies = loaded.files;
  let gitRevision: string | null = null,
    dirty = true;
  try {
    const cwd = dirname(resolve(file)),
      root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    dirty = !!execFileSync(
      'git',
      [
        'status',
        '--porcelain',
        '--',
        ...(dependencies?.map((d) => relative(root, realpathSync(d.path))) ?? [
          relative(root, resolve(file)),
        ]),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    /* Standalone scores have no git revision. */
  }
  const metadata: Accepted = {
      sourceHash: hash(source),
      dependencies,
      gitRevision,
      dirty,
      engine,
      parts: digests(song),
      scoreHash: loaded.hash,
    },
    directory = `${file}.accepted`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/source.mm`, source);
  writeFileSync(`${directory}/metadata.json`, JSON.stringify(metadata, null, 2) + '\n');
  return metadata;
}
export function accepted(file: string): { source: string; metadata: Accepted } {
  const directory = `${file}.accepted`,
    source = readFileSync(`${directory}/source.mm`, 'utf8'),
    metadata = JSON.parse(readFileSync(`${directory}/metadata.json`, 'utf8')) as Accepted;
  if (hash(source) !== metadata.sourceHash)
    throw new Error('Accepted source does not match its recorded hash');
  return { source, metadata };
}
/** The score as it was at a git revision, with includes expanded from that same revision. */
export function revisionSource(file: string, revision: string): string {
  file = resolve(realpathSync(dirname(resolve(file))), basename(file));
  const cwd = dirname(resolve(file)),
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const read = (path: string) =>
    execFileSync('git', ['show', `${revision}:${relative(root, path)}`], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  const loaded = loadScore(file, { read });
  return loaded.files.some((f) => f.kind === 'data')
    ? loadDataLanes(loaded.source, loaded.file, read).source
    : loaded.source;
}
