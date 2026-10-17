import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realize, query, Rational as R } from '../packages/core/src/index.ts';
function score(fields: string, extra = '') {
  return `mm 1\nsong "Signals"\n  dynamics flat\nsection A = rest(8 bars)\nform = A\n${extra}\npart kick\n  lane kick\n  plays hits | x . . . |\n${fields}\n`;
}
test('T07/T08: repeating and contextual shapes', () => {
  const r = realize(
    score(
      '  cutoff = across 1 bar: ramp 0.2..0.8\n  reverb = across section: ramp 0..1',
      'signal wave = across 2 bars: sine 0..1',
    ),
  );
  assert.equal(r.summary.errors, 0);
  assert.deepEqual(
    [0, 1, 2].map((t) => r.signals!.named('wave', new R(t), { reset: new R(0) })),
    [0, 1, 0],
  );
  assert.equal(r.parts![0].controls.reverb.find((c) => c.time.equals(new R(4)))?.value, 0.5);
  for (let i = 0; i < 8; i++)
    assert.equal(r.parts![0].controls.cutoff.find((c) => c.time.equals(new R(i)))?.value, 0.2);
});
test('S01/S02: trigger is stage-2 and query-independent, including self-trigger', () => {
  const source = score(
    '  velocity = 0.1\n  level = 1 - pump',
    'signal pump = trigger(kick, decay 1/4)',
  );
  const r = realize(source),
    half = query(source, { from: new R(1, 8), to: new R(1, 2) });
  assert.equal(r.summary.errors, 0);
  assert.equal(r.signals!.named('pump', new R(1, 8), { reset: new R(0) }), 0.4);
  assert.equal(half.signals!.named('pump', new R(1, 8), { reset: new R(0) }), 0.4);
  assert.equal(r.parts![0].events[0].velocity, 0.1);
});
test('X01/X02: bipolar domain and velocity replacement', () => {
  const r = realize(
    score('  velocity = 0.55 + accent * 0.4\n  pan = 2 * accent - 1', 'signal accent = hold 0.5'),
  );
  assert.equal(r.summary.errors, 0);
  assert.equal(r.parts![0].events[0].velocity, 0.75);
  assert.equal(r.parts![0].controls.pan[0].value, 0);
  assert.equal(realize(score('  pan = 1.5')).summary.errors, 1);
  assert.equal(
    realize(score('  velocity = velocity * 0.8')).parts![0].events[0].velocity,
    0.8 * 0.8,
  );
});
test('F04: later expression wins over expanded field helper', () => {
  const r = realize(score('  use duck(kick, 50%)\n  level = 1'));
  assert.equal(r.summary.errors, 0);
  assert.equal(r.parts![0].controls.level[0].value, 1);
});
test('F09: absent signal falls through; locks end to current expression', () => {
  const r = realize(
    score('  cutoff = delayed', 'signal delayed = rest(1 bar) (across 1 bar: ramp 0.2..0.8)'),
  );
  assert.equal(r.summary.errors, 0);
  assert.equal(r.parts![0].controls.cutoff[0].value, null);
  assert.equal(r.parts![0].controls.cutoff.find((c) => c.time.equals(new R(1)))?.value, 0.2);
  const locks = realize(
    score('  cutoff = across 1 bar: ramp 0..1').replace(
      '| x . . . |',
      '| x {cutoff 0.9, length 1/8} . . . |',
    ),
  );
  assert.equal(locks.parts![0].controls.cutoff[0].value, 0.9);
  assert.equal(
    locks.parts![0].controls.cutoff.find((c) => c.time.equals(new R(1, 8)))?.value,
    0.125,
  );
});
test('computed domains and possibly-zero divisors are diagnosed', () => {
  assert.ok(
    realize(score('  cutoff = 2 * sweep', 'signal sweep = sine 0..1')).diagnostics.some(
      (d) => d.code === 'P006',
    ),
  );
  assert.ok(
    realize(score('  cutoff = 1 / sweep', 'signal sweep = sine 0..1')).diagnostics.some(
      (d) => d.code === 'R013',
    ),
  );
  assert.ok(realize(score('  cutof = 0.3')).diagnostics.some((d) => d.code === 'I003'));
});
test('stage-2 material velocity expressions are sampled before trigger envelopes', () => {
  const r = realize(
    score('', 'signal slow = hold 0.5\nsignal pump = trigger(kick, decay 1/4)').replace(
      'plays hits | x . . . |',
      'plays hits (| x . . . |).velocity(slow)',
    ),
  );
  assert.equal(r.summary.errors, 0);
  assert.equal(r.parts![0].events[0].velocity, 0.5);
  assert.equal(r.signals!.named('pump', new R(0), { reset: new R(0) }), 0.5);
});
