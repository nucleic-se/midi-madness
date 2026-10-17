import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInsertChain } from '../packages/synth/src/processors.ts';
import { parseInsertStage, validateInserts } from '../packages/render/src/inserts.ts';
import { prepareSoftwareScore } from '../packages/render/src/score-settings.ts';
import { tuningCents } from '../packages/render/src/tuning.ts';
import { realize } from '../packages/core/src/index.ts';
import { scheduleNotes } from '../packages/render/src/notes.ts';
import { renderSong } from '../packages/render/src/render.ts';
import { buffers } from '../packages/synth/src/engine.ts';
import { busBuffers, renderBuses, type Bus } from '../packages/synth/src/buses.ts';

test('insert order changes sound; bypass preserves a queued echo and cut clears it', () => {
  const delay = parseInsertStage('delay time 10ms, feedback 0%, mix 100%', 120);
  const chain = createInsertChain([delay], 48000),
    cut = createInsertChain([delay], 48000);
  let echo = 0,
    cleared = 0;
  for (let i = 0; i < 1200; i++) {
    if (i === 100) {
      chain.control('insert.delay.bypass', 1);
      cut.reset();
    }
    chain.process(i === 0 ? 1 : 0, 0, i);
    cut.process(i === 0 ? 1 : 0, 0, i);
    if (i >= 480) {
      echo = Math.max(echo, Math.abs(chain.left));
      cleared = Math.max(cleared, Math.abs(cut.left));
    }
  }
  assert.ok(echo > 0.1);
  assert.equal(cleared, 0);
  const drive = parseInsertStage('drive 70%', 120),
    filter = parseInsertStage('filter cutoff 500Hz', 120);
  const a = createInsertChain([drive, filter], 48000),
    b = createInsertChain([filter, drive], 48000);
  let difference = 0;
  for (let i = 0; i < 4800; i++) {
    const x = Math.sin((i * 2 * Math.PI * 1300) / 48000) * 0.3;
    a.process(x, x, i);
    b.process(x, x, i);
    difference += Math.abs(a.left - b.left);
  }
  assert.ok(difference > 1);
});

test('bus ducking lowers returns and a deliberate cut removes a queued echo', () => {
  const sr = 48000;
  const clear: Bus = {
    name: 'clear',
    stages: [parseInsertStage('delay time 10ms, feedback 0%', 120, false)],
    sends: [],
  };
  const cut = buffers(1200);
  cut.buses = busBuffers([clear], 1200);
  cut.buses.clear.left[0] = 1;
  renderBuses(cut, [clear], {}, sr, [], 1200, { cuts: [100] });
  assert.ok(cut.left.every((v) => v === 0));
  const bus: Bus = {
    name: 'space',
    stages: [parseInsertStage('drive amount 0%', 120, false)],
    sends: [],
  };
  const plain = buffers(1200),
    ducked = buffers(1200);
  for (const audio of [plain, ducked]) {
    audio.buses = busBuffers([bus], 1200);
    audio.buses.space.left.fill(0.1);
    audio.buses.space.right.fill(0.1);
  }
  renderBuses(plain, [bus], {}, sr, [], 1200);
  renderBuses(
    ducked,
    [{ ...bus, duck: { part: 'kick', depthDb: 6, release: 0.1 } }],
    {},
    sr,
    [],
    1200,
    { triggers: { kick: [{ sample: 600, velocity: 1 }] } },
  );
  assert.equal(plain.left[400], ducked.left[400]);
  assert.ok(ducked.left[1100] < plain.left[1100] * 0.8);
});

test('software tuning keeps independent note offsets through scheduling', () => {
  const p = prepareSoftwareScore(`mm 1
song "Tuned chord"
  tempo 120
  key Eb major
  tuning just chord
section A = rest(1 bar)
form = A
harmony = I
part voices
  plays notes | Eb3+G3+Bb3 _ C4-12.5ct _ |
  range Eb3..C5
`);
  const r = realize(p.coreSource, { parameterDomains: p.domains });
  assert.equal(r.summary.errors, 0);
  validateInserts(r.song!.parts, p.inserts);
  const notes = scheduleNotes(
    r.song!.parts[0],
    false,
    (t) => Math.round((Number(t.numerator) / Number(t.denominator)) * 96000),
    0,
    96000,
    (e) => tuningCents(p.tuning, e.pitch!, r.harmony!.chordAt(e.nominalOnset).root),
  ).filter((e) => e.type === 'on');
  assert.equal(notes[0].pitch, 51);
  assert.ok(Math.abs(notes[1].pitch - (55 - 0.136862861)) < 1e-8);
  assert.ok(Math.abs(notes[2].pitch - (58 + 0.019550009)) < 1e-8);
  assert.ok(Math.abs(notes[3].pitch - (60 - 0.15641287 - 0.125)) < 1e-8);
});

test('the insert desk renders with solo/mute, ducking and explicit FX cuts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'band-inserts-'));
  try {
    const source = readFileSync('tests/fixtures/render/inserts.mm', 'utf8');
    const r = renderSong(source, 'inserts.mm', {
      out: join(dir, 'mix.wav'),
      solo: 'lead,kick',
      mute: 'kick',
      tail: 1,
    });
    assert.deepEqual(Object.keys(r.report.members), ['lead']);
    assert.deepEqual(r.report.members.lead.ignored, []);
    assert.deepEqual(r.report.fxCuts, [19.5]);
    assert.ok(Number.isFinite(r.report.peak));
    assert.throws(
      () => renderSong(source, 'inserts.mm', { out: join(dir, 'bad.wav'), solo: 'typo' }),
      /Unknown member/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('phaser and flanger accept native settings, automate and clear feedback state', () => {
  for (const text of [
    'phaser stages 12, center A4, depth 3oct, feedback -95%, rate 1/1',
    'flanger tune A4, depth 2ms, feedback 95%, rate 1/2',
  ]) {
    const stage = parseInsertStage(text, 120);
    assert.equal(stage.params.mix, 0.5);
    const chain = createInsertChain([stage], 48000);
    let difference = 0,
      stereo = 0;
    for (let i = 0; i < 48000; i++) {
      if (i === 24000) chain.control(`insert.${stage.id}.feedback`, -0.7);
      const x = 0.1 * Math.sin((i * Math.PI * 2 * 440) / 48000);
      chain.process(x, x, i);
      assert.ok(Number.isFinite(chain.left) && Number.isFinite(chain.right));
      assert.ok(Math.abs(chain.left) < 3 && Math.abs(chain.right) < 3);
      difference += Math.abs(chain.left - x);
      stereo += Math.abs(chain.left - chain.right);
    }
    assert.ok(difference > 10);
    assert.ok(stereo > 10);
    chain.reset();
    for (let i = 48000; i < 49000; i++) {
      chain.process(0, 0, i);
      assert.equal(chain.left, 0);
      assert.equal(chain.right, 0);
    }
  }
  const prepared = prepareSoftwareScore(
    readFileSync('tests/fixtures/render/modulation-effects.mm', 'utf8'),
  );
  const realized = realize(prepared.coreSource, { parameterDomains: prepared.domains });
  assert.equal(realized.summary.errors, 0);
  validateInserts(realized.song!.parts, prepared.inserts);
  assert.throws(() => parseInsertStage('flanger tune A4, time 2ms', 120), /Duplicate/);
});

test('filter insert modes attenuate the expected side of cutoff and automate it', () => {
  const energy = (mode: string, hz: number) => {
    const chain = createInsertChain(
      [parseInsertStage(`filter type ${mode}, cutoff 1kHz, resonance 0%`, 120)],
      48000,
    );
    let sum = 0;
    for (let i = 0; i < 4800; i++) {
      const x = 0.1 * Math.sin((i * Math.PI * 2 * hz) / 48000);
      chain.process(x, x, i);
      if (i > 2400) sum += chain.left ** 2;
    }
    return sum;
  };
  assert.ok(energy('lp24', 200) > 100 * energy('lp24', 8000));
  assert.ok(energy('hp24', 8000) > 100 * energy('hp24', 200));
  const chain = createInsertChain([parseInsertStage('filter cutoff 200Hz', 120)], 48000);
  let before = 0,
    after = 0;
  for (let i = 0; i < 9600; i++) {
    if (i === 4800) chain.control('insert.filter.cutoff', 0.9);
    chain.process(0.1 * Math.sin((i * Math.PI * 2 * 2000) / 48000), 0, i);
    if (i > 2400 && i < 4800) before += chain.left ** 2;
    if (i > 7200) after += chain.left ** 2;
  }
  assert.ok(after > before * 100);
});
