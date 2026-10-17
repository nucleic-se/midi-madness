/** Explicit native virtual-bus test. Never selects a synth/hardware endpoint. */
import { Input, Output } from '@julusian/midi';
import { realize } from '../packages/core/src/index.ts';
import { parseSetup, resolveRig } from '../packages/midi/src/config.ts';
import { compileMidi } from '../packages/midi/src/compile.ts';
import { play, clock } from '../packages/midi-live/src/player.ts';
import assert from 'node:assert/strict';
const input = new Input(),
  output = new Output(),
  received: { message: number[]; at: number }[] = [];
let origin: number | undefined;
try {
  const outputNames = Array.from({ length: output.getPortCount() }, (_, i) =>
      output.getPortName(i),
    ),
    inputNames = Array.from({ length: input.getPortCount() }, (_, i) => input.getPortName(i)),
    iac = outputNames.find((name) => /IAC/i.test(name) && inputNames.includes(name)),
    name = iac ?? `mm-native-loopback-${process.pid}`;
  input.ignoreTypes(false, false, false);
  input.on('message', (_delta, message) => received.push({ message, at: performance.now() }));
  if (iac) input.openPort(inputNames.indexOf(iac));
  else input.openVirtualPort(name);
  const index = Array.from({ length: output.getPortCount() }, (_, i) => i).find(
    (i) => output.getPortName(i) === name,
  );
  assert.notEqual(index, undefined);
  output.openPort(index!);
  const r = realize(
      'mm 1\nsong "Native test"\n  tempo 240\n  humanize off\n  dynamics flat\nsection A = (steps 1/16: C4 D4 E4 F4).repeat(4)\nform = A\npart lead\n  plays melody\n  cutoff = ramp 0..1\n',
    ),
    rig = resolveRig(
      parseSetup(
        `setup native\n  port main = "${name}"\n  lead = direct port:main ch:1\n    param cutoff cc:40 rate:20\n`,
      ).setup!,
      {},
      r.song!.parts,
    ),
    t = compileMidi(r, rig, { clock: true });
  assert.ok(!t.diagnostics.some((d) => d.severity === 'error'));
  const expected = t.messages.flatMap((m) =>
    m.data.map((data) => ({ tick: m.tick, priority: m.priority, data })),
  );
  expected.push(
    { tick: 0n, priority: -2, data: [242, 0, 0] },
    { tick: 0n, priority: -2, data: [250] },
  );
  for (let tick = 0n; tick < t.end; tick += 40n) expected.push({ tick, priority: -1, data: [248] });
  expected.sort((a, b) => (a.tick < b.tick ? -1 : a.tick > b.tick ? 1 : a.priority - b.priority));
  expected.push(
    { tick: t.end, priority: 5, data: [252] },
    { tick: t.end, priority: 6, data: [176, 123, 0] },
    { tick: t.end, priority: 7, data: [176, 120, 0] },
  );
  const result = await play(
    r,
    t,
    { send: (m) => output.sendMessage(m), close: () => output.closePort() },
    {
      timer: {
        now: () => {
          const now = performance.now();
          origin ??= now;
          return now;
        },
        wait: clock.wait,
      },
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    received.map((r) => r.message),
    expected.map((e) => e.data),
  );
  const lateness = received
      .map((r, i) => Math.max(0, r.at - origin! - (Number(expected[i].tick) / 960) * 250))
      .sort((a, b) => a - b),
    median = lateness[Math.floor(lateness.length / 2)],
    p99 = lateness[Math.floor(lateness.length * 0.99)];
  console.log(
    JSON.stringify({
      transport: iac ? 'IAC' : 'native CoreMIDI virtual endpoint (IAC unavailable)',
      port: name,
      messages: received.length,
      receivedMedianMs: median,
      receivedP99Ms: p99,
      p99TargetMet: p99 <= 2,
      scheduler: result,
    }),
  );
} finally {
  output.closePort();
  input.closePort();
}
