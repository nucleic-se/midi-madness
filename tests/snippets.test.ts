import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, parseExpression } from '../packages/core/src/parser.ts';
const spec = readFileSync(new URL('../docs/reference/LANGUAGE.md', import.meta.url), 'utf8');
const snippets = [...spec.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
for (const [index, raw] of snippets.entries()) {
  if (raw.startsWith('file       =') || raw.startsWith('E(k, n):') || raw.includes('// error:'))
    continue;
  const lines = raw.split('\n');
  const indentation = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length),
  );
  const source = lines.map((l) => l.slice(indentation)).join('\n');
  test(`normative snippet ${index + 1}: syntax`, () => {
    if (source.startsWith('|')) {
      for (const line of source.split('\n').filter((l) => l.trim()))
        assert.deepEqual(parseExpression(line).diagnostics, [], line);
    } else
      assert.deepEqual(
        parse(source.startsWith('mm 1') ? source : `mm 1\n${source}`).diagnostics,
        [],
      );
  });
}

import { check } from '../packages/core/src/index.ts';
const support: Record<number, string> = {
  2: 'section A = rest(1 bar)\nform = A\n',
  5: 'section A = rest(2 bars)\nform = A\npart kick\n  lane kick\n  plays hits | x |\n',
  7: 'progression verse = i v VI iv\nsection B = rest(8 bars)\nsection climax = rest(8 bars)\nform = B climax\n',
  8: 'section intro = rest(1 bar)\nsection A = rest(1 bar)\nsection climax = rest(1 bar)\nsection coda = rest(1 bar)\nform = intro A climax coda\n',
  9: 'section A = rest(2 bars)\nform = A\npart kick\n  lane kick\n  plays hits | x |\npart snare\n  lane snare\n  plays hits | x |\n',
  10: 'motif hook = | 1 3 5 3 |\nphrase theme = hook hook\nform = A\n',
  11: 'section drop = rest(2 bars)\nform = drop\nwhen groove = always\nsignal pump = trigger(kick, decay 1/4)\npart kick\n  lane kick\n  plays hits | x |\n',
  12: 'section drop = rest(2 bars)\nsection drop2 = rest(2 bars)\nform = drop drop2\n',
  13: 'section drop = rest(16 bars)\nsection break = rest(8 bars)\nsection bridge = rest(8 bars)\nform = drop break bridge\npart lead\n  plays notes | D4 |\npart bass\n  role low\n  plays notes | D2 |\npart hat\n  lane hat\n  plays hits across 1 bar: x x x x x x\npart kick\n  lane kick\n  plays hits | x |\n  play when not in break\npart pad\n  plays chords\n',
};
for (const [index, raw] of snippets.entries()) {
  const id = index + 1;
  if ([14, 15, 16].includes(id)) continue;
  test(`F11 normative snippet ${id}: semantic context`, () => {
    const lines = raw.split('\n'),
      indentation = Math.min(
        ...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length),
      );
    let body = lines.map((l) => l.slice(indentation)).join('\n');
    if (id === 3) {
      body = body
        .split('\n')
        .filter((l) => l.trim())
        .map(
          (line, i) => `${i === 1 ? 'motif' : i >= 4 ? 'signal' : 'rhythm'} sample-${i} = ${line}`,
        )
        .join('\n');
    }
    const result = check(
        (body.startsWith('mm 1') ? '' : 'mm 1\n') + body + '\n' + (support[id] ?? ''),
      ),
      errors = result.diagnostics.filter((d) => d.severity === 'error');
    if (id === 13) {
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /Device expectations require a setup/);
    } else assert.deepEqual(errors, []);
  });
}
test('F11 prelude functions and gestures have semantic call contexts', () => {
  const r = check(
    'mm 1\nmotif hook = | 1 3 5 3 |\nprogression changes = I vi IV V\nmotif delayed = hook.delay(1/8)\nmotif truncated = hook.truncate(1/2 bar)\nmotif sliced = hook.window(0 bars, 1 bar)\nmotif padded = hook.pad(2 bars)\nmotif canon-line = canon(hook, 1/8)\nmotif doubled = double(hook, +2)\nmotif octaved = octaves(hook)\nprogression ending = changes.cadence(V I)\nsection drop = rest(8 bars)\nform = drop\npart kick\n  lane kick\n  use entry-hit(in drop)\npart pad\n  use drone()\n  use duck(kick, 50%)\npart rise\n  use riser()\n',
  );
  assert.deepEqual(
    r.diagnostics.filter((d) => d.severity === 'error'),
    [],
  );
});
