import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rational as R } from '@midi-madness/foundation/time';
test('normalizes signs, common factors, and zero', () => {
  assert.equal(new R(6, -8).toString(), '-3/4');
  assert.equal(new R(0, -7).toString(), '0/1');
  assert.equal(R.parse('-0.125').toString(), '-1/8');
  assert.equal(R.parse('1/16').toString(), '1/16');
});
test('time arithmetic remains exact beyond safe numeric integers', () => {
  const huge = new R(2n ** 100n, 3n);
  assert.equal(huge.add(new R(1, 16)).sub(huge).toString(), '1/16');
  assert.equal(new R(1, 16).mul(new R(3)).div(new R(2)).toString(), '3/32');
  assert.equal(new R(1, 3).add(new R(2, 3)).toString(), '1/1');
  assert.equal(JSON.stringify(new R(3, 2)), '"3/2"');
});
test('floor and modulo work at negative timeline positions', () => {
  assert.equal(new R(-1, 4).floor(), -1n);
  assert.equal(new R(-1, 4).mod(new R(1)).toString(), '3/4');
  assert(new R(1, 16).compare(new R(1, 8)) < 0);
});
test('rejects zero denominators, unsafe numbers and malformed input', () => {
  assert.throws(() => new R(1, 0), RangeError);
  assert.throws(() => new R(0.1), RangeError);
  assert.throws(() => new R(Number.MAX_SAFE_INTEGER + 1), RangeError);
  assert.throws(() => R.parse('1/0'), RangeError);
  assert.throws(() => R.parse('1e-3'), RangeError);
  assert.throws(() => new R(1).div(new R(0)), RangeError);
});
