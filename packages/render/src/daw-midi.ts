import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Rational as R } from '@midi-madness/foundation/time';
import { interpolate } from '@midi-madness/foundation/curves';
import { meta, midiFile, type FileEvent } from '../../midi/src/file.ts';
import type { PerformanceData, PerformanceTrack } from './performance.ts';
import type { SynthEvent } from '../../synth/src/engine.ts';
import { seedHash } from '../../synth/src/engine.ts';
import { memberPreset } from '../../synth/src/engine.ts';
import { bindSoftware } from './setup.ts';
import { scheduleControls } from './schedule-controls.ts';
import {
  preparePerformance,
  performanceClock,
  schedulePartHits,
  schedulePartNotes,
} from './performance-input.ts';

export type MidiPerformance = Pick<
  PerformanceData,
  'title' | 'tempoBpm' | 'meter' | 'audio' | 'tracks' | 'score'
>;
export type DawMidiOptions = { cc?: boolean; bendRange?: number; prefix?: string };
const ppq = 32760;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const midiStemPrefix = (filename: string) =>
  `${encodeURIComponent(basename(filename, '.mm'))}-`;
export const dawDrumNotes: Record<string, number> = {
  kick: 36,
  boom: 36,
  snare: 38,
  clap: 39,
  rim: 37,
  hat: 42,
  openhat: 46,
  ride: 51,
  crash: 49,
  shaker: 70,
  'tom-low': 45,
  'tom-high': 50,
  conga: 64,
  cowbell: 56,
  zap: 77,
  noise: 70,
};

/** Compile exactly the software performance inputs without allocating or synthesizing audio. */
export function prepareMidiPerformance(
  source: string,
  filename: string,
  options: Parameters<typeof preparePerformance>[2] = {},
) {
  const { setup, prepared, realized, song } = preparePerformance(source, filename, options);
  const sr = setup.sampleRate,
    { position, offset } = performanceClock(song, sr),
    end = position(song.extent);
  const tracks: PerformanceTrack[] = song.parts
    .filter((p) => !(p.name in prepared.busParts))
    .map((part) => {
      const binding = bindSoftware(
        setup,
        part,
        prepared.sounds[part.name],
        prepared.presetOverrides[part.name],
      );
      const controls = scheduleControls(
        realized,
        part,
        position,
        offset,
        end,
        sr,
        song.tempo.toNumber(),
        prepared.domains[part.name],
      );
      const common = {
        name: part.name,
        kind: part.kind,
        role: part.role,
        preset: binding.preset,
        seed: seedHash(`${song.seed}/${part.name}`),
        mix: binding.mix,
      };
      if (part.lane)
        return {
          ...common,
          lane: part.lane,
          hits: schedulePartHits(part, position, offset, end),
          controls,
        };
      const events: SynthEvent[] = [
        ...controls,
        ...schedulePartNotes(part, binding.preset, prepared, realized, position, offset, end),
      ];
      const order = { set: 0, off: 1, on: 2 };
      events.sort((a, b) => a.sample - b.sample || order[a.type] - order[b.type]);
      return {
        ...common,
        resolved: memberPreset(binding.preset, prepared.presetOverrides[part.name]),
        events,
      };
    });
  const performance: MidiPerformance = {
    title: song.title,
    tempoBpm: song.tempo.toNumber(),
    meter: song.meter,
    audio: {
      file: '',
      sampleRate: sr,
      originSample: 0,
      scoreOffsetSample: offset,
      frames: offset + end,
      channels: 2,
    },
    tracks,
    score: song,
  };
  return { performance, diagnostics: realized.diagnostics };
}

type NoteOn = Extract<SynthEvent, { type: 'on' }>;
type ExportNote = {
  on: NoteOn;
  end: number;
  pitch: number;
  startTick: number;
  endTick: number;
  baseBend: number;
  omitBend?: boolean;
};
type Loss = { part: string; code: string; count: number; message: string; parameters?: string[] };
const ccDefinitions = [
  { parameter: 'cutoff', cc: 74, min: 0, max: 1 },
  { parameter: 'resonance', cc: 71, min: 0, max: 1 },
  { parameter: 'level', cc: 11, min: 0, max: 1 },
  { parameter: 'level.db', cc: 7, min: -60, max: 12 },
  { parameter: 'pan', cc: 10, min: -1, max: 1 },
  { parameter: 'reverb', cc: 91, min: 0, max: 1 },
  { parameter: 'delay', cc: 93, min: 0, max: 1 },
];
function keySignature(key: MidiPerformance['score']['sections'][number]['key']) {
  const modalOffsets: Record<string, number> = {
    major: 0,
    minor: 3,
    'harmonic minor': 3,
    'melodic minor': 3,
    dorian: -2,
    phrygian: -4,
    lydian: -5,
    mixolydian: -7,
    locrian: 1,
  };
  const minor = ['minor', 'harmonic minor', 'melodic minor'].includes(key.mode);
  const pc = (((key.tonic + (modalOffsets[key.mode] ?? 0)) % 12) + 12) % 12;
  let fifths = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5][pc];
  if (key.mode === 'major' && key.name === 'Gb') fifths = -6;
  if (key.mode === 'major' && key.name === 'Cb') fifths = -7;
  if (key.mode === 'major' && key.name === 'C#') fifths = 7;
  return [fifths & 255, minor ? 1 : 0];
}

/** One self-contained SMF per part. The loss report is part of the export contract. */
export function exportPartMidi(
  performance: MidiPerformance,
  directory: string,
  options: DawMidiOptions = {},
) {
  const { audio, score } = performance,
    sr = audio.sampleRate,
    bpm = performance.tempoBpm;
  const tempo = Math.round(60000000 / bpm),
    bendRange = options.bendRange ?? 24;
  if (!Number.isInteger(bendRange) || bendRange < 1 || bendRange > 96)
    throw new RangeError('MIDI bend range must be an integer 1..96 semitones');
  if (tempo < 1 || tempo > 0xffffff) throw new RangeError('Tempo is outside MIDI range');
  if (audio.originSample !== 0)
    throw new RangeError('DAW export requires a full score with its original preroll');
  const tick = (sample: number) => Math.max(0, Math.round((sample * bpm * ppq) / (sr * 60)));
  const endTick = Math.ceil((audio.frames * bpm * ppq) / (sr * 60)),
    secondsPerTick = tempo / (ppq * 1000000);
  const losses = new Map<string, Loss>();
  const loss = (part: string, code: string, message: string, count = 1, parameters?: string[]) => {
    const key = `${part}/${code}/${message}`;
    const old = losses.get(key);
    if (old) {
      old.count += count;
      if (parameters)
        old.parameters = [...new Set([...(old.parameters ?? []), ...parameters])].sort();
    } else
      losses.set(key, {
        part,
        code,
        message,
        count,
        ...(parameters ? { parameters: [...new Set(parameters)].sort() } : {}),
      });
  };
  const conductor: FileEvent[] = [
    { tick: 0, data: meta(1, `Song: ${performance.title}`) },
    { tick: 0, data: meta(81, [(tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255]) },
    { tick: 0, data: meta(88, [performance.meter[0], Math.log2(performance.meter[1]), 24, 8]) },
    { tick: tick(audio.scoreOffsetSample), data: meta(6, 'Bar 1') },
  ];
  if (audio.scoreOffsetSample > 0 && score.sections[0]) {
    const key = score.sections[0].key;
    conductor.push(
      { tick: 0, data: meta(89, keySignature(key)) },
      { tick: 0, data: meta(1, `Key: ${key.name} ${key.mode}`) },
    );
  }
  for (const section of score.sections) {
    const sample =
      Math.round(((section.onset.toNumber() * 240) / bpm) * sr) + audio.scoreOffsetSample;
    conductor.push(
      { tick: tick(sample), data: meta(6, section.label ?? section.name) },
      { tick: tick(sample), data: meta(1, `Key: ${section.key.name} ${section.key.mode}`) },
      { tick: tick(sample), data: meta(89, keySignature(section.key)) },
    );
    if (!['major', 'minor'].includes(section.key.mode))
      loss(
        'score',
        'modal-key',
        'MIDI key signatures cannot encode modes; the signature is accompanied by the full key/mode as text.',
      );
  }
  const bar = new R(...performance.meter);
  for (const section of score.sections) {
    const sectionStart =
      Math.round(((section.onset.toNumber() * 240) / bpm) * sr) + audio.scoreOffsetSample;
    conductor.push({
      tick: tick(sectionStart),
      data: meta(88, [performance.meter[0], Math.log2(performance.meter[1]), 24, 8]),
    });
    const remainder = section.extent.mod(bar);
    if (remainder.numerator > 0n) {
      let denominator = performance.meter[1];
      while (denominator <= 64 && remainder.mul(new R(denominator)).denominator !== 1n)
        denominator *= 2;
      const numerator = Number(remainder.mul(new R(denominator)).numerator);
      if (denominator <= 64 && numerator <= 255) {
        const at = section.onset.add(bar.mul(new R(section.extent.div(bar).floor())));
        conductor.push({
          tick: tick(Math.round(((at.toNumber() * 240) / bpm) * sr) + audio.scoreOffsetSample),
          data: meta(88, [numerator, Math.log2(denominator), 24, 8]),
        });
      } else
        loss(
          'score',
          'partial-meter',
          'A partial bar cannot be encoded as a standard MIDI time signature. Note timing is retained.',
        );
    }
  }
  const sends = [
    ...new Set(
      performance.tracks.flatMap((t) =>
        [...(t.events ?? []), ...(t.controls ?? [])].flatMap((e) =>
          'name' in e && /^send\.[\w-]+$/.test(e.name) ? [e.name] : [],
        ),
      ),
    ),
  ].sort();
  const ccMap = [
    ...ccDefinitions,
    ...sends.slice(0, 12).map((parameter, i) => ({ parameter, cc: 20 + i, min: 0, max: 1 })),
  ];
  const files: {
    part: string;
    file: string;
    notes: number;
    channel: number;
    endTick: number;
    maxTimingErrorMs: number;
  }[] = [];
  mkdirSync(directory, { recursive: true });
  if (options.prefix && /[\/\\]/.test(options.prefix))
    throw new RangeError('MIDI filename prefix must not contain path separators');
  let previousFiles: string[] = [];
  try {
    const previous = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'));
    if (previous.format === 'midi-madness-daw-midi')
      previousFiles = previous.files
        .map((f: { file: string }) => f.file)
        .filter(
          (f: unknown): f is string =>
            typeof f === 'string' && basename(f) === f && f.endsWith('.mid'),
        );
  } catch {
    /* A new output has no previous managed file list. */
  }
  rmSync(join(directory, 'report.json'), { force: true });
  if (!options.cc) rmSync(join(directory, 'cc-map.json'), { force: true });
  for (const track of performance.tracks) {
    const entries: FileEvent[] = [],
      channel = track.lane ? 9 : 0;
    const emit = (sample: number, data: number[], order = 0) =>
      entries.push({ tick: tick(sample), data, order });
    let maxTimingErrorMs = 0;
    const checkTiming = (sample: number, t: number) => {
      maxTimingErrorMs = Math.max(
        maxTimingErrorMs,
        Math.abs(t * secondsPerTick - sample / sr) * 1000,
      );
    };
    entries.push({ tick: 0, data: meta(3, track.name) });
    const raw = track.events ?? [];
    const off = new Map(raw.filter((e) => e.type === 'off').map((e) => [e.id, e.sample]));
    const notes: ExportNote[] = raw
      .filter((e): e is NoteOn => e.type === 'on')
      .map((on) => {
        const rounded = Math.round(on.pitch);
        let pitch = rounded;
        if (pitch < 0) pitch += 12 * Math.ceil(-pitch / 12);
        if (pitch > 127) pitch -= 12 * Math.ceil((pitch - 127) / 12);
        if (pitch !== rounded)
          loss(track.name, 'folded-note', 'Notes outside MIDI 0..127 were octave-folded.');
        const end = Math.min(audio.frames, off.get(on.id) ?? audio.frames),
          startTick = Math.min(endTick - 1, tick(on.sample));
        if (tick(end) <= tick(on.sample))
          loss(
            track.name,
            'note-resolution',
            'A note shorter than the MIDI tick grid was extended to at least one tick.',
          );
        return {
          on,
          end,
          pitch,
          baseBend: on.pitch - rounded,
          startTick,
          endTick: Math.min(endTick, Math.max(startTick + 1, tick(end))),
        };
      })
      .sort((a, b) => a.on.sample - b.on.sample);
    // Connected overlapping notes cannot carry independent bend paths on one channel.
    for (let i = 0; i < notes.length;) {
      let j = i + 1,
        end = notes[i].end;
      while (j < notes.length && notes[j].on.sample < end) {
        end = Math.max(end, notes[j].end);
        j++;
      }
      if (j - i > 1) {
        const group = notes.slice(i, j),
          sameStatic = group.every(
            (n) =>
              n.baseBend === group[0].baseBend &&
              !(n.on.paths ?? []).some((p) => p.name === 'pitch' || p.name === 'cents') &&
              !(n.on.locks?.pitch || n.on.locks?.cents),
          );
        if (!sameStatic) for (const n of group) n.omitBend = true;
        if (!sameStatic)
          loss(
            track.name,
            'polyphonic-bend',
            'Overlapping independent note bends cannot share one MIDI channel; per-note bends in this overlap are omitted. Use audio for the original expression.',
            group.length,
          );
      }
      i = j;
    }
    const controls = (track.lane ? track.controls : raw.filter((e) => e.type === 'set')) ?? [];
    const bends = controls.filter((e) => e.name === 'bend'),
      ranges = controls.filter((e) => e.name === 'bend.range');
    const sampleValue = (items: typeof controls, sample: number, fallback: number) => {
      // Monotonic lanes are small for fixed values; binary search avoids a score-length scan per bend point.
      let lo = 0,
        hi = items.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (items[mid].sample <= sample) lo = mid + 1;
        else hi = mid;
      }
      return lo ? (items[lo - 1].value ?? fallback) : fallback;
    };
    const bendValue = (n: ExportNote, sample: number) => {
      let value = n.omitBend ? 0 : n.baseBend;
      if (!n.omitBend) {
        const locks = { ...n.on.locks };
        for (const path of n.on.paths ?? [])
          if (path.name === 'pitch' || path.name === 'cents')
            locks[path.name] = interpolate(
              path.from,
              path.to,
              (sample - n.on.sample) / Math.max(1, path.samples),
              path.curve,
            );
        value += ((locks.pitch ?? 0) + (locks.cents ?? 0)) / 100;
      }
      return value + sampleValue(bends, sample, 0) * sampleValue(ranges, sample, 2);
    };
    const bendCommands = new Map<number, number>();
    const emitBend = (sample: number, v: number) => {
      if (Math.abs(v) > bendRange)
        loss(
          track.name,
          'bend-clipped',
          `Pitch bend exceeds ±${bendRange} semitones and was clipped.`,
        );
      const value = Math.round(8192 + clamp(v / bendRange, -1, 1) * (v < 0 ? 8192 : 8191));
      bendCommands.set(sample, value);
    };
    if (!track.lane) {
      // RPN 0: pitch bend sensitivity. No program selection or hardware initialization.
      for (const [cc, value] of [
        [101, 0],
        [100, 0],
        [6, bendRange],
        [38, 0],
        [101, 127],
        [100, 127],
      ])
        emit(0, [0xb0 | channel, cc, value], -3);
      const pitchEnds = new Map<number, number>();
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        let lo = i + 1,
          hi = notes.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (notes[mid].on.sample <= n.on.sample) lo = mid + 1;
          else hi = mid;
        }
        const next = notes[lo];
        if (next && n.end > next.on.sample && n.end <= next.on.sample + 1)
          n.endTick = Math.min(endTick, Math.max(n.endTick, next.startTick + 1));
        entries.push(
          {
            tick: n.startTick,
            data: [0x90 | channel, n.pitch, clamp(Math.round(n.on.velocity * 127), 1, 127)],
            order: 1,
          },
          { tick: n.endTick, data: [0x80 | channel, n.pitch, 0], order: -2 },
        );
        checkTiming(n.on.sample, n.startTick);
        checkTiming(n.end, n.endTick);
        const expressive =
          !!n.baseBend ||
          !!n.on.locks?.pitch ||
          !!n.on.locks?.cents ||
          (n.on.paths ?? []).some((p) => p.name === 'pitch' || p.name === 'cents') ||
          bends.length > 0;
        emitBend(n.on.sample, bendValue(n, n.on.sample));
        if (expressive) {
          const samples = new Set<number>([n.on.sample, Math.max(n.on.sample, n.end - 1)]);
          for (let s = n.on.sample; s < n.end; s += Math.round(sr / 250)) samples.add(s);
          for (const lane of [bends, ranges]) {
            let lo = 0,
              hi = lane.length;
            while (lo < hi) {
              const mid = (lo + hi) >>> 1;
              if (lane[mid].sample < n.on.sample) lo = mid + 1;
              else hi = mid;
            }
            for (let k = lo; k < lane.length && lane[k].sample < n.end; k++)
              samples.add(lane[k].sample);
          }
          for (const path of n.on.paths ?? [])
            if (n.on.sample + path.samples < n.end) samples.add(n.on.sample + path.samples);
          for (const sample of [...samples].sort((a, b) => a - b))
            emitBend(sample, bendValue(n, sample));
        }
        if (n.on.grainSamples)
          loss(
            track.name,
            'grain-window',
            'Grains are exported as short notes; grain windows, voice allocation and timbre require the audio stem.',
          );
        const paths = (n.on.paths ?? []).filter((p) => p.name !== 'pitch' && p.name !== 'cents');
        if (paths.length)
          loss(
            track.name,
            'note-control-path',
            'Per-note non-pitch paths are not represented by channel CC lanes.',
            paths.length,
            paths.map((p) => p.name),
          );
        const locks = Object.keys(n.on.locks ?? {}).filter((k) => k !== 'pitch' && k !== 'cents');
        if (
          locks.length ||
          n.on.pan !== undefined ||
          (n.on.sends && Object.keys(n.on.sends).length)
        )
          loss(
            track.name,
            'note-controls',
            'Voice-local locks, pan and sends are not reproduced as per-note MIDI expression.',
            1,
            [
              ...locks,
              ...(n.on.pan === undefined ? [] : ['pan']),
              ...Object.keys(n.on.sends ?? {}).map((k) => `send.${k}`),
            ],
          );
        if ((pitchEnds.get(n.pitch) ?? -1) > n.on.sample)
          loss(
            track.name,
            'same-pitch-overlap',
            'Repeated overlapping notes on one MIDI pitch depend on the receiving instrument note-off behavior.',
          );
        pitchEnds.set(n.pitch, Math.max(pitchEnds.get(n.pitch) ?? 0, n.end));
      }
      let previousBend: number | undefined;
      for (const [sample, value] of [...bendCommands].sort((a, b) => a[0] - b[0])) {
        if (value !== previousBend)
          emit(sample, [0xe0 | channel, value & 127, (value >> 7) & 127], -1);
        previousBend = value;
      }
      emit(audio.frames, [0xe0 | channel, 0, 64], 2);
    } else {
      const mapped = dawDrumNotes[track.lane];
      if (mapped === undefined) throw new RangeError(`No GM mapping for drum lane ${track.lane}`);
      if (['boom', 'zap', 'noise'].includes(track.lane))
        loss(
          track.name,
          'drum-timbre',
          `${track.lane} uses approximate GM note ${mapped}; use the stem for its original sound.`,
        );
      loss(
        track.name,
        'drum-articulation',
        'GM notes are trigger approximations; rendered retrigger envelopes, open/closed-hat chokes and release lengths remain in the audio stem.',
      );
      for (const hit of track.hits ?? []) {
        const t = tick(hit.sample),
          end = Math.min(endTick, Math.max(t + 1, tick(hit.sample + sr * 0.03)));
        entries.push(
          {
            tick: t,
            data: [0x99, mapped, clamp(Math.round(hit.velocity * 127), 1, 127)],
            order: 1,
          },
          { tick: end, data: [0x89, mapped, 0], order: -2 },
        );
        checkTiming(hit.sample, t);
        if (Object.keys(hit.locks).length)
          loss(
            track.name,
            'drum-controls',
            'Drum timbre, pitch/envelope locks and chokes are approximated by GM trigger notes.',
            1,
            Object.keys(hit.locks),
          );
      }
    }
    const previousCc = new Map<number, number>();
    for (const e of controls) {
      if (e.name === 'bend' || e.name === 'bend.range') continue;
      const mapping = ccMap.find((c) => c.parameter === e.name);
      if (!options.cc || !mapping) {
        loss(
          track.name,
          'unexported-control',
          `Software controls without an enabled CC mapping are retained only in audio (including ${e.name}).`,
        );
        continue;
      }
      if (e.value === null) {
        loss(
          track.name,
          'cc-reset',
          `Null ${e.name} controls restore a software preset default; no arbitrary MIDI value is substituted.`,
        );
        continue;
      }
      const value = clamp(
        Math.round(((e.value - mapping.min) / (mapping.max - mapping.min)) * 127),
        0,
        127,
      );
      if (previousCc.get(mapping.cc) !== value) {
        emit(e.sample, [0xb0 | channel, mapping.cc, value]);
        previousCc.set(mapping.cc, value);
      }
    }
    loss(
      track.name,
      'sound-design',
      'MIDI does not contain the synth/drum patch, inserts, shared effects, modulation DSP or rendered voice stealing. The audio stem preserves the sound.',
    );
    const file = join(directory, `${options.prefix ?? ''}${encodeURIComponent(track.name)}.mid`);
    writeFileSync(file, midiFile([[...conductor, ...entries]], endTick, ppq));
    files.push({
      part: track.name,
      file: basename(file),
      notes: track.lane ? (track.hits?.length ?? 0) : notes.length,
      channel: channel + 1,
      endTick,
      maxTimingErrorMs,
    });
  }
  const report = {
    version: 1,
    format: 'midi-madness-daw-midi',
    title: performance.title,
    ppq,
    meter: performance.meter,
    keys: score.sections.map((s) => ({
      section: s.label ?? s.name,
      key: `${s.key.name} ${s.key.mode}`,
    })),
    tempoBpm: bpm,
    microsecondsPerQuarter: tempo,
    encodedTempoBpm: 60000000 / tempo,
    tempoRoundingDriftMs: (audio.frames / sr) * Math.abs(tempo / (60000000 / bpm) - 1) * 1000,
    bendRangeSemitones: bendRange,
    pitchPathSamplingHz: 250,
    pitchBendResolutionCents: (bendRange * 100) / 8191,
    audio: { sampleRate: sr, frames: audio.frames, scoreOffsetSample: audio.scoreOffsetSample },
    endTick,
    durationSeconds: endTick * secondsPerTick,
    durationErrorMs: Math.abs(endTick * secondsPerTick - audio.frames / sr) * 1000,
    quantizationBoundMs: secondsPerTick * 1000,
    cc: options.cc ? ccMap : [],
    files,
    losses: [...losses.values()],
  };
  for (const file of previousFiles)
    if (!files.some((f) => f.file === file)) rmSync(join(directory, file), { force: true });
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (options.cc)
    writeFileSync(
      join(directory, 'cc-map.json'),
      JSON.stringify(
        {
          version: 1,
          meaning:
            '7-bit normalized automation; configure the destination instrument manually. Parameter scaling is not a recreated patch.',
          parameters: ccMap,
        },
        null,
        2,
      ) + '\n',
    );
  return report;
}
