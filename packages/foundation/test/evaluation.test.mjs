import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlLane, interpolate, sampleBeatCurve, loopTime, readCurve } from '../dist/curves.js';
import { sampleEnvelope, sampleTriggeredEnvelope } from '../dist/envelopes.js';
import {
  RESET,
  UNAVAILABLE,
  mapSample,
  validateDescriptor,
  validateWriters,
  routeParameters,
  resolveContributions,
  parameterValue,
} from '../dist/parameters.js';

test('one lane implements default/first, outgoing hold, reset and endpoint policies', () => {
  const lane = new ControlLane([
    { time: 2, value: 2, curve: 'linear' },
    { time: 4, value: 4, curve: 'hold' },
    { time: 6, value: null },
    { time: 8, value: 8, curve: 'linear' },
    { time: 10, value: 10 },
  ]);
  assert.equal(lane.value(0, 7), 7);
  assert.equal(lane.sample(0, null, 'first'), 2);
  const times = [2, 3, 4, 5, 6, 7, 8, 9, 10, 20];
  const expected = [2, 3, 4, 4, 7, 7, 8, 9, 10, 10];
  assert.deepEqual(
    times.map((t) => lane.value(t, 7)),
    expected,
  );
  assert.deepEqual(
    times.toReversed().map((t) => lane.value(t, 7)),
    expected.toReversed(),
  );
  assert.throws(
    () =>
      new ControlLane([
        { time: 0, value: 0 },
        { time: 0, value: 1 },
      ]),
  );
  assert.throws(() => new ControlLane([{ time: 0, value: Infinity }]));
  assert.throws(() => lane.value(NaN, 0));
  assert.throws(() => interpolate(1, 2, 0, 'unknown'));
});

test('native nonlinear interpolation precedes pitch conversion', () => {
  assert.equal(interpolate(100, 400, 0.5, 'exp'), 200);
  assert.equal(interpolate(-100, -400, 0.5, 'exp'), -200);
  const pitch = 60 + interpolate(100, 400, 0.5, 'exp') / 100;
  assert.equal(pitch, 62);
  assert.notEqual(pitch, interpolate(61, 64, 0.5, 'exp'));
  assert.equal(interpolate(100, 100, 0.4, 'log'), 100);
  for (const curve of ['exp', 'log']) {
    assert.throws(() => interpolate(0, 1, 0, curve));
    assert.throws(() => interpolate(-1, 1, 0, curve));
  }
  assert.equal(readCurve('step', true), 'hold');
  assert.throws(() => readCurve('step'));
});

test('beat curves and loops explicitly clamp, wrap or hold', () => {
  const points = [
    { beat: 0, value: 0, curve: 'linear' },
    { beat: 4, value: 1, curve: 'hold' },
  ];
  assert.equal(sampleBeatCurve(points, -1), 0);
  assert.equal(sampleBeatCurve(points, 4), 1);
  assert.equal(sampleBeatCurve(points, loopTime(4, 4)), 0);
  assert.equal(loopTime(-1, 4), 0);
  assert.equal(loopTime(-1, 4, 0, 'wrap'), 3);
  assert.equal(loopTime(12, 4, 8), 0);
  assert.throws(() => loopTime(1, 0));
});

test('latest trigger, historical gates, ties, velocity and sum are explicit policies', () => {
  const points = [
    { beat: 0, value: 1, curve: 'linear' },
    { beat: 2, value: 0, curve: 'linear' },
  ];
  const envelope = { beats: 2, idle: 0.2, points };
  const events = [
    { at: 1, velocity: 0.5, allowed: true },
    { at: 2, velocity: 1, allowed: false },
  ];
  assert.equal(
    sampleTriggeredEnvelope(envelope, events, 2, (e) => e.allowed),
    0.5,
  );
  assert.equal(
    sampleTriggeredEnvelope(envelope, events, 3, (e) => e.allowed),
    0.2,
  );
  const at = 1.5;
  const access = {
    age: (e) => at - e.at,
    sample: (age) => 1 - age / 2,
    velocity: (e) => e.velocity,
  };
  assert.equal(sampleEnvelope({ duration: 2, idle: 0 }, events, access), 0.375);
  const ties = [
    { at: 1, velocity: 0.5 },
    { at: 1, velocity: 1 },
  ];
  assert.equal(sampleEnvelope({ duration: 2, idle: 0, tie: 'last' }, ties, access), 0.75);
  assert.equal(
    sampleEnvelope({ duration: 2, idle: 0, combine: 'sum', ceiling: 1 }, ties, access),
    1,
  );
  assert.equal(sampleEnvelope({ duration: 0, idle: 0 }, ties, access), 0);
});

const target = { id: 'gain', label: 'Gain', unit: 'linear-gain', min: 0, max: 4, defaultValue: 1 };
const writer = (range, optional = false) => ({
  destination: 'gain',
  enabled: true,
  combine: 'sum',
  range,
  optional,
});
test('writer validation covers inversion, explicit sums and partial omissions', () => {
  validateDescriptor(target);
  validateWriters([writer({ min: 1, max: 2 }), writer({ min: 1, max: 0 })], [target]);
  assert.throws(
    () => validateWriters([writer({ min: 1, max: 3 }), writer({ min: 0, max: 2 })], [target]),
    /Summed/,
  );
  assert.throws(
    () =>
      validateWriters(
        [writer({ min: 0, max: 1 }), { ...writer({ min: 0, max: 1 }), combine: 'replace' }],
        [target],
      ),
    /every writer/,
  );
  // Both present cancel to zero; omitting the positive writer exposes an invalid negative value.
  assert.throws(
    () =>
      validateWriters(
        [writer({ min: -2, max: -1 }, true), writer({ min: 1, max: 2 }, true)],
        [{ id: 'gain', min: -1, max: 1 }],
      ),
    /range/,
  );
  // Contributions individually fit, but losing the negative one can exceed the upper bound.
  assert.throws(
    () =>
      validateWriters(
        [
          writer({ min: 2, max: 3 }),
          writer({ min: -2, max: -1 }, true),
          writer({ min: 2, max: 3 }),
        ],
        [{ id: 'gain', min: -2, max: 5 }],
      ),
    /Summed/,
  );
  validateWriters([writer({ min: 1, max: 2 }, true)], [{ id: 'gain', min: 1, max: 2 }]);
  assert.throws(() => validateDescriptor({ ...target, defaultValue: 5 }));
});

test('routing preserves zero, reset, unavailable fallback, native units and authored base', () => {
  const route = {
    destination: 'gain',
    sourceId: 'level',
    enabled: true,
    range: { min: 3, max: 1 },
  };
  const source = (value) => new Map([['level', { value, range: { min: -1, max: 1 } }]]);
  assert.equal(routeParameters(source(0), [route]).get('gain'), 2);
  const reset = routeParameters(source(RESET), [route]);
  assert.equal(reset.size, 0);
  assert.equal(parameterValue(target, reset, 0.75), 0.75);
  assert.throws(() => routeParameters(source(UNAVAILABLE), [route]), /unavailable/);
  const fallback = new Map([
    ['level', { value: UNAVAILABLE, range: { min: -1, max: 1 }, unavailable: 0 }],
  ]);
  assert.equal(routeParameters(fallback, [route]).get('gain'), 2);
  assert.equal(resolveContributions([{ destination: 'gain', value: 0 }]).get('gain'), 0);
  assert.equal(
    resolveContributions([
      { destination: 'gain', value: 2, combine: 'sum' },
      { destination: 'gain', value: RESET, combine: 'sum' },
    ]).get('gain'),
    2,
  );
  assert.throws(() => mapSample({ value: 2, range: { min: -1, max: 1 } }, route.range));
  assert.throws(() => resolveContributions([{ destination: 'gain', value: Infinity }]));
  assert.throws(() => routeParameters(new Map(), [route]), /missing source/);
});
