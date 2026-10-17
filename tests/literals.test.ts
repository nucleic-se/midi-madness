import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  euclid,
  compileLiteral,
  parseDuration,
  isBinaryDuration,
} from '../packages/core/src/literals.ts';
import { parseExpression } from '../packages/core/src/parser.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import type { LiteralContext } from '../packages/core/src/literals.ts';
function compile(source: string, context: Partial<LiteralContext> = {}) {
  const parsed = parseExpression(source);
  assert.deepEqual(parsed.diagnostics, []);
  assert(parsed.expression?.kind === 'literal' || parsed.expression?.kind === 'shape');
  return compileLiteral(parsed.expression, { type: 'hits', ...context });
}
const spec = readFileSync(new URL('../docs/reference/LANGUAGE.md', import.meta.url), 'utf8')
  .split('## Appendix C.')[1]
  .split('## Appendix D.')[0];
for (const [, k, n, pattern] of spec.matchAll(/\((\d+),(\d+)\) \| `([x.]+)`/g)) {
  test(`Appendix C E(${k},${n})`, () =>
    assert.equal(
      euclid(Number(k), Number(n))
        .map((x) => (x ? 'x' : '.'))
        .join(''),
      pattern,
    ));
}
test('Euclid rotations, bounds and invariants', () => {
  assert.deepEqual(euclid(3, 8, 2), euclid(3, 8, 10));
  assert.equal(
    euclid(3, 8, 2)
      .map((x) => (x ? 'x' : '.'))
      .join(''),
    '.x..x.x.',
  );
  assert.deepEqual(euclid(3, 8, -6), euclid(3, 8, 2));
  for (let n = 1; n <= 32; n++)
    for (let k = 0; k <= n; k++) {
      const p = euclid(k, n);
      assert.equal(p.length, n);
      assert.equal(p.filter(Boolean).length, k);
    }
  for (const [k, n] of [
    [-1, 8],
    [9, 8],
    [1, 0],
    [0.5, 8],
  ])
    assert.throws(() => euclid(k, n), RangeError);
});
test('exact duration syntax and binary classification', () => {
  assert.equal(parseDuration('1/8.').toString(), '3/16');
  assert.equal(parseDuration('1/16t').toString(), '1/24');
  assert.equal(parseDuration('3 bars', { meter: [7, 8] }).toString(), '21/8');
  assert.equal(parseDuration('2 beats', { meter: [7, 8] }).toString(), '1/2');
  assert.equal(parseDuration('1 bar + 1/8').toString(), '9/8');
  for (const duration of ['1/16', '3/8', '2', '6'])
    assert(isBinaryDuration(R.parse(duration)), duration);
  for (const duration of ['1/3', '5/16', '0', '-1/4'])
    assert(!isBinaryDuration(R.parse(duration)), duration);
});
test('weighted nested subdivisions and ratchets keep exact extents', () => {
  const result = compile('| [x@3 x] x*2 |');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.value?.extent.toString(), '1/1');
  assert.deepEqual(
    result.value?.events.map((e) => [e.onset.toString(), e.writtenSpan.toString()]),
    [
      ['0/1', '3/8'],
      ['3/8', '1/8'],
      ['1/2', '1/4'],
      ['3/4', '1/4'],
    ],
  );
  assert.equal(compile('| x*3 |').diagnostics[0]?.code, 'T001');
});
test('Euclid expansions count toward parent slots and are checked in branches', () => {
  const result = compile('| x(3,8) x(3,8) |');
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.value?.events.map((e) => e.onset.toString()),
    ['0/1', '3/16', '3/8', '1/2', '11/16', '7/8'],
  );
  assert.equal(compile('| <x(3,8) x(5,8)> |', { cycle: 2 }).value?.events.length, 5);
  assert.equal(compile('| <x(3,8) x(3,7)> |').diagnostics[0]?.code, 'T005');
});
test('holds extend stacks across bar lines and rests', () => {
  const result = compile('| E4+B4 | _ | . | _ |', { type: 'notes' });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.value?.events.map((e) => [e.pitches, e.writtenSpan.toString()]),
    [[['E4', 'B4'], '4/1']],
  );
  assert.equal(compile('| _ x |').diagnostics[0]?.code, 'T002');
  const cycle = compile('| _ x |', { allowLeadingHold: true });
  assert.deepEqual(cycle.diagnostics, []);
  assert.equal(cycle.value?.leadingHolds.length, 1);
});
test('explicit tuples, triplet steps and nested binary checks', () => {
  assert.deepEqual(compile('across 3 beats: x x x x x').diagnostics, []);
  assert.equal(compile('across 3 beats: x x x x x').value?.events[1].onset.toString(), '3/20');
  assert.equal(compile('steps 1/16t: x . x').value?.extent.toString(), '1/8');
  assert.equal(compile('steps 1/16: [x x x] x').diagnostics[0]?.code, 'T001');
  assert.deepEqual(compile('| (across 1 beat: x x x) x x x |').diagnostics, []);
});
test('options inherit through brackets, with inner fields winning', () => {
  const result = compile(
    '| [X{velocity 0.5, cutoff 0.2} o]{velocity 0.9, cutoff 0.8, chance 40% fixed, not fill bar} |',
  );
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.value?.events.map((e) => e.velocity),
    [0.5, 0.9],
  );
  assert.deepEqual(
    result.value?.events.map((e) => e.locks.cutoff),
    [0.2, 0.8],
  );
  assert.equal(result.value?.events[0].conditions.length, 2);
  assert.equal(compile('| x{length 50%} |').value?.events[0].gate.toString(), '1/2');
});
test('steps values and shapes preserve their period and extent', () => {
  const values = compile('steps 1/8 smooth: 0.2 0.5 0.9 0.5', { type: 'values' });
  assert.deepEqual(values.diagnostics, []);
  assert.equal(values.value?.extent.toString(), '1/2');
  assert.equal(values.value?.smooth, true);
  assert.equal(values.value?.events[2].value, 0.9);
  const shape = compile('across 2 bars: sine 0..1', { type: 'values' });
  assert.deepEqual(shape.diagnostics, []);
  assert.equal(shape.value?.extent.toString(), '2/1');
  assert.equal(shape.value?.shapes[0].name, 'sine');
});
test('checks unselected alternation branches without duplicating extent errors', () => {
  assert.equal(compile('| <[x x] [x x x]> |').diagnostics[0]?.code, 'T001');
  assert.deepEqual(
    compile('| <x(3,8) x(3,7)> |').diagnostics.map((d) => d.code),
    ['T005'],
  );
});
test('very small percent gates remain exact', () => {
  assert.equal(
    compile('| x{length 0.00000001%} |').value?.events[0].gate.toString(),
    '1/10000000000',
  );
  assert.equal(compile('across -1 bars: x').diagnostics[0]?.code, 'R011');
});
test('shape forms enforce range and random step syntax, with empty zero periods', () => {
  assert.equal(compile('ramp 0.5', { type: 'values' }).diagnostics[0]?.code, 'R003');
  assert.equal(compile('random 0..1', { type: 'values' }).diagnostics[0]?.code, 'R003');
  assert.equal(
    compile('random 0..1 every 1/8', { type: 'values' }).value?.shapes[0].every?.toString(),
    '1/8',
  );
  assert.equal(compile('across 0 bars: sine 0..1', { type: 'values' }).value?.shapes.length, 0);
});
test('weighted Euclid ratchets subdivide each onset after expansion', () => {
  const result = compile('| x@2*2(3,8) |');
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.value?.events.map((e) => e.onset.toString()),
    ['0/1', '1/16', '3/8', '7/16', '3/4', '13/16'],
  );
});
test('an inline tuplet must fit its allocated slot', () => {
  const result = compile('| (across 1/8: x x x) x x x |');
  assert.equal(result.diagnostics[0].code, 'R003');
  assert.deepEqual(result.diagnostics[0].measured, { extent: '1/8', required: '1/4' });
});
test('options preserve stage-2 expressions and hold decisions for later realization', () => {
  const result = compile('| x{velocity accent * 0.4, cutoff 50%} _{chance 40%} |');
  assert.deepEqual(result.diagnostics, []);
  const event = result.value!.events[0];
  assert.equal(event.locks.cutoff, 0.5);
  assert.equal(event.fields[0].tokens.join(' '), 'velocity accent * 0.4');
  assert.equal(event.attackSpan.toString(), '1/2');
  assert.equal(event.holds[0].conditions[0].tokens.join(' '), 'chance 40%');
  assert.equal(compile('| x{velocity 50%} |').value!.events[0].velocity, 0.5);
});
test('large combined slot counts use bigint arithmetic', () => {
  const result = compile('| x@4503599627370496 x@4503599627370496 |');
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.value!.events.map((e) => e.onset.toString()),
    ['0/1', '1/2'],
  );
});
test('Euclid diagnostics report one root cause and distinguish expansion limits', () => {
  assert.deepEqual(
    compile('| x(3,7) |').diagnostics.map((d) => d.code),
    ['T001'],
  );
  assert.deepEqual(
    compile('| x(1,0) |').diagnostics.map((d) => d.code),
    ['C005'],
  );
  assert.equal(compile('| x(1,65537) |').diagnostics.at(-1)?.code, 'D001');
});
test('dogfood: parentheses preserve explicit triplet authorization', () => {
  assert.deepEqual(compile('steps (1/16t): x x x').diagnostics, []);
  assert.equal(compile('steps (1/16t): x x x').value!.extent.toString(), '1/8');
});
