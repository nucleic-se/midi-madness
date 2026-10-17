import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realize, Rational as R } from '../packages/core/src/index.ts';
import { parseSetup, resolveRig } from '../packages/midi/src/config.ts';
import { compileMidi } from '../packages/midi/src/compile.ts';
import { play, panic, rangeMessages, type Clock } from '../packages/midi-live/src/player.ts';
function fixture() {
  const r = realize(
      'mm 1\nsong "Live"\n  tempo 120\n  humanize off\n  dynamics flat\nsection A = (| C4 |).repeat(4)\nform = A\npart lead\n  plays melody\n  cutoff = ramp 0..1\n',
    ),
    rig = resolveRig(
      parseSetup(
        'setup test\n  port main = "fake"\n  lead = direct port:main ch:1\n    param cutoff cc:40 rate:20\n',
      ).setup!,
      {},
      r.song!.parts,
    );
  return { r, t: compileMidi(r, rig) };
}
test('live clock and cleanup use the same ordered compiler trace', async () => {
  const { r, t } = fixture(),
    sent: number[][] = [];
  let now = 0,
    closed = false;
  const timer: Clock = {
    now: () => now,
    wait: async (due) => {
      now = Math.max(now, due);
    },
  };
  const result = await play(
    r,
    t,
    {
      send: (m) => sent.push(m),
      close: () => {
        closed = true;
      },
    },
    { timer, clock: true },
  );
  assert.equal(closed, true);
  assert.ok(sent.some((m) => m[0] === 250));
  assert.ok(sent.some((m) => m[0] === 248));
  assert.equal(sent.filter((m) => (m[0] & 240) === 144).length, t.notes.length);
  assert.equal(result.p99Ms, 0);
  assert.ok(sent.some((m) => m[0] === 252));
});
test('range skips carry-in notes and uses elapsed sixteenths for SPP', async () => {
  const { r, t } = fixture(),
    sent: number[][] = [];
  let now = 0;
  const timer: Clock = {
    now: () => now,
    wait: async (due) => {
      now = due;
    },
  };
  await play(
    r,
    t,
    { send: (m) => sent.push(m), close() {} },
    { timer, from: new R(1), to: new R(2) },
  );
  assert.deepEqual(
    sent.find((m) => m[0] === 242),
    [242, 16, 0],
  );
  assert.ok(sent.some((m) => m[0] === 251));
  assert.equal(sent.filter((m) => (m[0] & 240) === 144).length, 1);
  assert.ok(rangeMessages(r, t, new R(1, 2), new R(1)).every((m) => m.priority !== 3));
});
test('abort cleans up and panic covers only selected channels', async () => {
  const { r, t } = fixture(),
    controller = new AbortController(),
    sent: number[][] = [];
  let now = 0;
  await play(
    r,
    t,
    {
      send: (m) => {
        sent.push(m);
        if ((m[0] & 240) === 144) controller.abort();
      },
      close() {},
    },
    {
      timer: {
        now: () => now,
        wait: async (due) => {
          now = due;
        },
      },
      signal: controller.signal,
    },
  );
  assert.ok(sent.some((m) => (m[0] & 240) === 128));
  const emergency: number[][] = [];
  assert.equal(panic({ send: (m) => emergency.push(m), close() {} }, [1, 14]), 260);
  assert.ok(emergency.every((m) => [0, 13].includes(m[0] & 15)));
});
test('expired attacks are skipped after a short scheduler delay', async () => {
  const { r, t } = fixture();
  t.notes[0].end = t.notes[0].start + 1n;
  const sent: number[][] = [];
  let now = 0;
  const result = await play(
    r,
    t,
    { send: (m) => sent.push(m), close() {} },
    {
      clock: false,
      timer: {
        now: () => now,
        wait: async (due) => {
          now = due + 10;
        },
      },
    },
  );
  assert.equal(result.skippedAttacks, 1);
  assert.equal(sent.filter((m) => (m[0] & 240) === 144).length, t.notes.length - 1);
});

for (const ending of ['complete', 'abort', 'stall'] as const)
  test(`playback silences pedal-held voices before closing on ${ending}`, async () => {
    const r = realize(
      'mm 1\nsong "Pedal"\n  humanize off\nsection A = | C4 |\nform = A\npart lead\n  plays melody\n  sustain = 1\n',
    );
    const rig = resolveRig(
      parseSetup(
        'setup test\n  port main = "fake"\n  lead = direct port:main ch:3\n    param sustain cc:64\n',
      ).setup!,
      {},
      r.song!.parts,
    );
    const t = compileMidi(r, rig);
    assert.deepEqual(
      t.diagnostics.filter((d) => d.severity === 'error'),
      [],
    );
    const controller = new AbortController();
    const sounding = new Set<number>();
    let pedal = false,
      attacked = false,
      closed = false,
      now = 0;
    const run = play(
      r,
      t,
      {
        send(m) {
          assert.equal(m[0] & 15, 2, 'cleanup stays on the bound channel');
          const kind = m[0] & 240;
          if (kind === 176 && m[1] === 64) pedal = m[2] >= 64;
          if (kind === 144 && m[2] > 0) {
            attacked = true;
            sounding.add(m[1]);
            if (ending === 'abort') controller.abort();
          }
          if (kind === 128 && !pedal) sounding.delete(m[1]);
          if (kind === 176 && (m[1] === 120 || (m[1] === 123 && !pedal))) sounding.clear();
        },
        close() {
          closed = true;
          assert.equal(sounding.size, 0, 'silence pedal-held voices before closing');
        },
      },
      {
        clock: false,
        signal: controller.signal,
        timer: {
          now: () => now,
          wait: async (due) => {
            now = due + (ending === 'stall' && attacked ? 101 : 0);
          },
        },
      },
    );
    if (ending === 'stall') await assert.rejects(run, /scheduler stalled/);
    else await run;
    assert.ok(attacked);
    assert.ok(pedal, 'cleanup does not rewrite device-specific CC mappings');
    assert.ok(closed);
  });
