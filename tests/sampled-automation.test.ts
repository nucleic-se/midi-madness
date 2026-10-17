import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realize, Rational as R, parseExpression } from '../packages/core/src/index.ts';
import { numericSignal } from '../packages/core/src/numeric-signal.ts';
import { perValue } from '../packages/core/src/constants.ts';
import { preparePerformance, performanceClock } from '../packages/render/src/performance-input.ts';
import { scheduleControls } from '../packages/render/src/schedule-controls.ts';
import { controlLane } from '../packages/render/src/world-score.ts';

const score = (value: string, tempo = '129.92936', meter = '4/4') => `mm 1
song "Sampled controls"
  tempo ${tempo}
  meter ${meter}
  humanize off
section A = rest(1 bar)
section B = rest(1 bar)
form = A B A
part lead
  restart every 1 bar
  cutoff = ${value}
  when in B:
    cutoff = per 1/7 smooth: 0.75, 1/3, 0.01
  plays notes | C4 E4 G4 . |
`;

test('numeric automation matches exact values at arbitrary samples, resets and fractional edges', () => {
  for (const meter of ['4/4', '6/8'])
    for (const tempo of ['120', '129.92936'])
      for (const value of [
        'per 1/128 smooth: -0.2, 1/3, 0.95, 0',
        'per song 1/8: 0.2, 0.8, 0.5',
        '(per song 1/8 smooth: 0.2, 0.8) * 0.5 + 0.1',
      ]) {
        const result = realize(score(value, tempo, meter));
        assert.equal(result.summary.errors, 0, JSON.stringify(result.diagnostics));
        const tick = result.song!.tempo.div(new R(48000 * 240));
        const exact = result.automation!,
          fast = exact.sampled('lead', 'cutoff', tick);
        assert.equal(typeof fast(0), 'number');
        const end = Math.ceil(result.song!.extent.div(tick).toNumber());
        const samples = [-4, 0, 1, end - 1, end, end + 1];
        for (const edge of exact.boundaries('lead', 'cutoff')) {
          const at = Math.floor(edge.div(tick).toNumber());
          samples.push(at - 1, at, at + 1);
        }
        for (let i = 0; i < 1500; i++) samples.push((i * 7919) % end);
        // Deliberately seek backwards, rather than relying on monotonic renderer calls.
        for (const sample of samples.reverse())
          assert.equal(
            fast(sample),
            exact.at('lead', 'cutoff', tick.mul(new R(sample))),
            `${value} @ ${sample}`,
          );
      }
});

test('unsupported expressions and coordinates outside safe integer arithmetic retain exact evaluation', () => {
  for (const value of [
    'across 2 bars: sine 0..1',
    'clamp((per 1/8 smooth: 0.1, 0.9), 0.2, 0.8)',
    'per 1/8 smooth: 0.123456789012345678901, 1/3',
    'per 1/100000000000000000000 smooth: 0.2, 0.8',
  ]) {
    const result = realize(score(value));
    assert.equal(result.summary.errors, 0, JSON.stringify(result.diagnostics));
    const auto = result.automation!,
      tick = new R(1, 384000);
    const fast = auto.sampled('lead', 'cutoff', tick);
    for (const sample of [0, 1, 191, 4567, 200001, 383999, 384000, 384001, 1100000])
      assert.equal(
        fast(sample),
        auto.at('lead', 'cutoff', tick.mul(new R(sample))),
        `${value} @ ${sample}`,
      );
    assert.throws(() => fast(0.5), /safe integer/);
    assert.throws(() => auto.sampled('lead', 'cutoff', new R(0)), /positive/);
  }
});

test('compiled lanes retain exact looping and interpolation over long positive and negative coordinates', () => {
  for (const text of ['per 1/7 smooth: -0.3, 1/3, 0.75', 'per song 1/16: 0.1, 0.8']) {
    const e = parseExpression(text).expression!;
    assert.equal(e.kind, 'call');
    if (e.kind !== 'call') throw Error('Expected lane');
    const tick = new R(1624117, 144000000000),
      reset = new R(7, 3);
    const fast = numericSignal(e, tick, reset, [4, 4])!;
    assert.ok(fast);
    let hits = 0;
    for (let sample = -500000; sample < 2000000; sample += 7919) {
      const actual = fast(sample);
      if (actual === undefined) continue;
      hits++;
      const time = tick.mul(new R(sample));
      const expected = perValue(e, e.clock === 'song' ? time : time.sub(reset), [4, 4]);
      assert.equal(actual, Number(expected.numerator) / Number(expected.denominator));
    }
    assert.ok(hits > 100, 'common lanes use numeric arithmetic');
    assert.equal(fast(Number.MAX_SAFE_INTEGER), undefined, 'unsafe multiplication falls back');
  }
});

test('large safe coordinates select the preceding held value immediately below a lane boundary', () => {
  const e = parseExpression(
    `per 1: ${Array.from({ length: 2048 }, (_, i) => i).join(', ')}`,
  ).expression!;
  if (e.kind !== 'call') throw Error('Expected lane');
  const tick = new R(1, 3000000000000),
    fast = numericSignal(e, tick, new R(0), [4, 4])!;
  for (const index of [1023, 2047, 2048])
    for (const delta of [-1, 0, 1]) {
      const sample = index * 3000000000000 + delta;
      assert.equal(fast(sample), perValue(e, tick.mul(new R(sample)), [4, 4]).toNumber());
    }
});

test('scheduled controls and world lanes match the exact scheduler, including note locks and jumps', () => {
  const source = score('per song 1/16 smooth: 0.1, 0.9')
    .replace(
      '  restart every',
      '  sound init\n  space.x = per song 1/8: -4, 3, 1\n  space.z = -3\n  restart every',
    )
    .replace('C4 E4 G4 .', 'C4{cutoff 0.8} E4 G4 .');
  const { realized, song } = preparePerformance(source, 'sampled.mm', {});
  const sr = 48000,
    bpm = song.tempo.toNumber();
  const position = (r: R) => Math.round(((r.toNumber() * 240) / bpm) * sr);
  const { offset, last } = performanceClock(song, sr);
  const part = song.parts.find((p) => p.name === 'lead')!;
  const args = [realized, part, position, offset, last, sr, bpm] as const;
  const scheduled = scheduleControls(...args);
  assert.deepEqual(
    scheduleControls(...args, {}, ['space.x', 'space.z']),
    scheduled.filter((event) => !['space.x', 'space.z'].includes(event.name)),
  );
  const world = controlLane(
    realized,
    part,
    'space.x',
    position,
    offset,
    last,
    sr,
    bpm,
    [-1000, 1000],
    0.0001,
  );
  const auto = realized.automation!,
    original = auto.sampled;
  auto.sampled = (part, name, tick) => (sample) =>
    auto.at(part, name, tick.mul(new R(Math.max(0, sample))));
  try {
    assert.deepEqual(scheduled, scheduleControls(...args));
    assert.deepEqual(
      world,
      controlLane(
        realized,
        part,
        'space.x',
        position,
        offset,
        last,
        sr,
        bpm,
        [-1000, 1000],
        0.0001,
      ),
    );
  } finally {
    auto.sampled = original;
  }
});
