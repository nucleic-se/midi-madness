import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse, parseExpression } from '../packages/core/src/parser.ts';
import { check } from '../packages/core/src/index.ts';
import { parseKey, parseChord, resolvePitches } from '../packages/core/src/pitch.ts';
import { expandBinding } from '../packages/core/src/expand.ts';
import { resolve } from '../packages/core/src/resolve.ts';
import { compileLiteral } from '../packages/core/src/literals.ts';
for (const file of readdirSync(new URL('./fixtures/', import.meta.url))
  .filter((f) => f.endsWith('.mm'))
  .sort()) {
  test(file, () => {
    const source = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8');
    const expected = JSON.parse(
      readFileSync(
        new URL(`./fixtures/${file.replace('.mm', '.expected.json')}`, import.meta.url),
        'utf8',
      ),
    );
    const result = file.startsWith('G') ? parse(source) : check(source);
    assert.deepEqual(
      result.diagnostics.map((d) => d.code),
      expected.codes,
    );
    if (expected.pitchContexts?.length) {
      const resolution = resolve(parse(source).ast),
        key = parseKey(expected.key);
      for (const [name, chord, pitches] of expected.pitchContexts) {
        const expanded = expandBinding(resolution, name).value!;
        assert.deepEqual(
          resolvePitches(expanded, key, () => parseChord(chord, key)).value.events.flatMap(
            (e) => e.pitchNumbers!,
          ),
          pitches,
        );
      }
    }
    if (expected.chords) {
      const expanded = expandBinding(resolve(parse(source).ast), 'chords').value!;
      assert.deepEqual(
        expanded.chords.map((c) => parseChord(c.symbol, parseKey(expected.key)).tones),
        expected.chords,
      );
    }
    if (expected.extent) {
      const expanded = expandBinding(resolve(parse(source).ast), 'empty').value!;
      assert.equal(expanded.extent.toString(), expected.extent);
      assert.equal(expanded.events.length, expected.events);
    }
    if (expected.durations || expected.onsets) {
      const values = result.ast.statements
        .filter((s) => s.kind === 'binding')
        .map((s) => {
          const expression = s.value.elements[0];
          assert(expression.kind === 'literal');
          return compileLiteral(expression, { type: s.keyword === 'rhythm' ? 'hits' : 'notes' })
            .value!;
        });
      if (expected.pitchContexts?.length) {
        const resolution = resolve(parse(source).ast),
          key = parseKey(expected.key);
        for (const [name, chord, pitches] of expected.pitchContexts) {
          const expanded = expandBinding(resolution, name).value!;
          assert.deepEqual(
            resolvePitches(expanded, key, () => parseChord(chord, key)).value.events.flatMap(
              (e) => e.pitchNumbers!,
            ),
            pitches,
          );
        }
      }
      if (expected.chords) {
        const expanded = expandBinding(resolve(parse(source).ast), 'chords').value!;
        assert.deepEqual(
          expanded.chords.map((c) => parseChord(c.symbol, parseKey(expected.key)).tones),
          expected.chords,
        );
      }
      if (expected.extent) {
        const expanded = expandBinding(resolve(parse(source).ast), 'empty').value!;
        assert.equal(expanded.extent.toString(), expected.extent);
        assert.equal(expanded.events.length, expected.events);
      }
      if (expected.durations)
        assert.deepEqual(
          values[0].events.map((e) => e.writtenSpan.toString()),
          expected.durations,
        );
      if (expected.onsets)
        assert.deepEqual(
          values.map((v) => v.events.map((e) => e.onset.toString())),
          expected.onsets,
        );
    }
    if (expected.sequenceLength) {
      const statement = result.ast.statements[0];
      assert.equal(statement.kind, 'binding');
      if (statement.kind === 'binding')
        assert.equal(statement.value.elements.length, expected.sequenceLength);
    }
  });
}
test('G01 expression precedence and left association', () => {
  const expressions = ['0.55 + 0 * 0.4', '2 * 0.75 - 1', '8 / 4 / 2', '(0.55 + 0) * 0.4'];
  const shapes = ['+', '-', '/', '*'];
  expressions.forEach((source, i) => {
    const result = parseExpression(source);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.expression?.kind, 'binary');
    if (result.expression?.kind === 'binary') assert.equal(result.expression.operator, shapes[i]);
  });
});
