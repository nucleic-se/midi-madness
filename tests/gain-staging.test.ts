import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProcessor, createInsertChain } from '../packages/synth/src/processors.ts';
import { parseInsertStage, insertLiteral } from '../packages/render/src/inserts.ts';
import { prepareSoftwareScore } from '../packages/render/src/score-settings.ts';
import { renderSong } from '../packages/render/src/render.ts';
import { envelopeTimeLiteral } from '../packages/render/src/envelope-times.ts';
import { realize } from '../packages/core/src/index.ts';

const header =
  'mm 1\nsong "Gain"\n  tempo 120\n  humanize off\n  dynamics flat\nsection A = rest(1 bar)\nform = A\n';
function response(stage: string, frequency: number, amplitude = 0.01) {
  const processor = createProcessor(parseInsertStage(stage, 120), 48000);
  let input = 0,
    output = 0;
  for (let i = 0; i < 24000; i++) {
    const x = amplitude * Math.sin((2 * Math.PI * frequency * i) / 48000);
    processor.process(x, x, i);
    assert.ok(Number.isFinite(processor.left));
    if (i >= 12000) {
      input += x * x;
      output += processor.left ** 2;
    }
  }
  return 10 * Math.log10(output / input);
}

test('drive makeup defaults to the legacy transfer and auto compensates small-signal gain', () => {
  const implicit = createProcessor(parseInsertStage('drive amount 0.7, model tube', 120), 48000);
  const off = createProcessor(
    parseInsertStage('drive amount 0.7, model tube, makeup off', 120),
    48000,
  );
  let tone = 0;
  const coef = 1 - Math.exp((-2 * Math.PI * 9000) / 48000);
  for (let i = 0; i < 4800; i++) {
    const x = 0.03 * Math.sin(i / 5);
    const legacy = (Math.tanh(x * 22 + 0.2) - Math.tanh(0.2)) / Math.sqrt(8);
    tone += coef * (legacy - tone);
    implicit.process(x, x, i);
    off.process(x, x, i);
    assert.equal(implicit.left, off.left);
    assert.ok(Math.abs(implicit.left - tone) < 1e-16);
  }
  for (const model of ['soft', 'tube', 'hard']) {
    const stage = `drive amount 0.8, model ${model}, tone 20kHz`;
    const boosted = response(stage, 200, 1e-5);
    const compensated = response(stage + ', makeup auto', 200, 1e-5);
    assert.ok(boosted > 17);
    assert.ok(Math.abs(compensated) < 0.01);
  }
  assert.equal(insertLiteral(parseInsertStage('drive', 120), 'makeup', 'auto', 120), '1');
  assert.throws(() => parseInsertStage('drive makeup yes', 120), /Invalid/);
});

test('bell and shelves deliver gain at the intended frequencies; zero gain is exact unity', () => {
  for (const gain of [-12, 12]) {
    assert.ok(
      Math.abs(response(`eq type bell, frequency 1kHz, gain ${gain}dB, q 1`, 1000) - gain) < 0.001,
    );
    assert.ok(
      Math.abs(response(`eq type low-shelf, frequency 1kHz, gain ${gain}dB`, 50) - gain) < 0.01,
    );
    assert.ok(
      Math.abs(response(`eq type high-shelf, frequency 1kHz, gain ${gain}dB`, 10000) - gain) < 0.01,
    );
    assert.ok(
      Math.abs(response(`eq type low-shelf, frequency 1kHz, gain ${gain}dB`, 10000)) < 0.01,
    );
    assert.ok(Math.abs(response(`eq type high-shelf, frequency 1kHz, gain ${gain}dB`, 50)) < 0.01);
  }
  const eq = createProcessor(parseInsertStage('eq gain 0dB', 120), 48000);
  for (let i = 0; i < 500; i++) {
    const x = Math.sin(i / 3);
    eq.process(x, -x, i);
    assert.equal(eq.left, x);
    assert.equal(eq.right, -x);
  }
  assert.throws(() => parseInsertStage('eq gain 30dB', 120), /must be/);
  assert.throws(() => parseInsertStage('eq gain 2ms', 120), /Wrong unit/);
  assert.equal(
    insertLiteral(parseInsertStage('eq', 120), 'gain', 'across 1 bar: ramp -12dB..12dB', 120),
    'across 1 bar: ramp 0.25..0.75',
  );
});

test('EQ stays finite at domain extremes, automation, reset and insert bypass', () => {
  for (const type of ['bell', 'low-shelf', 'high-shelf']) {
    const chain = createInsertChain(
      [parseInsertStage(`eq type ${type}, frequency 20Hz, gain 24dB, q 18, slope 0.1`, 120)],
      48000,
    );
    for (let i = 0; i < 12000; i++) {
      if (i === 2000) {
        chain.control('insert.eq.frequency', 1);
        chain.control('insert.eq.gain', 0);
      }
      if (i === 4000) chain.control('insert.eq.bypass', 1);
      if (i === 8000) chain.reset();
      chain.process(Math.sin(i / 9) * 0.1, 0, i);
      assert.ok(Number.isFinite(chain.left));
      if (i > 10000) assert.ok(Math.abs(chain.left - Math.sin(i / 9) * 0.1) < 1e-6);
    }
  }
});

test('stage gain reports follow measured input/output, include dry/wet mix and define silence', () => {
  const chain = createInsertChain([parseInsertStage('drive amount 0.5', 120)], 48000);
  for (let i = 0; i < 4800; i++) chain.process(0.001, 0.001, i);
  const meter = chain.measurements()[0];
  assert.equal(meter.input.frames, 4800);
  assert.ok(meter.gainDb! > 15);
  assert.ok(Math.abs(meter.gainDb! - (meter.output.rmsDb - meter.input.rmsDb)) < 1e-10);
  const dry = createInsertChain([parseInsertStage('drive amount 0.5, mix 0%', 120)], 48000);
  for (let i = 0; i < 100; i++) dry.process(0.1, -0.1, i);
  assert.equal(dry.measurements()[0].gainDb, 0);
  const silent = createInsertChain([parseInsertStage('drive', 120)], 48000);
  for (let i = 0; i < 100; i++) silent.process(0, 0, i);
  assert.equal(silent.measurements()[0].gainDb, null);
  const dir = mkdtempSync(join(tmpdir(), 'mm-gain-'));
  try {
    const result = renderSong(
      header +
        'fx\n  bus grit = drive amount 0.3\npart lead\n  sound init\n  insert = eq gain 3dB\n  send.grit = 0.5\n  plays notes | C4 . . . |\n',
      'gain.mm',
      { out: join(dir, 'mix.wav'), tail: 0.1 },
    );
    assert.equal(result.report.members.lead.insertStages![0].type, 'eq');
    assert.equal(result.report.buses.grit.stages[0].type, 'drive');
    assert.ok(result.report.buses.grit.stages[0].input.meanSquare > 0);
    assert.match(result.report.stageGainMeasurement.description, /allocated tail/);
    assert.match(result.text, /eq \(eq\): RMS/);
    assert.match(result.text, /drive \(drive\): RMS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('envelope times add ms/s/note spellings without reinterpreting normalized fractions', () => {
  const inverse = Math.cbrt((0.25 - 0.001) / 5);
  assert.equal(envelopeTimeLiteral('attack', '1/8', 120), '1/8');
  assert.equal(Number(envelopeTimeLiteral('attack', '250ms', 120)), inverse);
  assert.equal(Number(envelopeTimeLiteral('filter.release', 'note(1/8)', 120)), inverse);
  assert.equal(Number(envelopeTimeLiteral('modenv.decay', 'note(1/8)', 120)), 0.25);
  assert.equal(Number(envelopeTimeLiteral('release', '1ms', 120)), 0);
  assert.equal(Number(envelopeTimeLiteral('release', '5001ms', 120)), 1);
  assert.throws(() => envelopeTimeLiteral('attack', '0ms', 120), /must be/);
  assert.throws(() => envelopeTimeLiteral('attack', '6s', 120), /must be/);
  assert.throws(() => envelopeTimeLiteral('attack', '3Hz', 120), /expects ms/);
  const prepared = prepareSoftwareScore(
    header +
      'part lead\n  attack = note(1/8)\n  decay = per 1 bar: 250ms, 500ms\n  release = across 1 bar: ramp 10ms..note(1/4)\n  filter.attack = 80ms\n  plays notes | C4{filter.decay note(1/8), modenv.attack 2ms} . . . |\n',
  );
  const result = realize(prepared.coreSource, { parameterDomains: prepared.domains });
  assert.equal(result.summary.errors, 0, JSON.stringify(result.diagnostics));
  const ev = result.parts![0].events[0];
  assert.ok(Math.abs(ev.locks['filter.decay'] - inverse) < 1e-12);
  assert.equal(ev.locks['modenv.attack'], 0.002);
  assert.doesNotMatch(prepared.coreSource, /note\(|\dms/);
  for (const [tempo, seconds] of [
    ['', 0.3],
    ['  tempo 240/2\n', 0.25],
    ['  tempo 240\n', 0.125],
  ] as const) {
    const src = `mm 1\nsong "Tempo"\n${tempo}section A = rest(1 bar)\nform = A\npart lead\n  attack = note(1/8)\n  plays notes | C4 . . . |\n`;
    const lowered = prepareSoftwareScore(src).coreSource;
    const value = Number(lowered.match(/attack = ([\d.]+)/)![1]);
    assert.ok(Math.abs(0.001 + 5 * value ** 3 - seconds) < 1e-12);
  }
});

test('an existing authored note function is not reinterpreted as an envelope duration', () => {
  const p = prepareSoftwareScore(
    header +
      'define note(x: percent) = x\npart lead\n  attack = note(1/8)\n  plays notes | C4 . . . |\n',
  );
  assert.match(p.coreSource, /attack = note\(1\/8\)/);
  const result = realize(p.coreSource, { parameterDomains: p.domains });
  assert.equal(result.summary.errors, 0, JSON.stringify(result.diagnostics));
});

test('native filter envelope path endpoints lower without altering existing modenv paths', () => {
  const p = prepareSoftwareScore(
    header +
      'part lead\n  plays notes | C4{filter.decay 10ms -> note(1/8) over 1/4, modenv.attack 10ms -> 100ms over 1/4} . . . |\n',
  );
  const r = realize(p.coreSource, { parameterDomains: p.domains });
  assert.equal(r.summary.errors, 0, JSON.stringify(r.diagnostics));
  const [filter, modenv] = r.parts![0].events[0].paths!;
  assert.ok(Math.abs(0.001 + 5 * filter.from! ** 3 - 0.01) < 1e-12);
  assert.ok(Math.abs(0.001 + 5 * filter.to ** 3 - 0.25) < 1e-12);
  assert.equal(modenv.from, 0.01);
  assert.equal(modenv.to, 0.1);
});
test('EQ clamps warned out-of-domain automation to a stable parameter range', () => {
  const p = createProcessor(parseInsertStage('eq', 120), 48000);
  p.params.frequency = 1e6;
  p.params.gain = 1e6;
  p.params.q = -1;
  p.params.slope = -1;
  p.params.type = 1;
  for (let i = 0; i < 10000; i++) {
    p.process(i === 0 ? 0.1 : 0, 0, i);
    assert.ok(Number.isFinite(p.left) && Math.abs(p.left) < 100);
  }
});
