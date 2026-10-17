import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../packages/core/src/parser.ts';
import { resolve } from '../packages/core/src/resolve.ts';
import { expandBinding } from '../packages/core/src/expand.ts';
import { resolvePitches } from '../packages/core/src/pitch.ts';
function run(body: string, name = 'out') {
  const r = resolve(parse(`mm 1\n${body}`).ast);
  assert.deepEqual(r.diagnostics, []);
  const result = expandBinding(r, name);
  assert.deepEqual(result.diagnostics, []);
  return result.value!;
}
test('F01–F03 extent, parallel material and prelude crop/delay', () => {
  const source = 'motif hook = | E4 G4 | A4 B4 |\n';
  assert.equal(run(source + 'motif out = hook.window(1 bar, 2 bars)').extent.toString(), '1/1');
  assert.deepEqual(
    run(source + 'motif out = hook.window(1 bar, 2 bars)').events.map((e) => e.pitches),
    [['A4'], ['B4']],
  );
  assert.equal(run(source + 'motif out = hook.truncate(1/2 bar)').extent.toString(), '3/2');
  assert.equal(run(source + 'motif out = hook.delay(1/8)').events[0].onset.toString(), '1/8');
  assert.equal(
    run(
      'motif a = | E4 | E4 |\nmotif b = | G4 | G4 | G4 |\nmotif out = together(a, b)',
    ).extent.toString(),
    '3/1',
  );
});
test('C09 where acts before subsequent reverse', () => {
  const v = run(
    'motif hook = | E4 F4 G4 A4 |\nmotif out = hook.where(last note of phrase: shift(+1)).reverse',
  );
  assert.deepEqual(
    resolvePitches(v).value.events.flatMap((e) => e.pitchNumbers!),
    [71, 67, 65, 64],
  );
});
test('L01, L03, L04: normalization, call independence and seed scope', () => {
  const source =
    'rhythm five = steps 1/16: x x x x x\nrhythm named = five.rotate(1/16).vary(1)\nrhythm out = named\n';
  const summary = (v: ReturnType<typeof run>) =>
    v.events.map((e) => [
      e.onset.toString(),
      e.writtenSpan.toString(),
      e.pitches,
      e.operations.map((o) => o.name),
    ]);
  assert.deepEqual(
    summary(run(source)),
    summary(run(source.replace('rhythm out = named', 'rhythm out = five.rotate(1/16).vary(1)'))),
  );
  const melody = 'motif hook = | C4 D4 E4 F4 G4 A4 B4 C5 |\n';
  assert.notDeepEqual(
    summary(run(melody + 'motif out = hook.vary(2)')),
    summary(run(melody + 'motif out = hook.vary(2).seed(7)')),
  );
  const calls = run(melody + 'define v(m: notes) = m.vary(2)\nmotif out = v(hook) v(hook)');
  assert.notDeepEqual(
    resolvePitches({ ...calls, events: calls.events.slice(0, 8) }).value.events.map(
      (e) => e.pitchNumbers,
    ),
    resolvePitches({ ...calls, events: calls.events.slice(8) }).value.events.map(
      (e) => e.pitchNumbers,
    ),
  );
});
test('L05 on takes timing, spans and velocities from hits', () => {
  const v = run(
    'motif melody = | C4 D4 E4 F4 |\nrhythm r = steps 1/16: X x o x x\nmotif out = melody.on(r)',
  );
  assert.equal(v.extent.toString(), '5/16');
  assert.deepEqual(
    v.events.map((e) => e.pitches),
    [['C4'], ['D4'], ['E4'], ['F4'], ['C4']],
  );
  assert.deepEqual(
    v.events.map((e) => e.velocity),
    [1, 0.8, 0.4, 0.8, 0.8],
  );
});
test('C03–C05 alternation uses explicit copy and occurrence position', () => {
  const harmony = run('progression out = i IV <VI iv> V.loop(8 bars)', 'out');
  const pattern = run('rhythm out = (| x <x o> |).repeat(4)');
  assert.deepEqual(
    pattern.events.filter((e) => e.source.slot[1] === 1).map((e) => e.velocity),
    [0.8, 0.4, 0.8, 0.4],
  );
  const progression = run('progression p = i IV <VI iv> V\nprogression out = p.loop(8 bars)');
  assert.deepEqual(
    progression.chords
      .filter((c) => c.onset.toString() === '2/1' || c.onset.toString() === '6/1')
      .map((c) => c.symbol),
    ['VI', 'iv'],
  );
  const sequence = run(
    'motif k = | C4 |\nmotif x = | E4 |\nmotif y = | G4 |\nphrase p = k <x y>\nsection out = p p',
  );
  assert.deepEqual(
    sequence.events.map((e) => e.pitches[0]),
    ['C4', 'E4', 'C4', 'G4'],
  );
});
test('F02: parallel extents retain both sources and shorter material ends', () => {
  const value = run(
    'motif a = | C4 | C4 |\nmotif b = | E4 | E4 | E4 |\nmotif out = together(a, b)',
  );
  assert.equal(value.extent.toString(), '3/1');
  assert.equal(value.events.length, 5);
  assert.deepEqual(
    value.events.filter((e) => e.onset.toString() === '2/1').map((e) => e.pitches),
    [['E4']],
  );
  assert.equal(new Set(value.events.map((e) => e.source.literal.line)).size, 2);
});
test('F05: cadence replaces the end of a progression', () => {
  assert.deepEqual(
    run('progression verse = i v VI iv\nprogression out = verse.cadence(V i)').chords.map(
      (c) => c.symbol,
    ),
    ['i', 'v', 'V', 'i'],
  );
  assert.deepEqual(
    run('progression pop = I vi IV V\nprogression out = pop.cadence(V I)').chords.map(
      (c) => c.symbol,
    ),
    ['I', 'vi', 'V', 'I'],
  );
});
test('recursive source figure grows four attacks to sixteen then sixty-four', () => {
  const source = 'motif seed = | 1 3 4 5 |\n';
  assert.equal(run(source + 'motif out = seed.recurse(2)').events.length, 64);
  assert.equal(run(source + 'motif out = seed.recurse.recurse').events.length, 64);
});
