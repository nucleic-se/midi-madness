import { reserved } from '../../../core/src/lexer.ts';
import { readFileSync } from 'node:fs';
import { PRELUDE_SOURCE } from '../../../core/src/prelude.ts';
const syntax = readFileSync(
  new URL('../../../../docs/reference/LANGUAGE.md', import.meta.url),
  'utf8',
);
const tooling = readFileSync(
  new URL('../../../../docs/reference/TOOLING.md', import.meta.url),
  'utf8',
);
const instruments = readFileSync(
  new URL('../../../../docs/reference/INSTRUMENTS.md', import.meta.url),
  'utf8',
);
export function help(topic = '') {
  const midiHelp: Record<string, string> = {
    names: `Names use letters, digits, underscores and hyphens, starting with a letter.\nReserved grammar words: ${[...reserved].sort().join(', ')}.\nBuilt-in prelude functions: ${[
      ...PRELUDE_SOURCE.matchAll(/^define ([\w-]+)\(/gm),
    ]
      .map((m) => m[1])
      .sort()
      .join(
        ', ',
      )}.\nBindings, functions, named conditions and curves share a namespace with prelude definitions and cannot redefine them. Parts have a separate namespace. See mm help prelude for definitions.`,
    include:
      'include "gen/part.body.mmi"\nTextually include a fragment before compilation. Indentation is added; nested paths and data lanes are relative to their containing file. Fragments cannot contain mm 1 or song blocks. Diagnostics retain original file locations.',
    expand:
      'mm expand song.mm\nPrint the include-expanded score, with resolved data paths. --json includes dependency hashes. Use --to section for form inspection.',
    feedback:
      'mm feedback song.mm "listening note" [--at 1:40|"bar 41"]\nRecords the original bar/section, sounding members and a source snapshot in song.mm.feedback.json. With no text, lists notes and marks older score versions. Read this ledger before revising a song.',
    template:
      'template NAME(n: number, note: notes):\n  plays notes | note . note . |\n\nfor n, note in [0 G3, 1 A3, 2 B3]:\n  part bell-{n} = NAME(n, note)\n\nLoad-time expansion produces ordinary parts with template provenance. Use literal row lists; no runtime loops.',
    per: 'cutoff = per 2 bars: 0.2, 0.8\ncutoff = per 2 bars smooth: 0.2, 0.8\nplays hits beat.fast(per 1 bar: 1, 2, 1.5, 1)\n\nConstant scalar values hold for the given span and loop from the use reset. Smooth interpolates, including the wrap. Pattern rates are sampled at cycle starts and restart at step boundaries.',
    render:
      'mm render song.mm [--setup setups/band/band.setup] [--from section|bar N --bars N] [--solo part,part] [--mute part,part] [--out mix.wav] [--tail seconds] [--stems-by group|part] [--events-envelopes full|none] [--events-parts part,part] [--analysis] [--no-analysis]\nWrites a 48kHz draft WAV (stereo by default; optional binaural or first-order ambisonic) and minimal reports to renders/<song>/. --stems-by part captures dry parts and complete bus returns with level/band measurements in one synthesis pass. --events-envelopes none skips recorded envelopes; --events-parts selects event tracks without changing audio. --analysis adds stems, spectrograms and per-bar RMS/peak measurements. Software only; no MIDI port required.',
    pack: 'mm pack song.mm --out pack-directory [--setup software.setup] [--tail seconds] [--cc] [--bend-range semitones]\nWrites aligned dry stems, bus returns, MIDI, draft mix and import notes.',
    export:
      'mm export song.mm [--setup studio.setup] --midi song.mid\nWithout setup: notes only, pitched channels skip 10, GM drums on 10.\nmm export song.mm --midi-dir pack/midi [--cc] [--bend-range semitones]\nHardware-free per-part MIDI uses the software performance; --setup here selects an optional software setup. Reports list representation losses.',
    ports: 'mm ports [--json]\nLists exact MIDI output names without opening them.',
    play: 'mm play song.mm --setup studio.setup [--from bar N | --bars A..B] [--loop] [--clock send|off]\nPresets and overrides run once at startup. Range entry chases controllers, skips carry-in notes. Ctrl-C stops and exits 130.',
    panic:
      'mm panic --setup studio.setup\nSends all-notes-off, all-sound-off and explicit note-offs on configured channels.',
    acid: 'Mono articulation uses explicit note lengths and overlaps for legato; velocity controls accents. Use mm help alias acid --setup studio.setup to inspect the configured MIDI mapping. Software controls are documented in the renderer instrument guide.',
    alias:
      'mm help alias <name> --setup studio.setup\nShows the resolved instrument, output, channel and mapped parameters without opening MIDI.',
    primitives: readFileSync(new URL('../../../render/PRIMITIVES.md', import.meta.url), 'utf8'),
    spatial: readFileSync(new URL('../../../render/SPATIAL.md', import.meta.url), 'utf8'),
    literal: readFileSync(
      new URL('../../../../docs/reference/LITERAL_V1.md', import.meta.url),
      'utf8',
    ),
    'instrument-params': readFileSync(
      new URL('../../../render/INSTRUMENT_PARAMS.md', import.meta.url),
      'utf8',
    ),
    instruments: instruments,
    setup: instruments,
  };
  if (midiHelp[topic]) return { topic, text: midiHelp[topic], related: Object.keys(midiHelp) };
  const topics = [
    'check',
    'expand',
    'roll',
    'explain',
    'at',
    'metrics',
    'query',
    'accept',
    'diff',
    'format',
    'fix',
    'schema',
    'plays',
    'conditions',
    'signals',
    'chords',
    'pitch',
    'operations',
    'timing',
    'prelude',
  ];
  if (!topic)
    return {
      topic: 'index',
      topics: [...topics, ...Object.keys(midiHelp)],
      text: `mm <command> <song.mm> [--json]\n\nCommands: ${topics.slice(0, 12).join(', ')}, render, export, pack, ports, play, panic\n\nHelp also accepts instruments, setup, language keywords, operations, fields, diagnostic codes and prelude function names.`,
    };
  const definitions = PRELUDE_SOURCE.split(/(?=^define )/m),
    prelude = definitions.find((d) => d.startsWith(`define ${topic}(`));
  if (prelude)
    return {
      topic,
      text: prelude.trim(),
      source: prelude.trim(),
      related: ['prelude', 'functions'],
    };
  if (topic === 'prelude') return { topic, text: PRELUDE_SOURCE, source: PRELUDE_SOURCE };
  const aliases: Record<string, string> = {
    plays: '## 12. Parts',
    conditions: '## 11. Conditions',
    signals: '## 10. Curves',
    chords: '## 9. Harmony',
    pitch: '### 6.3 Pitch',
    'chord-tones': '### 6.3 Pitch',
    operations: '## 7. Operations',
    timing: '## 6. Timed',
    'timing.slots': '### 6.7 No silent',
  };
  const document =
    /^[A-Z]\d{3}$/.test(topic) || topics.slice(0, 12).includes(topic) ? tooling : syntax;
  const sections = document.split(/(?=^#{2,3} )/m),
    selected = sections.find((s) =>
      aliases[topic]
        ? s.startsWith(aliases[topic])
        : s.includes(`\`${topic}\``) || s.includes(`\`.${topic}`),
    );
  if (!selected) throw new RangeError(`Unknown help topic ${topic}`);
  return { topic, text: selected.trim(), related: topics.slice(-8) };
}
export function schema(command: string) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `mm ${command} output`,
    type: 'object',
    required: ['schemaVersion', 'command', 'file', 'engine', 'result', 'diagnostics', 'summary'],
    properties: {
      schemaVersion: { const: '1' },
      command: { const: command },
      file: { type: 'string' },
      engine: { type: 'string' },
      result: {
        description: `${command} result; rational times are normalized p/q strings`,
        type: ['object', 'array'],
      },
      diagnostics: {
        type: 'array',
        items: {
          type: 'object',
          required: ['code', 'severity', 'message', 'span', 'causes', 'fixes', 'help'],
          properties: {
            code: { type: 'string' },
            severity: { enum: ['error', 'warning', 'info'] },
            message: { type: 'string' },
            span: { type: 'object', required: ['line', 'col', 'endLine', 'endCol'] },
            measured: { type: 'object' },
            path: { type: 'string' },
            causes: { type: 'array' },
            fixes: { type: 'array' },
            help: { type: 'string' },
          },
        },
      },
      summary: {
        type: 'object',
        required: ['errors', 'warnings', 'infos'],
        properties: {
          errors: { type: 'integer' },
          warnings: { type: 'integer' },
          infos: { type: 'integer' },
        },
      },
    },
  };
}
