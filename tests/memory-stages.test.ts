import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessor } from '../packages/synth/src/processors.ts';
import { insertLiteral, parseInsertStage } from '../packages/render/src/inserts.ts';

const sr = 48000;

// Largest sample-to-sample step of a held freeze fed with a 220 Hz sine at 0.5. The hold starts off a
// zero crossing so a hard loop wrap would jump by about the full amplitude.
function freezeJump(speed: number, fade: number) {
  const stage = parseInsertStage(`freeze length 101ms, speed ${speed}, fade ${fade}ms`, 120, false);
  const p = createProcessor(stage, sr) as ReturnType<typeof createProcessor> & {
    params: Record<string, number>;
  };
  const holdAt = sr + 55;
  let previous = 0,
    jump = 0;
  for (let i = 0; i < sr * 3; i++) {
    p.params.hold = i >= holdAt ? 1 : 0;
    const x = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr);
    p.process(x, x, i);
    if (i > holdAt + sr * 0.25) jump = Math.max(jump, Math.abs(p.left - previous));
    previous = p.left;
  }
  return jump;
}

test('a held freeze loops without clicks forwards, backwards and with long fades', () => {
  // The sine itself moves at most 2*pi*220/48000*0.5 = 0.0144 per sample at speed 1.
  for (const speed of [1, 2, 0.5, -1, -0.5])
    for (const fade of [10, 200])
      assert.ok(
        freezeJump(speed, fade) < 0.03 * Math.max(1, Math.abs(speed)),
        `speed ${speed}, fade ${fade}ms`,
      );
});

test('freeze speed automation converts signed ratios like unsigned ones', () => {
  const stage = parseInsertStage('freeze length 1/4', 120, false);
  // speed is linear -4..4, so 1/2 -> 0.5625 and -1/2 -> 0.4375 on the normalized scale.
  assert.equal(insertLiteral(stage, 'speed', '-1/2', 120), '0.4375');
  assert.equal(
    insertLiteral(stage, 'speed', 'per 1 bar: 1/2, -1/2, -2/1', 120),
    'per 1 bar: 0.5625, 0.4375, 0.25',
  );
});

test('pan places a bus with equal power, folds width and steps without clicks', () => {
  const run = (
    setting: string,
    input: [number, number],
    changes?: (i: number) => number | undefined,
  ) => {
    const p = createProcessor(parseInsertStage(`pan ${setting}`, 120, false), sr) as ReturnType<
      typeof createProcessor
    > & { params: Record<string, number> };
    let jump = 0,
      previous = 0;
    for (let i = 0; i < sr / 10; i++) {
      const next = changes?.(i);
      if (next !== undefined) p.params.position = next;
      const x = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.5;
      p.process(x * input[0], x * input[1], i);
      if (i > 0) jump = Math.max(jump, Math.abs(p.left - previous));
      previous = p.left;
    }
    return { left: p.left, right: p.right, jump };
  };
  // A mono source keeps its power wherever it is placed.
  for (const position of ['-100%', '-40%', '0%', '60%', '100%']) {
    const out = run(`position ${position}`, [1, 1]);
    const x = Math.sin((2 * Math.PI * 220 * (sr / 10 - 1)) / sr) * 0.5;
    assert.ok(Math.abs(out.left ** 2 + out.right ** 2 - 2 * x * x) < 1e-6, position);
  }
  // Centre is unity; width 0 folds a one-sided input to the middle.
  const centre = run('position 0%', [1, 0]);
  assert.ok(Math.abs(centre.right) < 1e-9);
  const folded = run('position 0%, width 0%', [1, 0]);
  assert.ok(Math.abs(folded.left - folded.right) < 1e-9 && Math.abs(folded.left) > 0);
  // A hard step in position is smoothed: no jump beyond the signal's own slope.
  const step = run('position -100%', [1, 1], (i) => (i === sr / 20 ? 1 : undefined));
  assert.ok(step.jump < 0.03, `jump ${step.jump}`);
});

test('bus automation reads percent values as real values', () => {
  const stage = parseInsertStage('pan position 0%', 120, false);
  // position is linear -1..1, so -30% -> 0.35 and 50% -> 0.75 on the normalized scale.
  assert.equal(insertLiteral(stage, 'position', '-30%', 120), '0.35');
  assert.equal(insertLiteral(stage, 'position', 'per 1 bar: 0%, 50%', 120), 'per 1 bar: 0.5, 0.75');
});

test('bare shapes in bus automation convert their endpoints like across shapes', () => {
  const stage = parseInsertStage('pan position 0%', 120, false);
  assert.equal(
    insertLiteral(stage, 'position', 'random -60%..60% every 1 bar', 120),
    'random 0.2..0.8 every 1 bar',
  );
  assert.equal(insertLiteral(stage, 'position', 'ramp -100%..100%', 120), 'ramp 0..1');
});
