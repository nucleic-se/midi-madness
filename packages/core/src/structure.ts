import type { Expression, Sequence } from './ast.ts';
import { diagnostic, type Diagnostic } from './diag.ts';
import { expandSequence } from './expand.ts';
import type { Bar, Frame, Settings, Structure } from './ir.ts';
import { parseKey, type Key } from './pitch.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import type { Resolution } from './resolve.ts';
import { emptyTimed, sequenceTimed } from './timed.ts';
const zero = new R(0);
export function modulateKey(key: Key, semitones: number): Key {
  const tonic = (((key.tonic + semitones) % 12) + 12) % 12;
  return {
    ...key,
    tonic,
    name: ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][tonic],
  };
}
export function settingsFrom(resolution: Resolution): Settings {
  const settings: Settings = {
    title: 'Untitled',
    tempo: new R(100),
    meter: [4, 4],
    key: parseKey(),
    seed: 1n,
    humanizeMs: new R(4),
    dynamics: 'energy',
  };
  const song = resolution.ast.statements.find((s) => s.kind === 'song');
  if (song?.kind === 'song') {
    settings.title = song.title;
    for (const f of song.fields)
      if (f.value.kind === 'clause') {
        const tokens = f.value.tokens;
        if (f.name === 'tempo') settings.tempo = R.parse(tokens[0]);
        if (f.name === 'seed') settings.seed = BigInt(tokens[0]);
        if (f.name === 'meter') {
          const [n, d] = tokens[0].split('/').map(Number);
          settings.meter = [n, d];
        }
        if (f.name === 'key') settings.key = parseKey(tokens.join(' '));
        if (f.name === 'humanize')
          settings.humanizeMs = tokens[0] === 'off' ? zero : R.parse(tokens[0]);
        if (f.name === 'dynamics') settings.dynamics = tokens[0] === 'flat' ? 'flat' : 'energy';
      }
  }
  return settings;
}
function integer(e: Expression): number {
  if (e.kind === 'group' && e.value.elements.length === 1) return integer(e.value.elements[0]);
  if (e.kind === 'number' && Number.isSafeInteger(Number(e.text))) return Number(e.text);
  throw new RangeError('Modulation requires integer semitones');
}
function origin(e: Expression): Expression['origin'] {
  return (
    e.origin ??
    (e.kind === 'operation'
      ? origin(e.receiver)
      : e.kind === 'label'
        ? origin(e.value)
        : e.kind === 'group' && e.value.elements.length === 1
          ? origin(e.value.elements[0])
          : undefined)
  );
}
function modulation(e: Expression): number {
  return e.kind === 'operation'
    ? modulation(e.receiver) +
        (e.name === 'modulate' && e.args[0]?.kind === 'sequence'
          ? integer(e.args[0].elements[0])
          : 0)
    : e.kind === 'label'
      ? modulation(e.value)
      : e.kind === 'group' && e.value.elements.length === 1
        ? modulation(e.value.elements[0])
        : 0;
}
export function buildStructure(resolution: Resolution): {
  structure?: Structure;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  try {
    const settings = settingsFrom(resolution),
      bar = new R(settings.meter[0], settings.meter[1]);
    if (settings.tempo.compare(zero) <= 0 || bar.compare(zero) <= 0)
      throw new RangeError('Tempo and meter must be positive');
    const forms = resolution.normalized.statements.filter((s) => s.kind === 'form');
    if (forms.length !== 1)
      return {
        diagnostics: [
          diagnostic(
            forms.length ? 'R004' : 'R003',
            'Song realization requires exactly one form',
            resolution.ast.span,
          ),
        ],
      };
    const form = forms[0];
    if (form.kind !== 'form') throw new Error('Unreachable form');
    const sections: Frame[] = [],
      frames: Frame[] = [],
      counts = new Map<string, number>(),
      material = [];
    let onset = zero;
    function value(e: Expression, key: Key, address: (string | number)[]) {
      const result = expandSequence({ kind: 'sequence', elements: [e], span: e.span }, 'notes', {
        meter: settings.meter,
        key,
        seed: settings.seed,
        address,
      });
      diagnostics.push(...result.diagnostics);
      return result.value ?? emptyTimed('notes');
    }
    function children(e: Expression, start: R, path: string, key: Key, mod: number): Frame[] {
      if (e.kind === 'label') return children(e.value, start, path, key, mod);
      if (e.kind === 'operation') {
        const result = children(e.receiver, start, path, key, mod);
        const base = value(e.receiver, key, [path]).extent,
          transformed = value(e, key, [path]).extent;
        const factor = base.equals(zero) ? new R(1) : transformed.div(base);
        if (['fast', 'slow', 'fit'].includes(e.name)) {
          const transform = (frame: Frame): void => {
            frame.onset = start.add(frame.onset.sub(start).mul(factor));
            frame.extent = frame.extent.mul(factor);
            frame.children.forEach(transform);
          };
          result.forEach(transform);
        }
        return result;
      }
      if (e.kind !== 'group') return [];
      const output: Frame[] = [],
        seen = new Map<string, number>();
      let time = start;
      for (const term of e.value.elements) {
        const info = origin(term),
          span = value(term, key, [path]).extent;
        if (info) {
          const name = term.kind === 'label' ? term.name : info.name,
            n = (seen.get(name) ?? 0) + 1;
          seen.set(name, n);
          const frame: Frame = {
            name,
            kind: info.kind,
            path: `${path}/${name}#${n}`,
            ordinal: n,
            onset: time,
            extent: span,
            modulation: mod,
            key,
            source: term.span,
            expression: term,
            children: children(term, time, `${path}/${name}#${n}`, key, mod),
            label: term.kind === 'label' ? term.name : undefined,
          };
          output.push(frame);
          frames.push(frame);
        }
        time = time.add(span);
      }
      return output;
    }
    for (const term of form.value.elements) {
      const info = origin(term);
      if (info?.kind !== 'section') {
        diagnostics.push(diagnostic('R003', 'form requires section references', term.span));
        continue;
      }
      const name = term.kind === 'label' ? term.name : info.name,
        n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      const mod = modulation(term),
        key = modulateKey(settings.key, mod),
        path = `form/${name}#${n}`;
      const expanded = value(term, key, [path]);
      const frame: Frame = {
        name,
        sectionName: info.name,
        kind: 'section',
        path,
        ordinal: n,
        onset,
        extent: expanded.extent,
        modulation: mod,
        key,
        source: term.span,
        expression: term,
        children: children(term, onset, path, key, mod),
        label: term.kind === 'label' ? term.name : undefined,
      };
      sections.push(frame);
      frames.push(frame);
      material.push(expanded);
      onset = onset.add(frame.extent);
    }
    const bars: Bar[] = [];
    for (const section of sections)
      for (let t = zero, n = 1; t.compare(section.extent) < 0; t = t.add(bar), n++) {
        const left = section.extent.sub(t);
        bars.push({
          number: bars.length + 1,
          sectionBar: n,
          onset: section.onset.add(t),
          span: left.compare(bar) < 0 ? left : bar,
          section: section.name,
          path: section.path,
        });
      }
    return {
      structure: {
        settings,
        extent: onset,
        sections,
        frames,
        bars,
        material: sequenceTimed(material, 'notes'),
      },
      diagnostics,
    };
  } catch (error) {
    if (error instanceof RangeError || error instanceof SyntaxError)
      return { diagnostics: [diagnostic('R003', error.message, resolution.ast.span)] };
    throw error;
  }
}
export function sectionAt(structure: Structure, time: R): Frame | undefined {
  return structure.sections.find(
    (s) => time.compare(s.onset) >= 0 && time.compare(s.onset.add(s.extent)) < 0,
  );
}
export function keyAt(structure: Structure, time: R): Key {
  return sectionAt(structure, time)?.key ?? structure.settings.key;
}
