import { ControlLane } from '@midi-madness/foundation/curves';
import { test } from 'node:test';
import assert from 'node:assert/strict';
// No DOM, WebGL or Three import is needed by this module.
import {
  PerformanceEngine,
  relativePosition,
  propagationSeconds,
  performanceClock,
  envelopeTimeline,
} from '../packages/graphics/src/performance.ts';
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('fixed world voices stay fixed while listener translates, yaws and pitches', () => {
  const engine = new PerformanceEngine({
    voices: [
      {
        id: 'stone',
        track: 'seq',
        start: 0,
        gateEnd: 2,
        end: 3,
        pitch: 42,
        velocity: 1,
        parameters: { x: 0, y: 0, z: -10 },
      },
    ],
    listener: {
      x: [
        { time: 0, value: 0, curve: 'linear' },
        { time: 2, value: 10 },
      ],
      yaw: [
        { time: 0, value: 0 },
        { time: 1, value: 90 },
      ],
    },
  });
  const a = engine.frame(0).voices[0],
    b = engine.frame(1).voices[0];
  assert.deepEqual(a.position, b.position);
  near(a.azimuth, 0);
  near(a.distance, 10);
  near(b.distance, Math.sqrt(125));
  assert.ok(b.azimuth < -90);
  assert.deepEqual(engine.frame(0).voices[0], a);
  const up = relativePosition([0, 10, 0], { position: [0, 0, 0], yaw: 0, pitch: 90 });
  near(up[1], 0);
  near(up[2], -10);
});

test('locks, paths, release state and source envelope timelines survive reverse seeks', () => {
  const engine = new PerformanceEngine({
    tracks: {
      seq: {
        defaults: { cutoff: 200, x: 1 },
        controls: {
          cutoff: [
            { time: -1, value: 400 },
            { time: 1, value: null },
          ],
          x: [{ time: 0, value: 10 }],
        },
      },
    },
    voices: [
      {
        id: 'v',
        track: 'seq',
        start: 0,
        gateEnd: 1,
        end: 2,
        pitch: 42,
        velocity: 0.7,
        parameters: { x: 3 },
        paths: [
          { parameter: 'y', start: 0, duration: 1, from: -2, to: 4 },
          { parameter: 'pitch', start: 0, duration: 1, from: 42, to: 54 },
        ],
        envelopes: envelopeTimeline(
          [
            { time: 0, value: 1, curve: 'linear' },
            { time: 2, value: 0 },
          ],
          [
            { time: 0, value: 0.8 },
            { time: 1, value: 0.2 },
          ],
        ),
      },
    ],
  });
  const first = engine.frame(0.5);
  assert.equal(first.voices[0].parameters.cutoff, 400);
  assert.deepEqual(first.voices[0].position, [3, 1, 0]);
  assert.equal(first.voices[0].pitch, 48);
  const released = engine.frame(1.5).voices[0];
  assert.equal(released.held, false);
  assert.equal(released.amplitude, 0.25);
  assert.equal(released.filterEnvelope, 0.2);
  assert.equal(released.parameters.cutoff, 200);
  assert.deepEqual(engine.frame(0.5), first);
  assert.equal(engine.frame(2).voices.length, 0);
});

test('unavailable envelopes stay unavailable and input mutations do not change playback', () => {
  const definition = {
    voices: [
      {
        id: 'v',
        track: 't',
        start: 0,
        gateEnd: 1,
        end: 1,
        pitch: 60,
        velocity: 1,
        parameters: { x: 1 },
      },
    ],
  };
  const engine = new PerformanceEngine(definition);
  definition.voices[0].parameters.x = 99;
  assert.equal(engine.frame(0).voices[0].position[0], 1);
  assert.equal(engine.frame(0).voices[0].amplitude, null);
  assert.equal(engine.frame(0).voices[0].filterEnvelope, null);
});

test('historical sampling includes both endpoints, captures fast paths and bounds allocation', () => {
  const engine = new PerformanceEngine({
    voices: [],
    listener: {
      x: [
        { time: 0, value: 0, curve: 'linear' },
        { time: 1, value: 1 },
      ],
    },
  });
  const samples = engine.sample(0, 0.1, 1000);
  assert.equal(samples.length, 101);
  assert.equal(samples[0].time, 0);
  assert.equal(samples[100].time, 0.1);
  assert.deepEqual(samples[50], engine.frame(0.05));
  assert.throws(() => engine.sample(0, 100, 1000));
  assert.equal(engine.sample(1, 1, 100).length, 1);
});

test('sample origins and direct propagation use explicit physical units', () => {
  const clock = performanceClock({ sampleRate: 48000, originSample: 96000, frames: 480000 });
  assert.equal(clock.seconds(48000), -1);
  assert.equal(clock.sample(1.25), 156000);
  assert.equal(clock.duration, 10);
  near(propagationSeconds(34.3), 0.1);
  assert.throws(() => propagationSeconds(-1));
});

test('control lane curves, resets, and malformed contracts are checked at construction', () => {
  const lane = new ControlLane([
    { time: 0, value: 1, curve: 'exp' },
    { time: 2, value: 4 },
    { time: 3, value: null },
  ]);
  near(lane.value(1, 9), 2);
  assert.equal(lane.value(-1, 9), 9);
  assert.equal(lane.value(3, 9), 9);
  assert.throws(
    () =>
      new ControlLane([
        { time: 0, value: 1 },
        { time: 0, value: 2 },
      ]),
  );
  assert.throws(
    () =>
      new ControlLane([
        { time: 0, value: 0, curve: 'exp' },
        { time: 1, value: 1 },
      ]),
  );
  assert.throws(
    () =>
      new PerformanceEngine({
        voices: [{ id: 'v', track: 't', start: 1, gateEnd: 0, end: 2, pitch: 60, velocity: 1 }],
      }),
  );
});
