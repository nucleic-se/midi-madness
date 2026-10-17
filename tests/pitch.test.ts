import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChord, parseKey, resolvePitch, resolvePitches } from '../packages/core/src/pitch.ts';
import { compileLiteral } from '../packages/core/src/literals.ts';
import { parseExpression } from '../packages/core/src/parser.ts';
function pitches(source: string, key = 'C major', symbol = 'N') {
  const parsed = parseExpression(source).expression!;
  assert(parsed.kind === 'literal');
  const value = compileLiteral(parsed, { type: 'notes' }).value!;
  const context = parseKey(key);
  return resolvePitches(value, context, () => parseChord(symbol, context)).value.events.flatMap(
    (e) => e.pitchNumbers!,
  );
}
test('P01 absolute enharmonics and nearest octave', () => {
  assert.deepEqual(
    ['C4', 'B#3', 'Cb4'].map((p) => resolvePitch(p)),
    [60, 60, 59],
  );
  assert.deepEqual(pitches('across 1 bar: E4 G C'), [64, 67, 72]);
});
test('P02 chord tones under minor tonic and major fourth', () => {
  assert.deepEqual(pitches('| c1 c3 c5 c3 |', 'E dorian', 'i'), [64, 67, 71, 67]);
  assert.deepEqual(pitches('| c1 c3 c5 c3 |', 'E dorian', 'IV'), [69, 73, 76, 73]);
});
test('P03 degrees and octave modifiers', () =>
  assert.deepEqual(pitches('| 1 3 5 7v |', 'D dorian'), [62, 65, 69, 60]));
test('P04 upward stacks and secondary dominants', () =>
  assert.deepEqual(pitches('| c1+c3+c5 |', 'C major', 'V7/V'), [62, 66, 69]));
test('P05 missing extensions and N use diatonic degrees', () => {
  assert.deepEqual(pitches('| c3 |'), [64]);
  assert.equal(pitches('| c7 |', 'C major', 'IV')[0] % 12, 4);
});
test('P06 scale shift after chord-tone resolution', () => {
  const parsed = parseExpression('| c1 c3 |').expression!;
  assert(parsed.kind === 'literal');
  const value = compileLiteral(parsed, { type: 'notes' }).value!;
  value.events.forEach((e) =>
    e.operations.push({
      name: 'shift',
      args: [
        {
          kind: 'sequence',
          elements: [{ kind: 'number', text: '+1', span: e.source.span }],
          span: e.source.span,
        },
      ],
      span: e.source.span,
    }),
  );
  const key = parseKey('A minor');
  assert.deepEqual(
    resolvePitches(value, key, () => parseChord('i', key)).value.events.flatMap(
      (e) => e.pitchNumbers!,
    ),
    [71, 74],
  );
});
test('H03 chords, secondary dominants, alterations, diminished and inversions', () => {
  const key = parseKey();
  assert.deepEqual(
    ['V7/V', 'bVII', 'viio', 'I/3'].map((s) => parseChord(s, key).tones),
    [
      [2, 6, 9, 0],
      [10, 2, 5],
      [11, 2, 5],
      [0, 4, 7],
    ],
  );
  assert.equal(parseChord('I/3').bass, 4);
  assert.throws(() => parseChord('wat'), RangeError);
});
