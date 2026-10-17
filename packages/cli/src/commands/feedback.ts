import type { ScoreDependency } from '../../../core/src/include.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash, engine } from './snapshot.ts';
import { at, timeAt } from '../../../core/src/inspect.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import type { SongIR } from '../../../core/src/ir.ts';

export type FeedbackEntry = {
  id: number;
  createdAt: string;
  text: string;
  sourceHash: string;
  sourceSnapshot: string;
  dependencies?: ScoreDependency[];
  engine: string;
  position: null | {
    requested: string;
    seconds: number;
    bar?: number;
    sectionBar?: number;
    section?: string;
    path?: string;
    parts: string[];
  };
};
export function readFeedback(file: string) {
  const path = `${file}.feedback.json`;
  if (!existsSync(path))
    return { schemaVersion: 1, song: resolve(file), entries: [] as FeedbackEntry[] };
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.entries))
    throw new RangeError(`Unsupported feedback ledger ${path}`);
  return ledger as { schemaVersion: number; song: string; entries: FeedbackEntry[] };
}
export function recordFeedback(
  file: string,
  source: string,
  song: SongIR,
  text: string,
  location?: string,
  dependencies?: ScoreDependency[],
) {
  if (!text.trim()) throw new RangeError('Feedback text cannot be empty');
  const ledger = readFeedback(file);
  let position: FeedbackEntry['position'] = null;
  if (location) {
    const time = timeAt(song, location, true);
    if (time.compare(new R(0)) < 0 || time.compare(song.extent) >= 0)
      throw new RangeError('Feedback position is outside the song');
    const point = at(song, time);
    position = {
      requested: location,
      seconds: Number(point.seconds.numerator) / Number(point.seconds.denominator),
      bar: point.bar,
      sectionBar: point.sectionBar,
      section: point.section,
      path: point.path,
      parts: point.sounding.map((p) => p.part),
    };
  }
  const sourceHash = hash(source),
    directory = `${file}.feedback`,
    sourceSnapshot = resolve(directory, `${sourceHash}.mm`);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(sourceSnapshot)) writeFileSync(sourceSnapshot, source);
  const entry: FeedbackEntry = {
    id: ledger.entries.reduce((id, e) => Math.max(id, e.id), 0) + 1,
    createdAt: new Date().toISOString(),
    text: text.trim(),
    sourceHash,
    sourceSnapshot,
    dependencies,
    engine,
    position,
  };
  ledger.entries.push(entry);
  const path = `${file}.feedback.json`,
    temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(ledger, null, 2) + '\n');
  renameSync(temporary, path);
  return { ledger: resolve(path), entry };
}
