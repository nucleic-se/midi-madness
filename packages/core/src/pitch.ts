import type { Argument } from './ast.ts';
import { diagnostic, type Diagnostic } from './diag.ts';
import type { TimedValue } from './timed.ts';
export type Key = { tonic: number; name: string; mode: string; scale: readonly number[] };
export type Chord = {
  symbol: string;
  root: number | null;
  tones: number[];
  bass: number | null;
  intervals: number[];
  key: Key;
  degree: number;
};
const modes: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'melodic minor': [0, 2, 3, 5, 7, 9, 11],
};
const notes: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const numerals = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const mod = (n: number, d: number) => ((n % d) + d) % d;
function noteClass(text: string): number {
  const m = text.match(/^([A-G])([b#]?)$/);
  if (!m) throw new RangeError(`Unknown pitch name ${text}`);
  return notes[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
export function parseKey(source = 'C major'): Key {
  const m = source
    .trim()
    .replace(/^([A-G])\s+([#b])/, '$1$2')
    .match(/^([A-G][b#]?)\s+(.+)$/);
  if (!m || !modes[m[2]]) throw new RangeError(`Unknown key/mode ${source}`);
  return { tonic: mod(noteClass(m[1]), 12), name: m[1], mode: m[2], scale: modes[m[2]] };
}
function scaleTone(key: Key, index: number): number {
  return key.tonic + 12 * Math.floor(index / 7) + key.scale[mod(index, 7)];
}
export function parseChord(symbol: string, key: Key = parseKey()): Chord {
  if (symbol === 'N')
    return { symbol, root: null, tones: [], bass: null, intervals: [], key, degree: 1 };
  const m = symbol.match(
    /^([b#]?)(VII|III|VI|IV|II|V|I|vii|iii|vi|iv|ii|v|i)(o|\+)?(maj7|sus2|sus4|add9|ø7|7|6|9)?(?:\/(VII|III|VI|IV|II|V|I|vii|iii|vi|iv|ii|v|i|[13579]))?$/,
  );
  if (!m)
    throw new RangeError(
      `Unknown chord ${symbol}; expected a Roman numeral with optional alteration, quality, extension and slash bass/secondary target`,
    );
  let local = key;
  if (m[5] && !/^\d/.test(m[5])) {
    const index = numerals.indexOf(m[5].toUpperCase());
    local = { ...key, tonic: mod(scaleTone(key, index), 12), scale: modes.major, mode: 'major' };
  }
  const index = numerals.indexOf(m[2].toUpperCase()),
    degree = index + 1;
  const root = mod(scaleTone(local, index) + (m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0), 12);
  const suffix = (m[3] ?? '') + (m[4] ?? ''),
    minor = m[2] === m[2].toLowerCase();
  let intervals =
    suffix.startsWith('o') || suffix === 'ø7'
      ? [0, 3, 6]
      : suffix.startsWith('+')
        ? [0, 4, 8]
        : suffix === 'sus2'
          ? [0, 2, 7]
          : suffix === 'sus4'
            ? [0, 5, 7]
            : [0, minor ? 3 : 4, 7];
  if (m[4] === 'maj7') intervals.push(11);
  else if (m[3] === 'o' && ['7', '9'].includes(m[4])) intervals.push(9);
  else if (['7', '9', 'ø7'].includes(m[4])) intervals.push(10);
  else if (m[4] === '6') intervals.push(9);
  if (m[4] === '9' || m[4] === 'add9') intervals.push(14);
  const tones = intervals.map((i) => mod(root + i, 12));
  const bassIndex = m[5] && /^\d/.test(m[5]) ? (Number(m[5]) - 1) / 2 : 0;
  return { symbol, root, tones, bass: tones[bassIndex] ?? root, intervals, key: local, degree };
}
export function pitchClass(
  spelling: string,
  key: Key,
  chord?: Chord,
): { pitchClass: number; absolute?: number; octaveOffset: number } {
  let text = spelling,
    octaveOffset = 0;
  while (text.endsWith('^') || text.endsWith('v')) {
    octaveOffset += text.endsWith('^') ? 12 : -12;
    text = text.slice(0, -1);
  }
  const absolute = text.match(/^([A-G][b#]?)(-?\d+)$/);
  if (absolute) {
    const pitch = noteClass(absolute[1]) + 12 * (Number(absolute[2]) + 1);
    return { pitchClass: mod(pitch, 12), absolute: pitch + octaveOffset, octaveOffset: 0 };
  }
  if (/^[A-G][b#]?$/.test(text)) return { pitchClass: mod(noteClass(text), 12), octaveOffset };
  const degree = text.match(/^(\d+)([b#]?)$/),
    tone = text.match(/^c(1|3|5|7|9)$/);
  if (degree && Number(degree[1]) >= 1)
    return {
      pitchClass: mod(
        scaleTone(key, Number(degree[1]) - 1) +
          (degree[2] === 'b' ? -1 : degree[2] === '#' ? 1 : 0),
        12,
      ),
      octaveOffset,
    };
  if (tone) {
    const index = (Number(tone[1]) - 1) / 2;
    const pc =
      !chord || chord.root === null
        ? scaleTone(key, Number(tone[1]) - 1)
        : chord.intervals[index] !== undefined
          ? chord.root + chord.intervals[index]
          : scaleTone(chord.key, chord.degree - 1 + Number(tone[1]) - 1);
    return { pitchClass: mod(pc, 12), octaveOffset };
  }
  throw new RangeError(`Unknown pitch spelling ${spelling}`);
}
function nearest(pc: number, previous?: number): number {
  if (previous === undefined) return 60 + pc;
  const low = pc + 12 * Math.floor((previous - pc) / 12),
    high = low + 12;
  return previous - low <= high - previous ? low : high;
}
export function resolvePitch(
  spelling: string,
  key: Key = parseKey(),
  chord?: Chord,
  previous?: number,
  above = false,
): number {
  const parsed = pitchClass(spelling, key, chord);
  if (parsed.absolute !== undefined) return parsed.absolute;
  let pitch = nearest(parsed.pitchClass, previous);
  if (above && previous !== undefined) while (pitch <= previous) pitch += 12;
  return pitch + parsed.octaveOffset;
}
function scaleIndex(pitch: number, key: Key): { index: number; accidental: number } {
  const approximate = 7 * Math.floor((pitch - key.tonic - 60) / 12);
  let index = approximate,
    candidate = 60 + scaleTone(key, index);
  for (let i = approximate - 1; i <= approximate + 8; i++) {
    const note = 60 + scaleTone(key, i);
    if (
      Math.abs(note - pitch) < Math.abs(candidate - pitch) ||
      (Math.abs(note - pitch) === Math.abs(candidate - pitch) && note < candidate)
    ) {
      index = i;
      candidate = note;
    }
  }
  return { index, accidental: pitch - candidate };
}
export function shiftPitch(pitch: number, steps: number, key: Key): number {
  const { index, accidental } = scaleIndex(pitch, key);
  return 60 + scaleTone(key, index + steps) + accidental;
}
function numeric(arg?: Argument): number {
  if (arg?.kind !== 'sequence' || arg.elements.length !== 1)
    throw new RangeError('Pitch operation needs one number');
  let e = arg.elements[0];
  while (e.kind === 'group' && e.value.elements.length === 1) e = e.value.elements[0];
  if (e.kind !== 'number' || !Number.isSafeInteger(Number(e.text)))
    throw new RangeError('Pitch interval must be an integer');
  return Number(e.text);
}
export function resolvePitches(
  value: TimedValue,
  key: Key | ((onset: import('@midi-madness/foundation/time').Rational) => Key) = parseKey(),
  chordAt: (onset: import('@midi-madness/foundation/time').Rational) => Chord | undefined = () =>
    undefined,
  absoluteTransposeAt: (onset: import('@midi-madness/foundation/time').Rational) => number = () =>
    0,
  initialPitchAt: (
    onset: import('@midi-madness/foundation/time').Rational,
  ) => number | undefined = () => undefined,
): { value: TimedValue; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [],
    previous = new Map<string, number>(),
    anchors = new Map<string, number>();
  const events = value.events
    .map((e) => ({
      ...e,
      pitchNumbers: [] as number[],
      pitchResolution: [] as { spelling: string; key: string; chord?: string; pitch: number }[],
    }))
    .sort((a, b) => a.onset.compare(b.onset));
  for (const event of events) {
    const identity = JSON.stringify(event.source.literal),
      chord = chordAt(event.onset),
      eventKey = typeof key === 'function' ? key(event.onset) : key;
    let prior = previous.get(identity);
    try {
      for (const [i, spelling] of event.pitches.entries()) {
        let pitch =
          resolvePitch(spelling, eventKey, chord, prior ?? initialPitchAt(event.onset), i > 0) +
          (pitchClass(spelling, eventKey, chord).absolute === undefined
            ? 0
            : absoluteTransposeAt(event.onset));
        prior = pitch; // Octave chaining follows written/resolved notes, before local pitch operations.
        for (const [ordinal, operation] of event.operations.entries()) {
          if (operation.name === 'shift')
            pitch = shiftPitch(pitch, numeric(operation.args[0]), eventKey);
          else if (operation.name === 'transpose') pitch += numeric(operation.args[0]);
          else if (operation.name === 'octave') pitch += 12 * numeric(operation.args[0]);
          else if (operation.name === 'invert') {
            const anchorKey = `${identity}:${ordinal}`;
            if (!anchors.has(anchorKey)) anchors.set(anchorKey, pitch);
            const anchor = scaleIndex(anchors.get(anchorKey)!, eventKey),
              current = scaleIndex(pitch, eventKey);
            pitch = 60 + scaleTone(eventKey, 2 * anchor.index - current.index) - current.accidental;
          }
        }
        event.pitchNumbers.push(pitch);
        event.pitchResolution.push({
          spelling,
          key: `${eventKey.name} ${eventKey.mode}`,
          chord: chord?.symbol,
          pitch,
        });
      }
      if (prior !== undefined) previous.set(identity, prior);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          'R003',
          error instanceof Error ? error.message : 'Invalid pitch',
          event.source.span,
        ),
      );
    }
  }
  return { value: { ...value, events }, diagnostics };
}
