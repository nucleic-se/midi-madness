import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../packages/core/src/index.ts';
test('T001 has measured exact time, a musical path and an applicable explicit-tuplet fix', () => {
  let source = 'mm 1\nrhythm three = | x x x |\n';
  const result = check(source),
    d = result.diagnostics[0];
  assert.equal(d.code, 'T001');
  assert.equal(d.path, 'rhythm three');
  assert.equal(d.measured?.slotDuration, '1/3');
  assert.equal(d.fixes.length, 1);
  for (const edit of [...d.fixes[0].edits].reverse()) {
    const lines = source.split('\n'),
      line = lines[edit.span.line - 1];
    lines[edit.span.line - 1] =
      line.slice(0, edit.span.col - 1) + edit.insert + line.slice(edit.span.endCol - 1);
    source = lines.join('\n');
  }
  assert.deepEqual(check(source).diagnostics, []);
});
test('contextual literal extents are allowed in fields and rejected in bindings', () => {
  assert.equal(check('mm 1\nmotif p = across section: 1\n').diagnostics[0]?.code, 'R010');
  assert.deepEqual(check('mm 1\npart pad\n  plays notes across section: 1+5\n').diagnostics, []);
});
test('holds following unresolved named material defer validation to resolution', () => {
  assert.deepEqual(check('mm 1\nmotif hook = | E4 |\nphrase p = hook | _ |\n').diagnostics, []);
  assert.equal(check('mm 1\nmotif p = | _ |\n').diagnostics[0]?.code, 'T002');
  assert.deepEqual(check('mm 1\npart lead\n  plays notes | _ 1 |\n').diagnostics, []);
});
test('uneven pulse durations await occurrence clocks while uniform groups remain exact', () => {
  const uneven = check(
    'mm 1\nsong "Uneven"\n  meter 7/8 pulses 2+2+3\nrhythm r = steps 1 pulse: x x\n',
  );
  assert.deepEqual(uneven.diagnostics, []);
  assert.equal(uneven.literals.length, 0);
  const uniform = check(
    'mm 1\nsong "Uniform"\n  meter 6/8 pulses 2+2+2\nrhythm r = steps 1 pulse: x x\n',
  );
  assert.deepEqual(uniform.diagnostics, []);
  assert.equal(uniform.literals[0].value.extent.toString(), '1/2');
});
test('dogfood: silent sequence material cannot supply a hold', () => {
  for (const source of ['| . | | _ |', '(| . |) | _ |'])
    assert.equal(check(`mm 1\nrhythm r = ${source}\n`).diagnostics[0]?.code, 'T002');
});
