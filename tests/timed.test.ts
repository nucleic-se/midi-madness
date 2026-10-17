import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileLiteral } from '../packages/core/src/literals.ts';
import { parseExpression } from '../packages/core/src/parser.ts';
import { sequenceTimed } from '../packages/core/src/timed.ts';
function value(source: string) {
  const expression = parseExpression(source).expression!;
  assert(expression.kind === 'literal');
  return compileLiteral(expression, { type: 'notes', allowLeadingHold: true }).value!;
}
test('holds cross sequence elements; composition keeps input values unchanged', () => {
  const a = value('| E4+B4{length 50%} |'),
    b = value('| _ |');
  const result = sequenceTimed([a, b], 'notes');
  assert.equal(result.extent.toString(), '2/1');
  assert.equal(result.events[0].writtenSpan.toString(), '2/1');
  assert.equal(result.events[0].gate.toString(), '1/1');
  assert.equal(a.events[0].writtenSpan.toString(), '1/1');
  assert.equal(a.events[0].gate.toString(), '1/2');
  assert.equal(result.leadingHolds.length, 0);
});
test('sequence shifts event onsets and retains leading cycle holds', () => {
  const result = sequenceTimed([value('| _ |'), value('| E4 |')], 'notes');
  assert.equal(result.extent.toString(), '2/1');
  assert.equal(result.events[0].onset.toString(), '1/1');
  assert.equal(result.leadingHolds[0].onset.toString(), '0/1');
});
