import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realize } from '../packages/core/src/index.ts';
import { parseSetup, resolveRig, implicitRig } from '../packages/midi/src/config.ts';
import { compileNotes } from '../packages/midi/src/notes.ts';
function song() {
  return realize(
    'mm 1\nsong "Notes"\n  humanize off\n  dynamics flat\nsection A = | C4 D4 |\nform = A\npart lead\n  plays melody\n  length 1 bar\n',
  ).song!;
}
function run(legato: boolean) {
  const s = song(),
    rig = resolveRig(
      parseSetup(
        `setup test\n  port main = "none"\n  lead = direct port:main ch:1\n    voices mono${legato ? '\n    glide legato' : ''}\n`,
      ).setup!,
      {},
      s.parts,
    );
  return compileNotes(s, rig);
}
test('M01/M02: mono overlap preserves legato or retrigger ordering', () => {
  const l = run(true),
    r = run(false);
  assert.deepEqual(l.messages.find((m) => m.tick === 1920n)!.data, [
    [0x90, 62, 102],
    [0x80, 60, 0],
  ]);
  assert.deepEqual(
    r.messages.filter((m) => m.tick === 1920n).map((m) => m.data[0]),
    [
      [0x80, 60, 0],
      [0x90, 62, 102],
    ],
  );
});
test('M03/M04/M05: same pitch merges, overlaps shorten, zero velocity is suppressed', () => {
  const s = song();
  s.parts[0].events[1].pitch = 60;
  const rig = implicitRig(s.parts);
  const overlap = compileNotes(s, rig);
  assert.ok(overlap.diagnostics.some((d) => d.code === 'D003'));
  s.parts[0].events[1].nominalOnset = s.parts[0].events[0].nominalOnset;
  s.parts[0].events[1].performedOnset = s.parts[0].events[0].performedOnset;
  s.parts[0].events[1].velocity = 0.9;
  assert.equal(compileNotes(s, rig).notes[0].velocity, 114);
  assert.equal(compileNotes(s, rig).notes.length, 1);
  s.parts[0].events.forEach((e) => (e.velocity = 0));
  assert.equal(compileNotes(s, rig).messages.length, 0);
});
