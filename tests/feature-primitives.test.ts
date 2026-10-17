import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realize, Rational as R } from '../packages/core/src/index.ts';
import { prepareSoftwareScore } from '../packages/render/src/score-settings.ts';
import { generatedEvents } from '../packages/core/src/note-generators.ts';
import { scheduleNotes } from '../packages/render/src/notes.ts';
import { renderSong } from '../packages/render/src/render.ts';
const song = (extra: string, notes = '| C4 . . . |') =>
  `mm 1\nsong "Features"\n  tempo 120\n  humanize off\n  dynamics flat\nsection A = rest(8 bars)\nform = A\n${extra}\npart lead\n  role front\n  range C0..C9\n  plays notes ${notes}\n`;
test('exp keeps equal pitch ratios; log, powers and bad endpoints', () => {
  const r = realize(
    song(
      'signal sweep = across 8 bars: exp 1..256\nsignal power = 2 ^ 3 ^ 2\nsignal fn = pow(2, 4)',
    ),
  );
  assert.equal(r.summary.errors, 0, JSON.stringify(r.diagnostics));
  assert.deepEqual(
    [0, 1, 2, 3].map((t) => r.signals!.named('sweep', new R(t), { reset: new R(0) })),
    [1, 2, 4, 8],
  );
  assert.equal(r.signals!.named('power', new R(0), { reset: new R(0) }), 512);
  assert.equal(r.signals!.named('fn', new R(0), { reset: new R(0) }), 16);
  assert.ok(realize(song('signal bad = exp 0..1')).summary.errors);
});
test('JSON and CSV data compile to identical inline controls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-data-'));
  try {
    writeFileSync(join(dir, 'lane.json'), JSON.stringify({ brightness: [0.2, 0.6, 0.4] }));
    writeFileSync(join(dir, 'lane.csv'), 'brightness\n0.2\n0.6\n0.4\n');
    const withControl = (text: string) =>
      song('').replace('  role front', `  cutoff = ${text}\n  role front`);
    const inline = realize(withControl('per 1 beat smooth: 0.2, 0.6, 0.4'));
    for (const file of ['lane.json', 'lane.csv']) {
      const r = realize(withControl(`data "${file}" key brightness per 1 beat smooth`), {
        filename: join(dir, 'test.mm'),
      });
      assert.equal(r.summary.errors, 0, JSON.stringify(r.diagnostics));
      assert.deepEqual(
        r.parts![0].controls.cutoff.map((c) => [c.time.toString(), c.value]),
        inline.parts![0].controls.cutoff.map((c) => [c.time.toString(), c.value]),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('paths survive realization and schedule independently; native generators stay compact', () => {
  const prepared = prepareSoftwareScore(
    song(
      '',
      '| C4{pitch -> E4 over 1/8, cutoff 0.2 -> 0.8 over 1/4 curve exp, group melody} D4 . . |',
    ),
  );
  const r = realize(prepared.coreSource, { parameterDomains: prepared.domains });
  assert.equal(r.summary.errors, 0, JSON.stringify(r.diagnostics));
  const notes = scheduleNotes(
    r.parts![0],
    false,
    (t) => Math.round((Number(t.numerator) / Number(t.denominator)) * 96000),
    0,
    768000,
  );
  const on = notes.find((e) => e.type === 'on');
  assert.ok(on?.type === 'on');
  assert.equal(on.paths![0].to, 400);
  assert.equal(on.paths![0].samples, 12000);
  assert.equal(r.parts![0].events[0].group, 'melody');
  const faster = realize(
    prepared.coreSource
      .replace('plays notes |', 'plays notes (|')
      .replace(' D4 . . |', ' D4 . . |).fast(2)'),
    { parameterDomains: prepared.domains },
  );
  assert.equal(faster.summary.errors, 0, JSON.stringify(faster.diagnostics));
  assert.ok(faster.parts![0].events[0].paths![0].duration.equals(new R(1, 16)));
  const g = realize(
    song('', '| C4{ratchet 4, ratchet.decay 0.2, ratchet.pitch 2st, ratchet.curve 1.5} . . . |'),
  );
  assert.equal(g.summary.errors, 0, JSON.stringify(g.diagnostics));
  const events = generatedEvents(g.parts![0].events[0], 2, '1');
  assert.equal(events.length, 4);
  for (let i = 0; i < 3; i++)
    assert.ok(events[i].nominalOnset.add(events[i].gate).equals(events[i + 1].nominalOnset));
  assert.deepEqual(
    events.map((e) => e.pitch),
    [60, 62, 64, 66],
  );
  assert.ok(events[3].velocity < events[0].velocity);
});
test('paths, ratchets and a 2000-grain cloud produce finite audible audio', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-grain-'));
  try {
    const r = renderSong(
      song(
        '',
        '(across 8 bars: C4{grains 2000, grain.size 30ms, grain.scatter 0.3, grain.pitchjitter 20ct, grain.pan 0.5})',
      ),
      join(dir, 'song.mm'),
      { out: join(dir, 'mix.wav'), tail: 0.1 },
    );
    assert.equal(r.report.members.lead.notes, 2000);
    assert.ok(r.report.peak > 0 && Number.isFinite(r.report.peak));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('group stems contain per-note groups and sum to the mix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-stems-'));
  try {
    const source = song('', '| C4{group low} E4{group mid} G4{group high} . |');
    let mix: { left: Float32Array; right: Float32Array } | undefined;
    const result = renderSong(source, join(dir, 'song.mm'), {
      out: join(dir, 'mix.wav'),
      tail: 0.1,
      stemsBy: 'group',
      captureAudio: (a) => {
        mix = a;
      },
    });
    assert.deepEqual(Object.keys(result.report.groupStems!).sort(), ['high', 'low', 'mid']);
    const files = Object.values(result.report.groupStems!).map((s) => readFileSync(s.file));
    const frames = files[0].readUInt32LE(40) / 8;
    for (let i = 0; i < frames; i++)
      for (let c = 0; c < 2; c++) {
        const sum = files.reduce((n, f) => n + f.readFloatLE(44 + i * 8 + c * 4), 0);
        assert.ok(Math.abs(sum - (c ? mix!.right[i] : mix!.left[i])) < 1e-6);
      }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('spatial audio writes first-order channels and accepts per-voice distance motion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-space-'));
  try {
    const source = song(
      '',
      '| C4{space.az -90 -> 90 over 1/4, space.dist 4 -> 1 over 1/4} . . . |',
    ).replace(
      '  tempo 120',
      '  tempo 120\n  space ambisonic 1\n  space distance inverse, air on, reverb room',
    );
    const result = renderSong(source, join(dir, 'song.mm'), {
      out: join(dir, 'mix.wav'),
      tail: 0.4,
    });
    assert.equal(result.report.channels, 4);
    const bytes = readFileSync(result.destination);
    assert.equal(bytes.readUInt16LE(22), 4);
    assert.ok(result.report.peak > 0 && Number.isFinite(result.report.peak));
    const binaural = renderSong(source.replace('ambisonic 1', 'binaural'), join(dir, 'song.mm'), {
      out: join(dir, 'ears.wav'),
      tail: 0.4,
    });
    assert.equal(binaural.report.channels, 2);
    assert.ok(binaural.report.peak > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('literal profile 1 preserves the large literal event and audio fingerprints', () => {
  const path = new URL('./fixtures/render/literal-v1.mm', import.meta.url);
  const source = readFileSync(path, 'utf8');
  const prepared = prepareSoftwareScore(source);
  const r = realize(prepared.coreSource, { parameterDomains: prepared.domains, attackLimit: 256 });
  assert.equal(r.summary.errors, 0, JSON.stringify(r.diagnostics));
  assert.equal(r.parts![0].events.length, 512);
  const events = r.parts![0].events.map((e) => [
    e.nominalOnset.toString(),
    e.gate.toString(),
    e.pitch,
    e.velocity,
  ]);
  assert.equal(
    createHash('sha256').update(JSON.stringify(events)).digest('hex'),
    '559bc3ef8f3e7476d3bb7f7a08d01c80412025b0d13438456250a7e0052a2e03',
  );
  const dir = mkdtempSync(join(tmpdir(), 'mm-literal-'));
  try {
    let fingerprint = '';
    renderSong(source, join(dir, 'literal.mm'), {
      out: join(dir, 'mix.wav'),
      tail: 0.1,
      captureAudio: (a) => {
        const hash = createHash('sha256');
        // Quantize to 16-bit for reproducibility across minor libm/platform differences.
        const bytes = Buffer.alloc(4 * a.left.length);
        for (let i = 0; i < a.left.length; i++) {
          bytes.writeInt16LE(Math.round(a.left[i] * 32767), i * 4);
          bytes.writeInt16LE(Math.round(a.right[i] * 32767), i * 4 + 2);
        }
        fingerprint = hash.update(bytes).digest('hex');
      },
    });
    assert.equal(fingerprint, '05aad66aa6776f9b17d35033c88d548ad2d203bf54bd72657c3605f9f5293f12');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
