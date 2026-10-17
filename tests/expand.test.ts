import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../packages/core/src/parser.ts';
import { resolve } from '../packages/core/src/resolve.ts';
import { expandBinding } from '../packages/core/src/expand.ts';
function run(source: string, name: string) {
  const resolution = resolve(parse(`mm 1\n${source}`).ast);
  assert.deepEqual(resolution.diagnostics, []);
  return expandBinding(resolution, name);
}
test('L02 and zero spans preserve type and exact extent', () => {
  const value = run('motif empty = rest(4 bars).slow(2).fit(3 bars)', 'empty').value!;
  assert.equal(value.extent.toString(), '3/1');
  assert.equal(value.events.length, 0);
  assert.equal(run('rhythm empty = (| x |).loop(0 bars)', 'empty').value?.extent.toString(), '0/1');
  assert.equal(run('motif bad = (| E4 |).fast(0)', 'bad').diagnostics[0]?.code, 'R011');
});
test('typed silence: notes/hits empty, harmony N, values absent', () => {
  for (const [keyword, type] of [
    ['motif', 'notes'],
    ['rhythm', 'hits'],
    ['signal', 'values'],
    ['progression', 'harmony'],
  ]) {
    const value = run(`${keyword} s = rest(1 bar)`, 's').value!;
    assert.equal(value.type, type);
    assert.equal(value.extent.toString(), '1/1');
    assert.equal(value.events.length, 0);
    assert.equal(value.chords[0]?.symbol, type === 'harmony' ? 'N' : undefined);
  }
});
test('F12: cadence ending can fill the entire progression', () => {
  const result = run(
    'progression verse = i v VI iv\nprogression result = verse.cadence(i v VI iv)',
    'result',
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.value?.extent.toString(), '4/1');
  assert.deepEqual(
    result.value?.chords.map((c) => c.symbol),
    ['i', 'v', 'VI', 'iv'],
  );
});
test('resolved sequence holds depend on events, not names or rest spans', () => {
  assert.equal(
    run('rhythm empty = rest(1 bar)\nrhythm result = empty | _ |', 'result').diagnostics[0]?.code,
    'T002',
  );
  const result = run('motif hook = | E4 |\nmotif result = hook | _ |', 'result').value!;
  assert.equal(result.events[0].writtenSpan.toString(), '2/1');
});
test('L03 deterministic function and inline body have the same candidate events', () => {
  const source =
    'motif hook = | E4 G4 |\ndefine answer(m: notes) = m.shift(+2)\nmotif called = answer(hook)\nmotif inline = hook.shift(+2)';
  const summary = (name: string) =>
    run(source, name).value!.events.map((e) => [
      e.onset.toString(),
      e.writtenSpan.toString(),
      e.pitches,
      e.operations.map((o) => o.name),
    ]);
  assert.deepEqual(summary('called'), summary('inline'));
});
