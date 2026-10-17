import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rational as R } from '@midi-madness/foundation/time';
import { realize } from '../packages/core/src/index.ts';
function song(fields: string, extra = '') {
  return `mm 1\nsong "Parts"\n  dynamics flat\n  humanize off\nsection A = rest(8 bars)\nform = A\n${extra}\npart drum\n  lane kick\n${fields}\n`;
}
test('T04: a gated five-step clock continues at its phase', () => {
  const r = realize(
    song(
      '  plays hits steps 1/16: x x x x x\n  restart every 8 bars\n  play when not bar 3..4 of section',
    ),
  );
  assert.equal(r.summary.errors, 0);
  const e = r.song!.parts[0].events;
  assert.ok(
    !e.some((e) => e.nominalOnset.compare(new R(2)) >= 0 && e.nominalOnset.compare(new R(4)) < 0),
  );
  assert.equal(e.find((e) => e.nominalOnset.toString() === '4/1')?.provenance.cycle, 13);
});
test('C01: every fourth bar opens the gate', () => {
  const r = realize(song('  plays hits | x |\n  play when every 4 of 4'));
  assert.deepEqual(
    r.song!.parts[0].events.map((e) => e.nominalOnset.toString()),
    ['3/1', '7/1'],
  );
});
test('T06: swing preserves nominal timing', () => {
  const r = realize(song('  plays hits steps 1/16: x x x x\n  swing 60%'));
  assert.deepEqual(
    r
      .song!.parts[0].events.slice(0, 4)
      .map((e) => [e.nominalOnset.toString(), e.performedOnset.toString()]),
    [
      ['0/1', '0/1'],
      ['1/16', '3/40'],
      ['1/8', '1/8'],
      ['3/16', '1/5'],
    ],
  );
});
test('F10: prelude drone has one held attack stack per section', () => {
  const r = realize(song('  use drone()'));
  assert.equal(r.summary.errors, 0);
  assert.equal(r.song!.parts[0].events.length, 2);
  assert.equal(r.song!.parts[0].events[0].gate.toString(), '8/1');
});
test('H04: fold root before applying hit offset', () => {
  const r = realize(song('  plays roots | x+12 |\n  range D2..C#3'));
  assert.equal(r.summary.errors, 0);
  assert.equal(r.song!.parts[0].events[0].pitch, 60);
});
test('T05: replacement uses the running clock or entry reset', () => {
  for (const entry of [false, true]) {
    const r = realize(
      song(
        `  plays hits steps 1/16: x . . . .\n  when bar 5..6 of section:\n    plays hits steps 1/16: X . . . . . .${entry ? '\n    restart on entry' : ''}`,
      ),
    );
    assert.equal(r.summary.errors, 0);
    assert.equal(
      r
        .song!.parts[0].events.find(
          (e) => Number(e.nominalOnset.numerator) / Number(e.nominalOnset.denominator) >= 4,
        )!
        .nominalOnset.toString(),
      entry ? '4/1' : '35/8',
    );
  }
});
test('C06: fixed chance repeats the source decision', () => {
  const r = realize(song('  plays hits | x {chance 50% fixed} |'));
  assert.equal(new Set(r.song!.parts[0].suppressions.map((e) => e.measured?.draw)).size, 1);
  assert.ok([0, 8].includes(r.song!.parts[0].events.length));
});
test('C08: note selector in a part gate is diagnosed', () => {
  assert.ok(
    realize(song('  plays hits | x |\n  play when last note of bar')).diagnostics.some(
      (d) => d.code === 'C006',
    ),
  );
});
test('F06: entry-hit opens only at the named section entry', () => {
  const r = realize(
    'mm 1\nsection intro = rest(2 bars)\nsection drop = rest(3 bars)\nform = intro drop\npart crash\n  lane crash\n  use entry-hit(in drop)\n',
  );
  assert.equal(r.summary.errors, 0);
  assert.deepEqual(
    r.parts![0].events.map((e) => e.nominalOnset.toString()),
    ['2/1'],
  );
});
test('C04: pattern alternation uses cycle numbers', () => {
  const r = realize(song('  plays hits | x <x o> |'));
  assert.deepEqual(
    r.parts![0].events.slice(0, 8).map((e) => e.velocity),
    [0.8, 0.8, 0.8, 0.4, 0.8, 0.8, 0.8, 0.4],
  );
});
test('C02: periodic ranges, negation and Euclid select the documented bars', () => {
  for (const [condition, expected] of [
    ['every 2..3 of 4', [2, 3, 6, 7]],
    ['not every 1 of 4', [2, 3, 4, 6, 7, 8]],
    ['euclid 3 of 8', [1, 4, 7]],
  ] as const) {
    const r = realize(song(`  plays hits | x |\n  play when ${condition}`));
    assert.deepEqual(
      r.parts![0].events.map((e) => Number(e.nominalOnset.numerator) + 1),
      expected,
    );
  }
});
test('C07: comma list applies the bar gate to both named sections', () => {
  const r = realize(
    'mm 1\nsection build = rest(8 bars)\nsection build2 = rest(8 bars)\nform = build build2\npart kick\n  lane kick\n  plays hits | x |\n  play when in build, build2 and bar < 8 of section\n',
  );
  assert.equal(r.parts![0].events.length, 14);
  assert.ok(
    !r.parts![0].events.some(
      (e) => e.nominalOnset.toString() === '7/1' || e.nominalOnset.toString() === '15/1',
    ),
  );
});
