import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, parseExpression } from '../packages/core/src/parser.ts';
const spec = readFileSync(new URL('../docs/reference/LANGUAGE.md', import.meta.url), 'utf8');
const snippets = [...spec.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);

function bodyOf(raw: string): string {
  const lines = raw.split('\n');
  const indentation = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length),
  );
  return lines.map((l) => l.slice(indentation)).join('\n');
}
function parameterContext(body: string): string {
  if (!body.startsWith('cutoff = by section:')) return body;
  const form = body.startsWith('cutoff = by section: verse')
    ? 'section verse = rest(1 bar)\nsection chorus = rest(2 bars)\nform = verse chorus\n'
    : 'section A = rest(1 bar)\nsection B = rest(2 bars)\nform = A B A\n';
  return (
    form +
    'part lead\n  plays notes | C4 . . . |\n' +
    body
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n')
  );
}
function isGrammar(body: string): boolean {
  return (
    body.startsWith('file       =') || body.startsWith('E(k, n):') || body.includes('// error:')
  );
}
for (const [index, raw] of snippets.entries()) {
  const source = bodyOf(raw);
  if (isGrammar(source)) continue;
  test(`normative snippet ${index + 1}: syntax`, () => {
    if (source.startsWith('|')) {
      for (const line of source.split('\n').filter((l) => l.trim()))
        assert.deepEqual(parseExpression(line).diagnostics, [], line);
    } else {
      const contextual = parameterContext(source);
      assert.deepEqual(
        parse(contextual.startsWith('mm 1') ? contextual : `mm 1\n${contextual}`).diagnostics,
        [],
      );
    }
  });
}

import { check } from '../packages/core/src/index.ts';
// Match the example being exercised, rather than its position among code fences.
// Adding a new documented example must not attach another example's context.
const support: { starts: string; source: string }[] = [
  { starts: 'song "Title"', source: 'section A = rest(1 bar)\nform = A\n' },
  {
    starts: 'define pumped(',
    source: 'section A = rest(2 bars)\nform = A\npart kick\n  lane kick\n  plays hits | x |\n',
  },
  {
    starts: 'harmony ',
    source:
      'progression verse = i v VI iv\nsection B = rest(8 bars)\nsection climax = rest(8 bars)\nform = B climax\n',
  },
  {
    starts: 'curve energy',
    source:
      'section intro = rest(1 bar)\nsection A = rest(1 bar)\nsection climax = rest(1 bar)\nsection coda = rest(1 bar)\nform = intro A climax coda\n',
  },
  {
    starts: 'signal pump',
    source:
      'section A = rest(2 bars)\nform = A\npart kick\n  lane kick\n  plays hits | x |\npart snare\n  lane snare\n  plays hits | x |\n',
  },
  {
    starts: 'section A  = theme',
    source: 'motif hook = | 1 3 5 3 |\nphrase theme = hook hook\nform = A\n',
  },
  {
    starts: 'part bass',
    source:
      'section drop = rest(2 bars)\nform = drop\nwhen groove = always\nsignal pump = trigger(kick, decay 1/4)\npart kick\n  lane kick\n  plays hits | x |\n',
  },
  {
    starts: 'silence before',
    source: 'section drop = rest(2 bars)\nsection drop2 = rest(2 bars)\nform = drop drop2\n',
  },
  {
    starts: 'expect form',
    source:
      'section drop = rest(16 bars)\nsection break = rest(8 bars)\nsection bridge = rest(8 bars)\nform = drop break bridge\npart lead\n  plays notes | D4 |\npart bass\n  role low\n  plays notes | D2 |\npart hat\n  lane hat\n  plays hits across 1 bar: x x x x x x\npart kick\n  lane kick\n  plays hits | x |\n  play when not in break\npart pad\n  plays chords\n',
  },
];
for (const [index, raw] of snippets.entries()) {
  const source = bodyOf(raw);
  if (
    isGrammar(source) ||
    (source.includes('define delay(') && source.includes('define entry-hit('))
  )
    continue;
  test(`F11 normative snippet ${index + 1}: semantic context`, () => {
    let body = source;
    if (body.startsWith('|')) {
      body = body
        .split('\n')
        .filter((l) => l.trim())
        .map(
          (line, i) => `${i === 1 ? 'motif' : i >= 4 ? 'signal' : 'rhythm'} sample-${i} = ${line}`,
        )
        .join('\n');
    }
    body = parameterContext(body);
    const result = check(
      (body.startsWith('mm 1') ? '' : 'mm 1\n') +
        body +
        '\n' +
        (support.find((s) => source.startsWith(s.starts))?.source ?? ''),
    );
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    if (source.startsWith('expect form')) {
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
