import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../packages/core/src/parser.ts';
import { resolve } from '../packages/core/src/resolve.ts';
import { PRELUDE_SOURCE } from '../packages/core/src/prelude.ts';
import { check } from '../packages/core/src/index.ts';
function run(source: string) {
  return resolve(parse(`mm 1\n${source}`).ast);
}
test('curve/section name clashes report R004 before control realization', () => {
  const definitions = ['section melt = theme theme', 'curve melt = melt 3..9'];
  for (const defs of [definitions, [...definitions].reverse()]) {
    const result = check(`mm 1
song "Clash"
  tempo 120
motif theme = | C4 . . . |.repeat(4)
${defs.join('\n')}
form = melt
part lead
  plays notes | C4 . . . |
  bend = 0 - melt * 0.45
`);
    assert.ok(result.diagnostics.some((d) => d.code === 'R004' && d.message.includes('melt')));
    assert.equal(result.parts, undefined);
  }
});
test('F11: embedded prelude matches the normative file and resolves', () => {
  assert.equal(
    PRELUDE_SOURCE,
    readFileSync(new URL('../packages/core/src/prelude.mm', import.meta.url), 'utf8'),
  );
  assert.deepEqual(run('').diagnostics, []);
});
test('forward references, value functions, method calls and field functions', () => {
  const result = run(
    'motif out = hook.answer(+2)\ndefine answer(m: notes, n: steps) = m.shift(n)\nmotif hook = | E4 |\npart kick\n  plays hits | x |\npart pad\n  use duck(kick, 50%)\n  level = 1\n',
  );
  assert.deepEqual(result.diagnostics, []);
  const part = result.normalized.statements.find((s) => s.kind === 'part' && s.name === 'pad');
  assert(part?.kind === 'part');
  assert.deepEqual(
    part.fields.map((f) => (f.kind === 'field' ? f.name : f.kind)),
    ['level', 'level'],
  );
});
test('unknown names, duplicate definitions, recursion and type mismatch', () => {
  assert.equal(run('motif m = missing\n').diagnostics[0]?.code, 'R001');
  assert.equal(
    run('motif hook = | E4 |\nmotif m = hoook\n').diagnostics[0]?.fixes[0]?.edits[0].insert,
    'hook',
  );
  assert.equal(run('motif a = b\nmotif b = a\n').diagnostics[0]?.code, 'R002');
  assert.equal(run('rhythm r = | x |\nmotif m = r\n').diagnostics[0]?.code, 'R003');
  assert.equal(run('motif a = | E4 |\nmotif a = | G4 |\n').diagnostics[0]?.code, 'R004');
});
test('taint follows aliases, value functions and expanded field functions', () => {
  const result = run(
    'signal p = trigger(k, decay 1/4)\ndefine twice(s: values) = s * 2\nsignal q = twice(p)\ndefine gate(s: values):\n  play when s > 0.5\npart k\n  plays hits | x |\npart a\n  use gate(q)\npart b\n  level = q\n  velocity = q\n',
  );
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ['C007'],
  );
  assert(result.eventDerived.has('q'));
});
