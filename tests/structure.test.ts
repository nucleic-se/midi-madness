import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../packages/core/src/parser.ts';
import { resolve } from '../packages/core/src/resolve.ts';
import { buildStructure, keyAt, sectionAt } from '../packages/core/src/structure.ts';
import { installHarmony, voiceLead } from '../packages/core/src/harmony.ts';
import { resolvePitches, parseChord } from '../packages/core/src/pitch.ts';
import { expandBinding } from '../packages/core/src/expand.ts';
import { Rational as R } from '@midi-madness/foundation/time';
function song(source: string) {
  const r = resolve(parse(source).ast);
  assert.deepEqual(r.diagnostics, []);
  const s = buildStructure(r);
  assert.deepEqual(s.diagnostics, []);
  return { r, s: s.structure! };
}
test('partial sections restart bar numbering and keep exact form extent', () => {
  const { s } = song(
    readFileSync(new URL('./fixtures/scores/five_against_the_tide.mm', import.meta.url), 'utf8'),
  );
  assert.equal(s.extent.toString(), '47/2');
  assert.deepEqual(
    s.sections.map((f) => [f.name, f.extent.toString()]),
    [
      ['intro', '4/1'],
      ['A', '8/1'],
      ['bridge', '7/2'],
      ['A2', '8/1'],
    ],
  );
  assert.equal(s.bars.length, 24);
  assert.equal(s.bars[15].span.toString(), '1/2');
  assert.equal(s.bars[16].sectionBar, 1);
});
test('C03 installed progressions loop with alternation and restart per occurrence', () => {
  const { r, s } = song(
    'mm 1\nsection B = rest(8 bars)\nform = B B\nharmony in B = III VII <VI iv> V\n',
  );
  const h = installHarmony(r, s);
  assert.deepEqual(h.diagnostics, []);
  assert.equal(h.chordAt(new R(2)).symbol, 'VI');
  assert.equal(h.chordAt(new R(6)).symbol, 'iv');
  assert.equal(h.chordAt(new R(10)).symbol, 'VI');
});
test('H01/H02 modulation affects notes at onset once; carried notes retain pitch', () => {
  const { r, s } = song(
    'mm 1\nsection A = rest(1 bar)\nsection B = | 1 C4 |\nform = A B.modulate(+2)\nharmony = I\nmotif line = | C4 | _ | C4 |\n',
  );
  const h = installHarmony(r, s);
  assert.equal(h.chordAt(new R(1)).root, 2);
  const result = resolvePitches(
    s.material,
    (t) => keyAt(s, t),
    h.chordAt,
    (t) => sectionAt(s, t)?.modulation ?? 0,
  );
  assert.deepEqual(
    result.value.events.flatMap((e) => e.pitchNumbers!),
    [62, 62],
  );
  const moved = {
    ...s.material,
    events: s.material.events.map((e) => ({
      ...e,
      operations: [
        ...e.operations,
        {
          name: 'transpose',
          args: [
            {
              kind: 'sequence' as const,
              elements: [{ kind: 'number' as const, text: '+3', span: e.source.span }],
              span: e.source.span,
            },
          ],
          span: e.source.span,
        },
      ],
    })),
  };
  assert.deepEqual(
    resolvePitches(
      moved,
      (t) => keyAt(s, t),
      h.chordAt,
      (t) => sectionAt(s, t)?.modulation ?? 0,
    ).value.events.flatMap((e) => e.pitchNumbers!),
    [65, 65],
  );
  const line = expandBinding(r, 'line').value!;
  assert.deepEqual(
    resolvePitches(
      line,
      (t) => keyAt(s, t),
      h.chordAt,
      (t) => sectionAt(s, t)?.modulation ?? 0,
    ).value.events.flatMap((e) => e.pitchNumbers!),
    [60, 60],
  );
});
test('voice leading minimizes movement with deterministic lower ties', () => {
  const first = voiceLead(parseChord('I'), [48, 72]);
  assert.deepEqual(first, [48, 52, 55]);
  const next = voiceLead(parseChord('IV'), [48, 72], first);
  assert.deepEqual(next, [48, 53, 57]);
  assert.deepEqual(voiceLead(parseChord('N'), [48, 72], next), []);
});
