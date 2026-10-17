import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJSON, generator, splitMix64, xoshiro256 } from '../packages/core/src/random.ts';
test('canonical addresses and normative integer generators', () => {
  assert.equal(canonicalJSON(['mm2', 1, 'chance', '1/8']), '["mm2",1,"chance","1/8"]');
  assert.equal(splitMix64(0n)(), 0xe220a8397b1dcdafn);
  assert.equal(xoshiro256(0n)(), 0x99ec5f36cb75f2b4n);
  const a = generator(['mm2', 1, 'vary']),
    b = generator(['mm2', 1, 'vary']);
  assert.deepEqual(Array.from({ length: 8 }, a), Array.from({ length: 8 }, b));
});
