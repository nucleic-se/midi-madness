import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpression } from '../packages/core/src/parser.ts';
import { perValue } from '../packages/core/src/constants.ts';
import { Rational as R } from '@midi-madness/foundation/time';
test('long immutable data lanes decode constants once while repeated samples interpolate and wrap', () => {
  const expression = parseExpression(
    `per 1/16 smooth: ${Array.from({ length: 2048 }, (_, i) => i).join(', ')}`,
  ).expression!;
  assert.equal(expression.kind, 'call');
  if (expression.kind !== 'call') throw Error('Expected lane');
  const value = expression.args[2];
  if (value.kind !== 'sequence' || value.elements[0].kind !== 'number')
    throw Error('Expected value');
  const literal = value.elements[0],
    text = literal.text;
  let reads = 0;
  Object.defineProperty(literal, 'text', {
    get() {
      reads++;
      return text;
    },
  });
  perValue(expression, new R(0), [4, 4]);
  const initialReads = reads;
  for (let i = 0; i < 1024; i++)
    assert.equal(perValue(expression, new R(i, 32), [4, 4]).toString(), new R(i, 2).toString());
  assert.equal(perValue(expression, new R(4095, 32), [4, 4]).toString(), '2047/2');
  assert.equal(perValue(expression, new R(128), [4, 4]).toString(), '0/1');
  assert.equal(reads, initialReads, `Literal reparsed ${reads} times`);
});
test('lane sampling cache preserves meter-dependent spans', () => {
  const expression = parseExpression('per 1 bar smooth: 0, 1').expression!;
  if (expression.kind !== 'call') throw Error('Expected lane');
  assert.equal(perValue(expression, new R(1, 2), [4, 4]).toString(), '1/2');
  assert.equal(perValue(expression, new R(1, 2), [6, 8]).toString(), '2/3');
  assert.equal(perValue(expression, new R(1, 2), [4, 4]).toString(), '1/2');
});
