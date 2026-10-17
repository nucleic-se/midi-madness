import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluckedString, VowelFilter } from '../packages/synth/src/physical.ts';
import { rng } from '../packages/synth/src/engine.ts';
import { prepareSoftwareScore } from '../packages/render/src/score-settings.ts';
import { realize } from '../packages/core/src/index.ts';
import { bindSoftware, loadSoftwareSetup } from '../packages/render/src/setup.ts';
import { readFileSync } from 'node:fs';

test('the string stays tuned at fractional periods and decays without growing', () => {
  const sr = 48000;
  for (const hz of [110, 261.625565, 440 * 2 ** (1.955 / 1200)]) {
    const string = new PluckedString(sr);
    string.trigger(hz, 0.8, 1, 0.6, 0.3, rng(17));
    const output = new Float32Array(sr * 2),
      crossings: number[] = [];
    let early = 0,
      late = 0;
    for (let i = 0; i < output.length; i++) {
      output[i] = string.next();
      assert.ok(Number.isFinite(output[i]));
      if (i >= sr / 4 && i < sr / 2) early += output[i] ** 2;
      if (i >= sr * 1.5 && i < sr * 1.75) late += output[i] ** 2;
      if (i > sr / 2 && i < sr && output[i - 1] <= 0 && output[i] > 0)
        crossings.push(i - 1 - output[i - 1] / (output[i] - output[i - 1]));
    }
    assert.ok(early > 0);
    assert.ok(late < early / 100);
    const measured = ((crossings.length - 1) * sr) / (crossings.at(-1)! - crossings[0]);
    assert.ok(Math.abs(1200 * Math.log2(measured / hz)) < 1, `pitch ${hz}: measured ${measured}`);
  }
});

test('vowel endpoints produce distinct bounded spectra, and score sounds select their presets', () => {
  const a = new VowelFilter(48000),
    u = new VowelFilter(48000),
    random = rng(8);
  a.tune(0, 0, 0.5);
  u.tune(1, 0, 0.5);
  let difference = 0;
  for (let i = 0; i < 24000; i++) {
    const x = random() * 2 - 1,
      aa = a.next(x),
      uu = u.next(x);
    assert.ok(Number.isFinite(aa) && Number.isFinite(uu));
    assert.ok(Math.abs(aa) < 5 && Math.abs(uu) < 5);
    difference += Math.abs(aa - uu);
  }
  assert.ok(difference > 100);
  const p = prepareSoftwareScore(readFileSync('tests/fixtures/render/new-sounds.mm', 'utf8'));
  const r = realize(p.coreSource, { parameterDomains: p.domains });
  assert.equal(r.summary.errors, 0);
  const setup = loadSoftwareSetup();
  assert.deepEqual(
    r.song!.parts.map((part) => bindSoftware(setup, part, p.sounds[part.name]).preset),
    ['ks-pluck', 'choir'],
  );
});
