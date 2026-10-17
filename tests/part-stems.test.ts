import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSong } from '../packages/render/src/render.ts';
import { writeWav } from '../packages/render/src/wav.ts';
import { measurePartStem } from '../packages/render/src/part-stems.ts';

const source = `mm 1
song "Part capture"
  tempo 240
  humanize off
  dynamics flat
section A = rest(2 bars)
form = A
fx
  bus grit = drive amount 0.6 -> send room 20%
bus grit
  duck from kick 6dB release 1/8
part lead
  sound init
  range C0..C9
  insert = drive amount 0.1
  send.grit = 0.4
  plays notes | C4 . E4 . |
part kick
  lane kick
  plays hits | x . . . |
part silent
  sound init
  plays notes | . . . . |
`;

test('part stems observe synth/drum audio once without changing the mix; excerpts and tails align', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-parts-'));
  try {
    const opts = { from: 'bar 2', bars: '1', tail: 0.1 };
    renderSong(source, 'parts.mm', { ...opts, out: join(dir, 'plain.wav') });
    const steps: string[] = [];
    const result = renderSong(source, 'parts.mm', {
      ...opts,
      out: join(dir, 'captured.wav'),
      stemsBy: 'part',
      progress: (s) => steps.push(s),
    });
    assert.deepEqual(readFileSync(join(dir, 'plain.wav')), readFileSync(join(dir, 'captured.wav')));
    assert.equal(steps.filter((s) => s === 'Rendering lead').length, 1);
    assert.equal(steps.filter((s) => s === 'Rendering kick').length, 1);
    const report = result.report.partStems!;
    assert.match(report.tap, /pre-shared-returns-and-master/);
    assert.equal(report.members.length, 3);
    assert.ok(result.report.busStems!.members.some((m) => m.name === 'room'));
    assert.match(result.report.busStems!.tap, /pre-master/);
    for (const bus of result.report.busStems!.members) {
      assert.equal(bus.frames, report.frames);
      assert.equal(bus.bands.length, 6);
    }
    for (const part of report.members) {
      const file = readFileSync(part.file),
        mix = readFileSync(join(dir, 'captured.wav'));
      assert.equal(file.readUInt16LE(20), 3);
      assert.equal(file.readUInt32LE(40) / 8, mix.readUInt32LE(40) / 6);
      assert.equal(part.frames, report.frames);
      assert.equal(part.bands.length, 6);
    }
    const silent = report.members.find((m) => m.name === 'silent')!;
    assert.equal(silent.rmsDb, -200);
    assert.equal(silent.peakDb, -200);
    assert.ok(silent.bands.every((b) => b.meanSquare === 0 && b.fraction === 0));
    assert.ok(!report.overlaps.some((o) => o.parts.includes('silent')));
    assert.ok(report.members.find((m) => m.name === 'lead')!.peakDb > -100);
    assert.ok(report.members.find((m) => m.name === 'kick')!.peakDb > -100);
    // Exact bus returns plus dry contributions reconstruct the pre-master signal,
    // even with nonlinear bus processing, ducking and downstream routing.
    const stems = [...report.members, ...result.report.busStems!.members].map((m) =>
      readFileSync(m.file),
    );
    const mix = readFileSync(join(dir, 'captured.wav'));
    for (let i = 0; i < report.frames; i++) {
      const sums = [0, 1].map((ch) =>
        stems.reduce((s, f) => s + f.readFloatLE(44 + i * 8 + ch * 4), 0),
      );
      const gain = Math.min(1, 0.95 / Math.max(0.000001, ...sums.map(Math.abs)));
      for (let ch = 0; ch < 2; ch++) {
        const actual = mix.readIntLE(44 + i * 6 + ch * 3, 3) / 8388607;
        assert.ok(Math.abs(actual - sums[ch] * gain) < 1e-6);
      }
    }

    const selected = renderSong(source, 'parts.mm', {
      ...opts,
      out: join(dir, 'selected.wav'),
      stemsBy: 'part',
      solo: 'lead',
    });
    assert.deepEqual(
      selected.report.partStems!.members.map((m) => m.name),
      ['lead'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('six-band measurements preserve level, spectral location and stereo energy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-band-'));
  try {
    const sr = 48000,
      n = 48000;
    const left = Float32Array.from(
      { length: n },
      (_, i) => 0.5 * Math.sin((2 * Math.PI * 1500 * i) / sr),
    );
    const right = new Float32Array(n);
    const file = join(dir, 'tone.wav');
    writeWav(file, left, right, sr, 0, n, true);
    const m = measurePartStem(file, n, sr);
    assert.ok(Math.abs(m.peakDb + 6.0206) < 0.001);
    assert.ok(Math.abs(m.rmsDb + 12.0412) < 0.001);
    assert.ok(m.bands[3].fraction > 0.999);
    assert.ok(Math.abs(m.bands.reduce((s, b) => s + b.meanSquare, 0) - 0.0625) < 0.0001);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('band energy retains impulses at the beginning, block boundaries and the last sample', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-impulse-'));
  try {
    for (const n of [1, 4097]) {
      const left = new Float32Array(n),
        right = new Float32Array(n);
      for (const i of new Set([0, Math.min(2048, n - 1), n - 1])) left[i] = 0.5;
      const file = join(dir, 'impulse.wav');
      writeWav(file, left, right, 48000, 0, n, true);
      const m = measurePartStem(file, n, 48000);
      const total = m.bands.reduce((s, b) => s + b.meanSquare, 0);
      assert.ok(Math.abs(total - 10 ** (m.rmsDb / 10)) < 1e-12);
      assert.equal(m.peakDb, 20 * Math.log10(0.5));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
