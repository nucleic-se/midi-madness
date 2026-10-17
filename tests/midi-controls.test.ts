import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realize } from '../packages/core/src/index.ts';
import { parseSetup, resolveRig } from '../packages/midi/src/config.ts';
import { compileMidi } from '../packages/midi/src/compile.ts';
import { encode, selection, chase } from '../packages/midi/src/controls.ts';
import { Rational as R } from '@midi-madness/foundation/time';
function run(fields: string, parameters: string) {
  const result = realize(
      `mm 1\nsong "Control"\n  humanize off\n  dynamics flat\nsection A = rest(1 bar)\nform = A\npart lead\n  plays notes | C4 {cutoff 0.9, length 1/8} . . . |\n${fields}\n`,
    ),
    rig = resolveRig(
      parseSetup(
        `setup test\n  port main = "none"\n  lead = direct port:main ch:1\n${parameters}\n`,
      ).setup!,
      {},
      result.song!.parts,
    );
  return { result, timeline: compileMidi(result, rig) };
}
test('M08: locks precede attack and restore current sampled expression at gate end', () => {
  const { result, timeline } = run('  cutoff = ramp 0..1', '    param cutoff cc:40');
  assert.equal(timeline.messages[0].data[0][1], 40);
  assert.equal(timeline.messages[0].data[0][2], 114);
  assert.equal(
    timeline.messages.find((m) => m.tick >= 480n && m.tick <= 485n && m.parameter === 'cutoff')!
      .data[0][2],
    16,
  );
  assert.equal(
    chase(result, timeline, new R(1, 2)).find((m) => m.parameter === 'cutoff')!.data[0][2],
    64,
  );
});
test('CC pairs, bipolar pitchbend and NRPN use valid bytes and cached selection', () => {
  const { timeline } = run(
    '',
    '    param cutoff cc:19 lsb:51\n    param bend pitchbend bipolar\n    param resonance nrpn:0/32 bits:14',
  );
  const bound = timeline.rig.parts[0],
    p = bound.instrument.params;
  assert.deepEqual(encode(bound, p.cutoff, 0.5), [
    [176, 19, 64],
    [176, 51, 0],
  ]);
  assert.deepEqual(encode(bound, p.bend, 0), [[224, 0, 64]]);
  const m = {
    tick: 0n,
    priority: 2,
    order: 0,
    instance: 'main/1',
    data: encode(bound, p.resonance, 0.5),
    nrpn: p.resonance.address,
  };
  assert.equal(selection([m, m])[1].data.length, 2);
});
test('unknown lock fallback is explicit instead of inventing patch state', () => {
  assert.ok(run('', '    param cutoff cc:40').timeline.diagnostics.some((d) => d.code === 'I004'));
});
