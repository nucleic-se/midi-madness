import type { Structure } from './ir.ts';
import { diagnostic, type Diagnostic } from './diag.ts';
import { expandSequence } from './expand.ts';
import { keyAt } from './structure.ts';
import { parseChord, type Chord } from './pitch.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import type { Resolution } from './resolve.ts';
export type HarmonyLayer = {
  start: R;
  extent: R;
  priority: number;
  chords: { onset: R; span: R; symbol: string }[];
  source: import('./diag.ts').Span;
  path: string;
};
export function installHarmony(
  resolution: Resolution,
  structure: Structure,
): { layers: HarmonyLayer[]; diagnostics: Diagnostic[]; chordAt: (time: R) => Chord } {
  const diagnostics: Diagnostic[] = [],
    layers: HarmonyLayer[] = [];
  const statements = resolution.normalized.statements.filter((s) => s.kind === 'harmony');
  for (const section of [
    ...structure.sections,
    ...structure.frames.filter((frame) => frame.kind !== 'section' && frame.label),
  ]) {
    const matches = statements.filter(
      (s) =>
        s.kind === 'harmony' &&
        ((section.kind === 'section' && !s.targets.length) ||
          s.targets.includes(section.name) ||
          s.targets.includes(section.sectionName!)),
    );
    matches.sort(
      (a, b) =>
        (a.kind === 'harmony' && !a.targets.length
          ? 0
          : a.kind === 'harmony' && a.targets.includes(section.label ?? '')
            ? 2
            : 1) -
        (b.kind === 'harmony' && !b.targets.length
          ? 0
          : b.kind === 'harmony' && b.targets.includes(section.label ?? '')
            ? 2
            : 1),
    );
    const selected = matches.at(-1);
    if (selected?.kind !== 'harmony') continue;
    const literal: import('./ast.ts').Expression = {
      kind: 'group',
      value: selected.value,
      span: selected.value.span,
    };
    const loop: import('./ast.ts').Expression = {
      kind: 'operation',
      name: 'loop',
      receiver: literal,
      args: [
        {
          kind: 'sequence',
          elements: [{ kind: 'number', text: section.extent.toString(), span: selected.span }],
          span: selected.span,
        },
      ],
      span: selected.span,
    };
    const result = expandSequence(
      { kind: 'sequence', elements: [loop], span: selected.span },
      'harmony',
      {
        meter: structure.settings.meter,
        key: section.key,
        seed: structure.settings.seed,
        address: [section.path, 'harmony'],
      },
    );
    diagnostics.push(...result.diagnostics);
    if (result.value) {
      for (const chord of result.value.chords) {
        try {
          parseChord(chord.symbol, keyAt(structure, section.onset.add(chord.onset)));
        } catch (error) {
          diagnostics.push(diagnostic('H001', String(error), chord.source, { path: section.path }));
        }
      }
      layers.push({
        start: section.onset,
        extent: section.extent,
        priority: section.label ? 100 + section.path.split('/').length : 1,
        chords: result.value.chords.map((c) => ({ ...c, onset: c.onset.add(section.onset) })),
        source: selected.span,
        path: section.path,
      });
    }
  }
  const chordAt = (time: R): Chord => {
    const key = keyAt(structure, time),
      layer = layers
        .filter((l) => time.compare(l.start) >= 0 && time.compare(l.start.add(l.extent)) < 0)
        .sort((a, b) => b.priority - a.priority)[0];
    const chord = layer?.chords.find(
      (c) => time.compare(c.onset) >= 0 && time.compare(c.onset.add(c.span)) < 0,
    );
    const tonic = key.scale[4] === 6 ? 'io' : key.scale[2] === 3 ? 'i' : 'I';
    try {
      return parseChord(layer ? (chord?.symbol ?? 'N') : tonic, key);
    } catch (error) {
      return parseChord('N', key);
    }
  };
  return { layers, diagnostics, chordAt };
}
export function voiceLead(
  chord: Chord,
  range: readonly [number, number],
  previous?: number[],
  voices = chord.tones.length >= 4 ? 4 : 3,
): number[] {
  if (chord.root === null) return [];
  const pcs = chord.tones.slice(0, voices),
    candidates: number[] = [];
  for (let n = range[0]; n <= range[1]; n++)
    if (pcs.includes(((n % 12) + 12) % 12)) candidates.push(n);
  let best: number[] | undefined,
    bestCost = Infinity;
  function search(notes: number[], start: number): void {
    if (notes.length === voices) {
      if (new Set(notes.map((n) => ((n % 12) + 12) % 12)).size < Math.min(voices, pcs.length))
        return;
      const cost = previous
        ? notes.reduce(
            (sum, n, i) => sum + (previous[i] === undefined ? 0 : Math.abs(n - previous[i])),
            0,
          )
        : notes[0] * 128 + notes.at(-1)! - notes[0];
      if (
        cost < bestCost ||
        (cost === bestCost &&
          (!best ||
            notes.some(
              (n, i) =>
                n !== best![i] && n < best![i] && notes.slice(0, i).every((p, j) => p === best![j]),
            )))
      ) {
        best = [...notes];
        bestCost = cost;
      }
      return;
    }
    for (let i = start; i < candidates.length; i++) search([...notes, candidates[i]], i + 1);
  }
  search([], 0);
  return best ?? [];
}
