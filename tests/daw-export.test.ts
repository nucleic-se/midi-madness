import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi } from 'midi-file';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  prepareMidiPerformance,
  exportPartMidi,
  midiStemPrefix,
  dawDrumNotes,
} from '../packages/render/src/daw-midi.ts';
import { packSong } from '../packages/render/src/pack.ts';
import { renderSong } from '../packages/render/src/render.ts';
import type { PerformanceData } from '../packages/render/src/performance.ts';

const header =
  'mm 1\nsong "DAW interchange"\n  tempo 129.92936\n  key D minor\n  seed 37\n  humanize off\n  dynamics flat\nsection A = rest(1 bar)\nsection B = rest(1 bar)\nform = A B\n';
const source =
  header +
  'part lead\n  sound init\n  cutoff = by section: A 0.2, B 0.8 smooth 1/8\n  plays notes | C4{ratchet 3} E4 . . |\npart kick\n  lane kick\n  plays hits | x . x . |\n';
function fixture(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-daw-test-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function decoded(file: string) {
  const parsed = parseMidi(readFileSync(file));
  let tick = 0;
  return { parsed, events: parsed.tracks[0].map((e) => ({ ...e, tick: (tick += e.deltaTime) })) };
}
function wav(file: string) {
  const b = readFileSync(file),
    stride = b.readUInt16LE(32);
  return { b, frames: b.readUInt32LE(40) / stride, sr: b.readUInt32LE(24), stride };
}

test('hardware-free part MIDI uses the same generated event stream and clock as rendering', () =>
  fixture((dir) => {
    const prepared = prepareMidiPerformance(source, 'song.mm');
    let captured: PerformanceData | undefined;
    renderSong(source, 'song.mm', {
      out: join(dir, 'mix.wav'),
      tail: 0.1,
      capturePerformance: (p) => {
        captured = p;
      },
    });
    assert.ok(captured);
    assert.equal(prepared.performance.audio.scoreOffsetSample, captured.audio.scoreOffsetSample);
    for (const t of prepared.performance.tracks) {
      const actual: PerformanceData['tracks'][number] = captured.tracks.find(
        (p) => p.name === t.name,
      )!;
      assert.deepEqual(t.events, actual.events);
      assert.deepEqual(t.hits, actual.hits);
      assert.deepEqual(t.controls, actual.controls);
    }
    const report = exportPartMidi(prepared.performance, join(dir, 'midi'), {
      prefix: midiStemPrefix('song.mm'),
    });
    assert.equal(report.files.length, 2);
    assert.equal(report.microsecondsPerQuarter, 461789);
    for (const f of report.files) {
      const { parsed, events } = decoded(join(dir, 'midi', f.file));
      assert.equal(parsed.header.format, 0);
      assert.equal(parsed.tracks.length, 1);
      assert.equal(parsed.header.ticksPerBeat, report.ppq);
      assert.equal(events.find((e) => e.type === 'trackName')?.text, f.part);
      assert.equal(events.find((e) => e.type === 'setTempo')?.microsecondsPerBeat, 461789);
      assert.ok(
        events.some((e) => e.type === 'timeSignature' && e.numerator === 4 && e.denominator === 4),
      );
      assert.ok(events.some((e) => e.type === 'keySignature' && e.key === -1 && e.scale === 1));
      assert.equal(events.filter((e) => e.type === 'noteOn').length, f.notes);
      assert.equal(events.filter((e) => e.type === 'noteOff').length, f.notes);
      assert.equal(events.at(-1)?.tick, report.endTick);
      assert.ok(!events.some((e) => e.type === 'programChange'));
      if (f.part === 'kick')
        assert.ok(
          events
            .filter((e) => e.type === 'noteOn')
            .every((e) => e.noteNumber === 36 && e.channel === 9),
        );
      else assert.equal(f.notes, 8);
      assert.ok(f.maxTimingErrorMs < report.tempoRoundingDriftMs + report.quantizationBoundMs * 2);
    }
    const before = readFileSync(join(dir, 'midi', report.files[0].file));
    exportPartMidi(prepared.performance, join(dir, 'midi'), { prefix: midiStemPrefix('song.mm') });
    assert.deepEqual(readFileSync(join(dir, 'midi', report.files[0].file)), before);
  }));

test('pitch paths and cents become explicit-range bends; conflicting polyphonic bends are reported', () =>
  fixture((dir) => {
    const single =
      header + 'part lead\n  sound init\n  plays notes | C4{pitch -> E4 over 1/8} . . . |\n';
    const p = prepareMidiPerformance(single, 'pitch.mm');
    const r = exportPartMidi(p.performance, dir, { bendRange: 12 });
    const events = decoded(join(dir, r.files[0].file)).events;
    assert.ok(
      events.some((e) => e.type === 'controller' && e.controllerType === 6 && e.value === 12),
    );
    assert.ok(events.some((e) => e.type === 'pitchBend' && e.value > 2000));
    assert.equal(r.pitchPathSamplingHz, 250);
    const poly = single.replace(
      'C4{pitch -> E4 over 1/8} . . .',
      'C4{length 1/2, pitch -> E4 over 1/8} G4 . .',
    );
    const result = exportPartMidi(prepareMidiPerformance(poly, 'poly.mm').performance, dir);
    assert.ok(result.losses.some((l) => l.code === 'polyphonic-bend'));
    const bends = decoded(join(dir, result.files[0].file)).events.filter(
      (e) => e.type === 'pitchBend',
    );
    assert.ok(bends.every((e) => e.value === 0));
    const clipped = exportPartMidi(p.performance, dir, { bendRange: 1 });
    assert.ok(clipped.losses.some((l) => l.code === 'bend-clipped'));
    assert.throws(() => exportPartMidi(p.performance, dir, { bendRange: 0 }), /1..96/);
  }));

test('mono legato remains overlapping after tick quantization', () =>
  fixture((dir) => {
    const s =
      header.replace('humanize off', 'humanize 50ms') +
      'part lead\n  sound init\n  mono on\n  plays notes | C4{length 1/2} E4{length 1/4} . . |\n';
    const p = prepareMidiPerformance(s, 'slide.mm'),
      r = exportPartMidi(p.performance, dir);
    const events = decoded(join(dir, r.files[0].file)).events;
    const cOff = events.find((e) => e.type === 'noteOff' && e.noteNumber === 60)!;
    const eOn = events.find((e) => e.type === 'noteOn' && e.noteNumber === 64)!;
    assert.ok(cOff.tick > eOn.tick);
  }));

test('CC lanes are opt-in, normalized and explicitly mapped; omitted and reset controls are reported', () =>
  fixture((dir) => {
    const s =
      header +
      'part lead\n  sound init\n  cutoff = per song 1 bar: 0.2, 0.8\n  pan = 0.5\n  level.db = -12\n  send.echo = 0.4\n  wave = 0.3\n  plays notes | C4 . . . |\n';
    const p = prepareMidiPerformance(s, 'cc.mm');
    let r = exportPartMidi(p.performance, dir);
    assert.ok(
      !decoded(join(dir, r.files[0].file)).events.some(
        (e) => e.type === 'controller' && e.controllerType === 74,
      ),
    );
    assert.ok(
      r.losses.some((l) => l.code === 'unexported-control' && l.message.includes('cutoff')),
    );
    r = exportPartMidi(p.performance, dir, { cc: true });
    const events = decoded(join(dir, r.files[0].file)).events;
    assert.deepEqual(
      events.flatMap((e) => (e.type === 'controller' && e.controllerType === 74 ? [e.value] : [])),
      [25, 102],
    );
    assert.ok(
      events.some((e) => e.type === 'controller' && e.controllerType === 10 && e.value === 95),
    );
    assert.ok(r.cc.some((c) => c.parameter === 'send.echo' && c.cc === 20));
    assert.ok(r.losses.some((l) => l.code === 'unexported-control' && l.message.includes('wave')));
    assert.ok(existsSync(join(dir, 'cc-map.json')));
  }));

test('grains become editable notes with explicit audio-only window and control losses', () =>
  fixture((dir) => {
    const s =
      header +
      'part lead\n  sound init\n  plays notes (across 1 bar: C4{grains 12, grain.size 20ms})\n';
    const p = prepareMidiPerformance(s, 'grains.mm'),
      r = exportPartMidi(p.performance, dir);
    assert.equal(
      r.files[0].notes,
      p.performance.tracks[0].events!.filter((e) => e.type === 'on').length,
    );
    assert.equal(r.files[0].notes, 24);
    assert.ok(r.losses.some((l) => l.code === 'grain-window'));
  }));

test('all supported drum lanes have GM mappings and non-GM sound substitutions are labelled', () =>
  fixture((dir) => {
    const s =
      header +
      Object.keys(dawDrumNotes)
        .map((lane, i) => `part drum${i}\n  lane ${lane}\n  plays hits | x . . . |\n`)
        .join('');
    const r = exportPartMidi(prepareMidiPerformance(s, 'drums.mm').performance, dir);
    assert.equal(r.files.length, 16);
    assert.equal(r.losses.filter((l) => l.code === 'drum-timbre').length, 3);
    for (const f of r.files) assert.equal(f.channel, 10);
  }));

test('packs validate common WAV length, MIDI duration, names, metadata and portable file references', () =>
  fixture((dir) => {
    const s = source.replace('humanize off', 'humanize 50ms').replace('seed 37', 'seed 1');
    const result = packSong(s, 'project.mm', { out: join(dir, 'pack'), tail: 0.1, cc: true });
    const pack = JSON.parse(readFileSync(result.manifest, 'utf8'));
    assert.ok(pack.alignment.verified);
    assert.equal(pack.parts.members.length, 2);
    const files = [
      'mix.wav',
      ...pack.parts.members.map((m: { file: string }) => m.file),
      ...pack.busReturns.members.map((m: { file: string }) => m.file),
    ];
    for (const file of files) {
      const info = wav(join(result.directory, file));
      assert.equal(info.frames, result.frames);
      assert.equal(info.sr, result.sampleRate);
    }
    for (const f of pack.midi.files) {
      assert.equal(
        decoded(join(result.directory, 'midi', f.file)).events.at(-1)?.tick,
        pack.midi.endTick,
      );
      const stem = pack.parts.members.find((m: { name: string }) => m.name === f.part);
      assert.equal(basename(stem.file, '.wav'), basename(f.file, '.mid'));
    }
    assert.ok(pack.midi.durationErrorMs <= pack.alignment.durationToleranceMs);
    assert.ok(!readFileSync(result.manifest, 'utf8').includes('.mm-pack-'));
    const readme = readFileSync(join(result.directory, 'README.md'), 'utf8');
    assert.match(readme, /warping disabled/);
    assert.match(readme, /Sections/);
    assert.ok(existsSync(join(result.directory, 'sound-sheet.json')));
    assert.ok(existsSync(join(result.directory, 'mix.events.json')));
    assert.ok(pack.sections.every((s: { startBar: number }) => s.startBar >= 1));
    assert.throws(() => packSong(source, 'project.mm', { out: result.directory }), /new or empty/);
    assert.ok(existsSync(result.manifest));
  }));

test('pack failures leave no partial destination or temporary directories', () =>
  fixture((dir) => {
    assert.throws(() =>
      packSong('mm 1\npart bad\n  plays nowhere\n', 'bad.mm', { out: join(dir, 'bad') }),
    );
    assert.ok(!existsSync(join(dir, 'bad')));
    assert.deepEqual(readdirSync(dir), []);
    const busy = join(dir, 'busy');
    let written = false;
    assert.throws(
      () =>
        packSong(source, 'busy.mm', {
          out: busy,
          tail: 0.1,
          progress: () => {
            if (!written) {
              mkdirSync(busy, { recursive: true });
              writeFileSync(join(busy, 'keep.txt'), 'user file');
              written = true;
            }
          },
        }),
      /became nonempty/,
    );
    assert.equal(readFileSync(join(busy, 'keep.txt'), 'utf8'), 'user file');
    assert.ok(!readdirSync(dir).some((name) => name.startsWith('.mm-pack-')));
  }));

test('CLI exports and packs without hardware configuration and validates option combinations', () =>
  fixture((dir) => {
    const file = join(dir, 'song.mm');
    writeFileSync(file, source);
    const cli = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ['--experimental-strip-types', 'packages/cli/src/main.ts', ...args, '--json'],
        { encoding: 'utf8' },
      );
    const midi = cli('export', file, '--midi-dir', join(dir, 'midi'), '--cc');
    assert.equal(midi.status, 0, midi.stdout + midi.stderr);
    assert.equal(JSON.parse(midi.stdout).result.files.length, 2);
    const pack = cli('pack', file, '--out', join(dir, 'pack'), '--tail', '0.1');
    assert.equal(pack.status, 0, pack.stdout + pack.stderr);
    assert.equal(JSON.parse(pack.stdout).result.parts, 2);
    for (const args of [
      ['export', file, '--midi', 'x.mid', '--midi-dir', join(dir, 'bad')],
      ['export', file, '--midi', 'x.mid', '--cc'],
      ['pack', file, '--out', join(dir, 'bad'), '--bend-range', '0'],
      ['pack', file, '--out', join(dir, 'bad'), '--tail', '-1'],
    ])
      assert.equal(cli(...args).status, 2);
  }));

test('tempo rounding, partial meters and modal key limitations are explicit', () =>
  fixture((dir) => {
    const s = source
      .replace('key D minor', 'key E dorian')
      .replace('rest(1 bar)', 'rest(3/2 bars)');
    const p = prepareMidiPerformance(s, 'meter.mm');
    p.performance.audio.frames = p.performance.audio.sampleRate * 600;
    const r = exportPartMidi(p.performance, dir);
    assert.ok(Math.abs(r.tempoRoundingDriftMs - 0.5077496) < 0.00001);
    assert.ok(r.durationErrorMs <= r.tempoRoundingDriftMs + r.quantizationBoundMs);
    const events = decoded(join(dir, r.files[0].file)).events;
    assert.ok(
      events.some((e) => e.type === 'timeSignature' && e.numerator === 2 && e.denominator === 4),
    );
    assert.ok(events.some((e) => e.type === 'text' && e.text.includes('E dorian')));
    assert.ok(r.losses.some((l) => l.code === 'modal-key'));
  }));

test('sub-tick notes, folded pitches and null CC resets are reported; repeated exports remove stale managed files', () =>
  fixture((dir) => {
    const p = prepareMidiPerformance(source.replace('tempo 129.92936', 'tempo 20'), 'losses.mm');
    const track = p.performance.tracks[0];
    const on = track.events!.find((e) => e.type === 'on')!;
    assert.equal(on.type, 'on');
    on.pitch = 140;
    const off = track.events!.find((e) => e.type === 'off' && e.id === on.id)!;
    assert.equal(off.type, 'off');
    off.sample = on.sample + 1;
    // At this deliberately low tempo, a single audio sample is below one MIDI tick.
    track.events!.push({ type: 'set', sample: 48000, name: 'pan', value: null });
    const r = exportPartMidi(p.performance, dir, { cc: true });
    assert.ok(r.losses.some((l) => l.code === 'folded-note'));
    assert.ok(r.losses.some((l) => l.code === 'note-resolution'));
    assert.ok(r.losses.some((l) => l.code === 'cc-reset'));
    const old = r.files[1].file;
    writeFileSync(join(dir, 'unrelated.txt'), 'keep');
    p.performance.tracks = p.performance.tracks.slice(0, 1);
    exportPartMidi(p.performance, dir);
    assert.ok(!existsSync(join(dir, old)));
    assert.ok(!existsSync(join(dir, 'cc-map.json')));
    assert.equal(readFileSync(join(dir, 'unrelated.txt'), 'utf8'), 'keep');
  }));

test('pack stems sum to the unclamped mix and notes retain the same absolute sample origin', () =>
  fixture((dir) => {
    const s = source.replace('humanize off', 'humanize 50ms').replace('seed 37', 'seed 1');
    const input = prepareMidiPerformance(s, 'sum.mm');
    assert.ok(input.performance.audio.scoreOffsetSample > 0);
    const r = packSong(s, 'sum.mm', { out: join(dir, 'pack'), tail: 0.1 });
    const manifest = JSON.parse(readFileSync(r.manifest, 'utf8'));
    assert.equal(manifest.audio.scoreOffsetSample, input.performance.audio.scoreOffsetSample);
    const expected = wav(join(r.directory, 'mix.wav'));
    const stems = [...manifest.parts.members, ...manifest.busReturns.members].map(
      (m: { file: string }) => wav(join(r.directory, m.file)),
    );
    assert.equal(manifest.safety.reducedSamples, 0);
    let maxError = 0;
    for (let i = 0; i < expected.frames; i++)
      for (let ch = 0; ch < 2; ch++) {
        const sum = stems.reduce((v, s) => v + s.b.readFloatLE(44 + i * 8 + ch * 4), 0);
        maxError = Math.max(
          maxError,
          Math.abs(sum - expected.b.readIntLE(44 + i * 6 + ch * 3, 3) / 8388607),
        );
      }
    assert.ok(maxError < 1e-6, `${maxError}`);
  }));

test('MIDI-only CLI maps main-file warnings through includes exactly once', () =>
  fixture((dir) => {
    writeFileSync(join(dir, 'form.mmi'), 'section A = rest(1 bar)\nform = A\n\n\n');
    const file = join(dir, 'main.mm');
    writeFileSync(
      file,
      'mm 1\nsong "Locations"\n  humanize off\ninclude "form.mmi"\npart lead\n  sound init\n  range C4..C5\n  plays notes | C2 . . . |\n',
    );
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'packages/cli/src/main.ts',
        'export',
        file,
        '--midi-dir',
        join(dir, 'midi'),
        '--json',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const diagnostic = JSON.parse(result.stdout).diagnostics.find(
      (d: { code: string }) => d.code === 'P004',
    );
    assert.ok(diagnostic);
    assert.equal(diagnostic.file, file);
    assert.equal(diagnostic.span.line, 8);
  }));
