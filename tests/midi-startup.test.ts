import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realize } from '../packages/core/src/index.ts';
import { parseSetup, resolveRig } from '../packages/midi/src/config.ts';
import { compileMidi } from '../packages/midi/src/compile.ts';
const source =
  'mm 1\nsong "Startup"\n  tempo 120\n  humanize off\n  dynamics flat\nsection A = | C4 |\nform = A\npart lead\n  plays melody\n';
test('M07: patch selection, load wait and final defaults precede all notes', () => {
  const r = realize(source),
    rig = resolveRig(
      parseSetup(
        'setup rig\n  port main = "none"\n  lead = direct port:main ch:1 program:ram-a/100\n    program bank:cc0+cc32 select:pc base:1\n    banks ram-a:0/0\n    program-lead 500ms\n    param cutoff cc:40 default:0.5\n    set cutoff 0.35\n',
      ).setup!,
      {},
      r.song!.parts,
    ),
    t = compileMidi(r, rig);
  assert.deepEqual(t.messages[0].data, [
    [176, 0, 0],
    [176, 32, 0],
    [192, 99],
  ]);
  const initial = t.messages.find((m) => m.startup && m.parameter === 'cutoff')!;
  assert.deepEqual(initial.data, [[176, 40, 44]]);
  assert.ok(initial.tick >= 960n);
  assert.ok(t.messages.find((m) => m.priority === 3)!.tick > initial.tick);
  assert.equal(t.messages.filter((m) => m.data.some((d) => (d[0] & 240) === 192)).length, 1);
});
test('required traffic overload remains an error after interior thinning', () => {
  const r = realize(source + '  cutoff = sine 0..1\n'),
    rig = resolveRig(
      parseSetup(
        'setup rig\n  port main = "none" rate:20\n  lead = direct port:main ch:1\n    param cutoff cc:40 rate:100\n',
      ).setup!,
      {},
      r.song!.parts,
    ),
    t = compileMidi(r, rig);
  const d = t.diagnostics.find((d) => d.code === 'D005')!;
  assert.equal(d.severity, 'error');
  assert.equal(d.fixes.length, 0);
  assert.match(d.message, /Required MIDI traffic/);
  assert.match(d.message, /cutoff/);
});
