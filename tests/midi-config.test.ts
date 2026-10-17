import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInstrument,
  parseSetup,
  resolveRig,
  implicitRig,
} from '../packages/midi/src/config.ts';
import { realize } from '../packages/core/src/index.ts';
const instrument =
  'instrument virus\n  voices poly\n  program bank:cc0+cc32 select:pc base:1\n  banks ram-a:0/0\n  param cutoff cc:40\n  param colour as:cutoff\n';
test('configuration resolves aliases, program numbering and defaults', () => {
  const i = parseInstrument(instrument),
    s = parseSetup(
      'setup rig\n  port main = "Port" rate:3125\n  lead = virus port:main ch:1 program:ram-a/100\n    set colour 0.35\n',
    );
  assert.deepEqual([...i.diagnostics, ...s.diagnostics], []);
  const r = resolveRig(s.setup!, { virus: i.instrument! }, [{ name: 'lead', role: 'front' }]);
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.parts[0].instrument.params.colour.address[0], 40);
  assert.deepEqual(r.parts[0].program, { bank: [0, 0], pc: 99 });
  assert.equal(r.parts[0].baselines.colour, 0.35);
});
test('missing, conflicting and recursive aliases are actionable errors', () => {
  const s = parseSetup(
    'setup rig\n  port main = "Port"\n  a = direct port:main ch:1\n    voices mono\n  b = direct port:main ch:1\n    voices poly\n',
  );
  assert.ok(
    resolveRig(s.setup!, {}, [
      { name: 'a', role: 'bed' },
      { name: 'b', role: 'bed' },
      { name: 'c', role: 'bed' },
    ]).diagnostics.some((d) => d.code === 'R004'),
  );
  const i = parseInstrument('instrument bad\n  param a as:b\n  param b as:a\n');
  const cycle = resolveRig(
    parseSetup('setup rig\n  port main = "Port"\n  a = bad port:main ch:1\n').setup!,
    { bad: i.instrument! },
    [{ name: 'a', role: 'bed' }],
  );
  assert.ok(cycle.diagnostics.some((d) => d.code === 'R002'));
});
test('implicit export skips channel 10 for pitched parts and maps GM drums', () => {
  const parts = Array.from({ length: 12 }, (_, i) => ({ name: 'p' + i, role: 'bed' })),
    rig = implicitRig([...parts, { name: 'drum', role: 'pulse', lane: 'kick' }]);
  assert.deepEqual(
    rig.parts.slice(0, 12).map((p) => p.channel),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13],
  );
  assert.equal(rig.parts.at(-1)!.note, 36);
  assert.equal(rig.diagnostics[0].severity, 'info');
});
test('declared custom aliases reach core checking without MIDI addresses', () => {
  const r = realize(
    'mm 1\nsection A = | 1 |\nform = A\npart lead\n  plays melody\n  colour = 0.3\n',
    { parameterDomains: { lead: { colour: [0, 1] } } },
  );
  assert.equal(r.summary.errors, 0);
  assert.equal(r.parts![0].controls.colour[0].value, 0.3);
});
test('device transpose supports instrument defaults and per-alias offsets without transposing drums', async () => {
  const { compileMidi } = await import('../packages/midi/src/compile.ts');
  const r = realize(
    'mm 1\nsong "Offsets"\n  tempo 120\n  humanize off\nsection A = | C3 |\nform = A\npart bass\n  plays melody\npart sub\n  plays melody\npart kick\n  lane kick\n  plays hits | X |\n',
  );
  const synth = parseInstrument('instrument synth\n  transpose +12\n').instrument!,
    drums = parseInstrument(
      'instrument kit\n  voices drums\n  transpose +12\n  lane kick note:36\n',
    ).instrument!;
  const setup = parseSetup(
    'setup rig\n  port main = "none"\n  bass = synth port:main ch:5\n  sub = synth port:main ch:5\n    transpose -12\n  kick = kit port:main ch:12\n',
  ).setup!;
  const t = compileMidi(r, resolveRig(setup, { synth, kit: drums }, r.song!.parts));
  assert.equal(t.diagnostics.filter((d) => d.severity === 'error').length, 0);
  assert.equal(t.notes.find((n) => n.event.part === 'bass')!.pitch, 60);
  assert.equal(t.notes.find((n) => n.event.part === 'sub')!.pitch, 36);
  assert.equal(t.notes.find((n) => n.event.part === 'kick')!.pitch, 36);
  assert.equal(r.song!.parts[0].events[0].pitch, 48);
  assert.ok(
    parseInstrument('instrument invalid\n  transpose 1.5\n').diagnostics.some(
      (d) => d.severity === 'error',
    ),
  );
});
