import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareSoftwareScore } from '../packages/render/src/score-settings.ts';
import { realize } from '../packages/core/src/index.ts';
import { parseInsertStage, insertLiteral } from '../packages/render/src/inserts.ts';
import { nativeEffectValue } from '../packages/synth/src/processors.ts';
const header =
  'mm 1\nsong "Automation"\n  tempo 120\n  humanize off\nsection A = rest(1 bar)\nform = A\n';
test('native insert shape endpoints lower into the existing parameter scale', () => {
  const stage = parseInsertStage('filter cutoff 1kHz', 120);
  for (const shape of ['ramp', 'sine', 'triangle', 'saw', 'square', 'random', 'exp', 'log']) {
    const source = insertLiteral(
      stage,
      'cutoff',
      `across 1 bar: ${shape} 500Hz..2kHz${shape === 'random' ? ' every 1/8' : ''}`,
      120,
    );
    const match = source.match(/: \w+ ([\d.e+-]+)\.\.([\d.e+-]+)/)!;
    assert.ok(match, source);
    assert.ok(Math.abs(nativeEffectValue('filter', 'cutoff', Number(match[1])) - 500) < 1e-6);
    assert.ok(Math.abs(nativeEffectValue('filter', 'cutoff', Number(match[2])) - 2000) < 1e-6);
  }
  const crush = parseInsertStage('crush bits 8', 120);
  assert.equal(
    insertLiteral(crush, 'bits', 'across 1 bar: ramp 0..1', 120),
    'across 1 bar: ramp 0..1',
  );
  assert.equal(insertLiteral(stage, 'cutoff', 'brightness', 120), 'brightness');
  assert.equal(
    insertLiteral(stage, 'cutoff', 'across 1 bar: ramp 0.2..0.8', 120),
    'across 1 bar: ramp 0.2..0.8',
  );
  assert.match(
    insertLiteral(stage, 'cutoff', '(across 1 bar: hold 500Hz).loop(2 bars)', 120),
    /^\(across 1 bar: hold [\d.]+\).loop/,
  );
  assert.throws(
    () => insertLiteral(stage, 'cutoff', 'across 1 bar: ramp 500ms..2kHz', 120),
    /Wrong unit/,
  );
  assert.throws(
    () => insertLiteral(stage, 'cutoff', 'across 1 bar: ramp 1Hz..2kHz', 120),
    /must be/,
  );
});
test('native bus and insert automation compiles with units, per values and chained shapes', () => {
  const prepared = prepareSoftwareScore(
    header +
      'fx\n  bus hall = reverb decay 2s\nbus hall\n  decay = across 1 bar: ramp 500ms..4s\n  damping = across 1 bar: ramp 500Hz..2kHz\npart lead\n  insert = filter cutoff 1kHz -> delay time 1/8\n  insert.filter.cutoff = (across 1 bar: ramp 500Hz..2kHz).loop(1 bar)\n  insert.delay.time = across 1 bar: ramp 1/8..1/4\n  plays notes | C4 . . . |\n',
  );
  assert.doesNotMatch(prepared.coreSource, /500Hz|2kHz|500ms|4s/);
  const checked = realize(prepared.coreSource, {
    templateContext: prepared.templates,
    parameterDomains: prepared.domains,
    controlOnlyParts: new Set(Object.keys(prepared.busParts)),
  });
  assert.equal(checked.summary.errors, 0, JSON.stringify(checked.diagnostics));
  const stage = parseInsertStage('filter cutoff 1kHz', 120);
  assert.doesNotMatch(insertLiteral(stage, 'cutoff', 'per 1 bar: 500Hz, 2kHz', 120), /Hz/);
});
test('exp and log keep positive normalized-endpoint requirements', () => {
  const prepared = prepareSoftwareScore(
    header +
      'part lead\n  insert = filter cutoff 1kHz\n  insert.filter.cutoff = across 1 bar: exp 20Hz..2kHz\n  plays notes | C4 . . . |\n',
  );
  const checked = realize(prepared.coreSource, { parameterDomains: prepared.domains });
  assert.ok(checked.diagnostics.some((d) => /positive endpoints/.test(d.message)));
});
