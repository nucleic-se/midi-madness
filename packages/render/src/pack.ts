import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { LoadedScore } from '../../core/src/include.ts';
import { renderSong } from './render.ts';
import { exportPartMidi, midiStemPrefix, type DawMidiOptions } from './daw-midi.ts';
import type { PerformanceData } from './performance.ts';

function wavInfo(file: string) {
  const bytes = Buffer.alloc(44);
  const fd = openSync(file, 'r');
  try {
    if (readSync(fd, bytes, 0, 44, 0) !== 44) throw new Error(`Incomplete WAV header: ${file}`);
  } finally {
    closeSync(fd);
  }
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`Invalid pack WAV ${file}`);
  const stride = bytes.readUInt16LE(32),
    frames = bytes.readUInt32LE(40) / stride;
  if (statSync(file).size !== 44 + frames * stride) throw new Error(`Truncated pack WAV ${file}`);
  return {
    sampleRate: bytes.readUInt32LE(24),
    frames,
    bits: bytes.readUInt16LE(34),
    format: bytes.readUInt16LE(20),
  };
}

/** A transaction: validate the complete pack before exposing its final directory. */
export function packSong(
  source: string,
  filename: string,
  options: DawMidiOptions & {
    out: string;
    score?: LoadedScore;
    setup?: string;
    tail?: number;
    progress?: (s: string) => void;
  },
) {
  const out = resolve(options.out);
  if (existsSync(out) && readdirSync(out).length)
    throw new RangeError('Pack output must be a new or empty directory');
  if (
    options.bendRange !== undefined &&
    (!Number.isInteger(options.bendRange) || options.bendRange < 1 || options.bendRange > 96)
  )
    throw new RangeError('MIDI bend range must be an integer 1..96 semitones');
  mkdirSync(dirname(out), { recursive: true });
  const temporary = mkdtempSync(join(dirname(out), '.mm-pack-'));
  try {
    let performance: PerformanceData | undefined;
    const prefix = midiStemPrefix(filename);
    const rendered = renderSong(source, filename, {
      score: options.score,
      setup: options.setup,
      out: join(temporary, 'stems', 'mix.wav'),
      tail: options.tail,
      stemsBy: 'part',
      stemPrefix: prefix,
      progress: options.progress,
      capturePerformance: (data) => {
        performance = data;
      },
    });
    if (!performance) throw new Error('Render did not capture its performance');
    renameSync(rendered.destination, join(temporary, 'mix.wav'));
    renameSync(rendered.performancePath!, join(temporary, 'mix.events.json'));
    const midi = exportPartMidi(performance, join(temporary, 'midi'), { ...options, prefix });
    const partStems = rendered.report.partStems;
    const busStems = rendered.report.busStems;
    if (!partStems || !busStems) throw new Error('Render did not produce part and return stems');
    const audioFiles = [
      join(temporary, 'mix.wav'),
      ...partStems.members.map((m) => m.file),
      ...busStems.members.map((m) => m.file),
    ];
    const expected = wavInfo(audioFiles[0]);
    for (const file of audioFiles) {
      const info = wavInfo(file);
      if (info.frames !== expected.frames || info.sampleRate !== expected.sampleRate)
        throw new Error(`Pack audio alignment mismatch: ${file}`);
      if (info.bits !== 24 && !(info.bits === 32 && info.format === 3))
        throw new Error('Pack WAV must be 24-bit PCM or 32-bit float');
    }
    for (const file of midi.files) {
      const stem = partStems.members.find((m) => m.name === file.part);
      if (!stem || basename(stem.file, '.wav') !== basename(file.file, '.mid'))
        throw new Error(`MIDI/stem name mismatch for ${file.part}`);
      if (file.endTick !== midi.endTick) throw new Error('MIDI durations differ');
    }
    const tolerance = midi.tempoRoundingDriftMs + midi.quantizationBoundMs * 2;
    if (midi.files.some((f) => f.maxTimingErrorMs > tolerance))
      throw new Error('MIDI note timing exceeds its reported rounding tolerance');
    if (midi.durationErrorMs > tolerance)
      throw new Error('MIDI/audio duration exceeds its reported rounding tolerance');
    const sections = performance.score.sections.map((s) => ({
      name: s.label ?? s.name,
      path: s.path,
      startBar: performance!.score.bars.find((b) => b.onset.equals(s.onset))?.number ?? null,
      scoreSeconds: (s.onset.toNumber() * 240) / performance!.tempoBpm,
      audioSeconds:
        (s.onset.toNumber() * 240) / performance!.tempoBpm +
        performance!.audio.scoreOffsetSample / performance!.audio.sampleRate,
      key: `${s.key.name} ${s.key.mode}`,
    }));
    const portable = (stems: typeof partStems) => ({
      ...stems,
      members: stems.members.map((m) => ({ ...m, file: relative(temporary, m.file) })),
    });
    const manifest = {
      version: 1,
      format: 'midi-madness-remix-pack',
      title: performance.title,
      tempoBpm: performance.tempoBpm,
      meter: performance.meter,
      scoreHash: performance.scoreHash,
      rendererHash: performance.rendererHash,
      audio: { ...performance.audio, file: 'mix.wav' },
      mix: {
        ...expected,
        file: 'mix.wav',
        meaning: 'Draft reference with the renderer safety clamp; not a mastered mix',
      },
      parts: portable(partStems),
      busReturns: portable(busStems),
      midi,
      sections,
      alignment: {
        verified: true,
        origin:
          'Common file time zero; retain leading silence. Bar 1 is at audio.scoreOffsetSample.',
        durationToleranceMs: tolerance,
      },
      safety: rendered.report.safety,
      warnings: rendered.report.warnings,
    };
    writeFileSync(join(temporary, 'pack.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(
      join(temporary, 'sound-sheet.json'),
      JSON.stringify(
        {
          version: 1,
          meaning: 'Software settings for reference; not Ableton presets or automatic mappings.',
          tracks: performance.tracks.map((t) => ({
            name: t.name,
            preset: t.preset,
            lane: t.lane,
            mix: t.mix,
            resolved: t.resolved,
            initialControls: t.initialControls,
            inserts: performance!.settings.inserts[t.name],
          })),
          buses: performance.buses,
        },
        null,
        2,
      ) + '\n',
    );
    const key = sections[0]?.key ?? 'unspecified';
    const readme =
      `# ${performance.title}\n\nTempo: ${performance.tempoBpm} BPM. Meter: ${performance.meter.join('/')}. Initial key: ${key}.\n\n` +
      `Import the mix and all stems at the same Arrangement position, with audio warping disabled. Retain leading silence. File time zero is common to every file; score bar 1 is ${(performance.audio.scoreOffsetSample / expected.sampleRate).toFixed(6)} seconds into the files.\n\n` +
      `MIDI files contain tempo information. Accept the tempo on the first import, then keep the same Set tempo for the remaining files. A full-length file does not guarantee that a DAW retains trailing empty clip space: verify the common end time against pack.json.\n\n` +
      `Each MIDI file is paired by filename with its dry part stem. Load a synth or Drum Rack yourself; GM notes do not configure the rack. Mono slides require a legato/portamento-capable instrument. Set pitch-bend sensitivity to ±${midi.bendRangeSemitones} semitones (also sent as RPN). ` +
      `CC mappings, when requested, are in midi/cc-map.json and require manual destination mapping. Sound-sheet settings are a reconstruction reference, not equivalent synth patches.\n\n` +
      `Part stems are post-insert and part gain, before shared returns and the master. Bus stems are complete returns and can include cascaded processing and ducking. Sum parts plus returns for the pre-master stereo mix. Do not add mix.wav to that sum. The draft mix includes the existing safety clamp and can differ from the stem sum. No exact per-part wet attribution is claimed.\n\n` +
      `All WAV files have ${expected.frames} frames at ${expected.sampleRate} Hz. MIDI duration differs by ${midi.durationErrorMs.toFixed(6)} ms; the validated tolerance is ${tolerance.toFixed(6)} ms. See midi/report.json for timing, approximations and omitted controls. Audio stems preserve the rendered sound.\n\n` +
      `## Sections\n\n| Section | Start bar | Score seconds | File seconds | Key |\n|---|---:|---:|---:|---|\n` +
      sections
        .map(
          (s) =>
            `| ${s.name.replace(/\|/g, '\\|')} | ${s.startBar ?? 'partial'} | ${s.scoreSeconds.toFixed(6)} | ${s.audioSeconds.toFixed(6)} | ${s.key} |`,
        )
        .join('\n') +
      '\n';
    writeFileSync(join(temporary, 'README.md'), readme);
    // The portable pack manifest replaces render-local reports with temporary paths.
    for (const name of ['report.json', 'report.txt'])
      rmSync(join(temporary, 'stems', name), { force: true });
    if (existsSync(out)) {
      if (readdirSync(out).length)
        throw new RangeError('Pack output became nonempty while rendering');
      rmdirSync(out);
    }
    renameSync(temporary, out);
    return {
      directory: out,
      manifest: join(out, 'pack.json'),
      parts: midi.files.length,
      frames: expected.frames,
      sampleRate: expected.sampleRate,
      midiDurationErrorMs: midi.durationErrorMs,
      losses: midi.losses,
    };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
