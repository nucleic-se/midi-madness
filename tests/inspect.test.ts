import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realize, roll, at, metrics, Rational as R } from '../packages/core/src/index.ts';
const source =
  'mm 1\nsong "Inspect"\n  dynamics flat\n  humanize off\nsection A = (| D4 |).repeat(2)\nform = A\npart lead\n  plays melody\n';
test('inspection shows bars, pitches, sustains and measured metrics', () => {
  const song = realize(source).song!;
  assert.match(roll(song, 'lead', 1, 2), /D4 \|x/);
  assert.equal(at(song, new R(1, 2)).sounding[0].part, 'lead');
  assert.equal(metrics(song)[0].parts[0].onsets, 2);
});
test('failed expectation carries measured and required values', () => {
  const r = realize(source + 'expect form length 3 bars\n');
  const d = r.diagnostics.find((d) => d.code === 'X001')!;
  assert.equal(d.measured?.actual?.toString(), '2/1');
  assert.equal(d.measured?.expected?.toString(), '3/1');
});

import { musicalDiff, formatSource } from '../packages/core/src/index.ts';
test('H05: changing one chord exposes following voice-leading changes until convergence', () => {
  const base =
      'mm 1\nsong "Voicings"\n  humanize off\n  dynamics flat\nsection A = rest(4 bars)\nform = A\nharmony = I IV V I\npart pad\n  plays chords\n',
    a = realize(base).song!,
    b = realize(base.replace('I IV V I', 'I ii V I')).song!,
    diff = musicalDiff(a, b);
  assert.equal(diff.parts[0].name, 'pad');
  assert.ok(diff.parts[0].changed.length > 0);
  assert.ok(diff.parts[0].changed.every((e) => e.after!.onset.compare(new R(1)) >= 0));
  for (let bar = 0; bar < 4; bar++) {
    const old = a.parts[0].events
        .filter((e) => e.nominalOnset.equals(new R(bar)))
        .map((e) => e.pitch),
      next = b.parts[0].events.filter((e) => e.nominalOnset.equals(new R(bar))).map((e) => e.pitch);
    if (JSON.stringify(old) !== JSON.stringify(next))
      assert.ok(diff.parts[0].changed.some((e) => e.after?.onset.equals(new R(bar))));
  }
});
test('score formatting preserves comments and event meaning', () => {
  const text = source.replace('  plays melody', '    plays melody  // keep this\n\n'),
    formatted = formatSource(text);
  assert.match(formatted, /  plays melody  \/\/ keep this/);
  assert.equal(formatSource(formatted), formatted);
  assert.deepEqual(musicalDiff(realize(text).song!, realize(formatted).song!).parts, []);
});
test('pitch edits preserve unrelated humanization draws', () => {
  const base = source
      .replace('  humanize off\n', '')
      .replace('(| D4 |).repeat(2)', '| D4 E4 F4 G4 |'),
    a = realize(base).song!,
    b = realize(base.replace('D4 E4', 'C4 E4')).song!;
  assert.deepEqual(
    a.parts[0].events.map((e) => e.performedOnset),
    b.parts[0].events.map((e) => e.performedOnset),
  );
  assert.equal(musicalDiff(a, b).parts[0].changed.length, 1);
});
