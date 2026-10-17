import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realize } from '../packages/core/src/index.ts';
import { parseSetup, resolveRig } from '../packages/midi/src/config.ts';
import { compileMidi } from '../packages/midi/src/compile.ts';
const header = 'mm 1\nsong "Audit"\n  tempo 120\n  dynamics flat\n';
function compile(material: string, fields = '') {
  const r = realize(
    header + `section A = ${material}\nform = A\npart bass\n  role low\n  plays melody\n${fields}`,
  );
  const rig = resolveRig(
    parseSetup(
      'setup rig\n  port main = "none"\n  bass = direct port:main ch:10\n    voices mono\n    glide legato\n',
    ).setup!,
    {},
    r.song!.parts,
  );
  return { r, t: compileMidi(r, rig) };
}
test('humanize preserves full-gate retriggers and only written slides become handovers', () => {
  const plain = compile('| [C3 D3 E3 F3 G3 A3 B3 C4 C3 D3 E3 F3 G3 A3 B3 C4] |');
  assert.equal(plain.t.notes.filter((n) => n.legatoOff).length, 0);
  assert.equal(plain.t.diagnostics.filter((d) => ['D002', 'D003'].includes(d.code)).length, 0);
  const slides = compile(
    '| [C3{length 1/16.} D3 E3 F3{length 1/16.} G3 A3 B3 C4 C3 D3 E3 F3 G3 A3 B3 C4]{length 1/32} |',
    '  length 75%\n',
  );
  assert.equal(slides.t.notes.filter((n) => n.legatoOff).length, 2);
});
test('literal length wins over operations, which win over part defaults', () => {
  const { r } = compile('(| C3{length 1/8} D3 E3 F3 |).length(1/16)', '  length 50%\n');
  assert.deepEqual(
    r.song!.parts[0].events.map((e) => e.gate.toString()),
    ['1/8', '1/16', '1/16', '1/16'],
  );
});
test('rest-first literals resolve notes and first relative pitches use the low register', () => {
  const { r } = compile('| . | . | . . c5 c3 |');
  assert.equal(r.summary.errors, 0);
  assert.equal(r.diagnostics.filter((d) => d.code === 'P004').length, 0);
  const low = compile('| 1 1^ 1v 1 |').r.song!.parts[0].events;
  assert.deepEqual(
    low.map((e) => e.pitch),
    [36, 48, 36, 36],
  );
});
test('DIN planning thins interiors without dropping notes, locks or boundaries', () => {
  const r = realize(
    header +
      'section A = (| [C3 D3 E3 F3] |).repeat(2)\nform = A\npart bass\n  plays melody\n  cutoff = sine 0..1\n  resonance = sine 0..1\n',
  );
  const rig = resolveRig(
    parseSetup(
      'setup rig\n  port main = "none" rate:500 clock:off\n  bass = direct port:main ch:10\n    param cutoff cc:19 lsb:51 rate:100\n    param resonance cc:20 lsb:52 rate:100\n',
    ).setup!,
    {},
    r.song!.parts,
  );
  const t = compileMidi(r, rig, { clock: false });
  assert.equal(t.diagnostics.filter((d) => d.severity === 'error').length, 0);
  assert.ok(t.diagnostics.some((d) => d.code === 'D006'));
  assert.equal(t.messages.filter((m) => m.priority === 3).length, 8);
  assert.equal(t.messages.filter((m) => m.priority === 0).length, 8);
  assert.ok(t.messages.filter((m) => m.parameter).every((m) => m.data.length === 2));
  for (const name of ['cutoff', 'resonance']) {
    assert.ok(
      t.messages.some(
        (m) =>
          m.parameter === name &&
          m.required &&
          m.tick < t.messages.find((m) => m.priority === 3)!.tick,
      ),
    );
    assert.ok(t.messages.some((m) => m.parameter === name && m.required && m.tick >= 7680n));
  }
});
test('articulation reports slides and channel sharing without inventing conflicts', async () => {
  const { articulation, sharedChannels } = await import('../packages/midi/src/inspect.ts');
  const { t } = compile('| C3{length 1/4.} D3 E3 F3 |');
  assert.deepEqual(articulation(t), [
    { part: 'bass', channel: 10, notes: 4, slides: 1, unwrittenSlides: 0 },
  ]);
  assert.deepEqual(
    sharedChannels({ ...t.rig, parts: [...t.rig.parts, { ...t.rig.parts[0], part: 'texture' }] }),
    [{ port: 'none', channel: 10, parts: ['bass', 'texture'] }],
  );
});
test('mono stacks warn clearly and note-map drums are summarized as one kit', async () => {
  const { articulation, sharedChannels } = await import('../packages/midi/src/inspect.ts');
  const { r, t } = compile('| C3+E3 |');
  const warnings = t.diagnostics.filter((d) => d.code === 'D002');
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0].message,
    /bass: 2-note stack on mono instrument \(ch 10\); only one note can sound/,
  );
  assert.equal(articulation(t)[0].slides, 0);
  const poly = compileMidi(r, {
    ...t.rig,
    parts: t.rig.parts.map((b) => ({ ...b, instrument: { ...b.instrument, voices: 'poly' } })),
  });
  assert.ok(!poly.diagnostics.some((d) => /stack on mono/.test(d.message)));
  const base = t.rig.parts[0],
    drums = { ...base.instrument, id: 'kit', voices: 'drums' as const };
  const parts = [
    { ...base, part: 'kick', channel: 12, note: 36, instrument: drums },
    { ...base, part: 'snare', channel: 12, note: 38, instrument: drums },
  ];
  assert.deepEqual(sharedChannels({ ...t.rig, parts }), [
    {
      port: 'none',
      channel: 12,
      parts: ['kick', 'snare'],
      kind: 'drum-kit',
      instrument: 'kit',
      laneCount: 2,
    },
  ]);
  assert.equal(
    sharedChannels({ ...t.rig, parts: [parts[0], { ...base, channel: 12 }] })[0].kind,
    undefined,
  );
});
