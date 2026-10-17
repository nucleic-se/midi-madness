import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptPerformance } from '../dist/performance-adapter.js';
import { relativePosition, worldPosition } from '../dist/performance.js';
const document = () => ({
  format: 'midi-madness-performance',
  version: 1,
  audio: { sampleRate: 100, originSample: 100, frames: 500 },
  world: {
    version: 1,
    units: 'm',
    axes: '+x right, +y up, -z forward',
    listener: {
      x: [
        { sample: 0, value: 0, curve: 'linear' },
        { sample: 500, value: 5, curve: 'step' },
      ],
      yaw: [{ sample: 0, value: 90, curve: 'step' }],
    },
  },
  tracks: [
    {
      name: 'stone',
      space: { frame: 'world', position: { z: [{ sample: 0, value: -10, curve: 'step' }] } },
      resolved: { preset: { name: 'test' } },
      events: [
        { sample: 0, type: 'set', name: 'cutoff', value: 0.2 },
        { sample: 0, type: 'set', name: 'cutoff', value: 0.7 },
        {
          sample: 50,
          type: 'on',
          id: 'a',
          pitch: 42,
          velocity: 0.5,
          locks: { 'space.x': 3 },
          paths: [
            { name: 'space.y', from: -2, to: 4, samples: 100, curve: 'linear' },
            { name: 'pitch', from: 100, to: 400, samples: 100, curve: 'exp' },
          ],
        },
        { sample: 250, type: 'off', id: 'a' },
      ],
    },
    {
      name: 'kick',
      lane: 'kick',
      resolved: { basePitch: 52 },
      hits: [{ sample: 100, velocity: 0.8, locks: { 'drum.pitch.depth': 24 } }],
    },
  ],
});

test('backend sample origin, world lanes, locks and native nonlinear pitch paths agree', () => {
  const adapted = adaptPerformance(document());
  const voice = adapted.engine.frame(0).voices[0];
  assert.deepEqual(voice.position, [3, 1, -10]);
  assert.equal(voice.pitch, 44); // native exp midpoint 200 cents, then convert
  assert.equal(voice.parameters.cutoff, 0.7);
  assert.equal(adapted.engine.frame(0).listener.position[0], 1);
  assert.equal(adapted.engine.frame(1.5).voices.length, 0);
  assert.equal(adapted.attacks[0].start, -0.5);
  assert.equal(adapted.attacks[0].model.preset.name, 'test');
  assert.deepEqual(adapted.engine.frame(0), adapted.engine.frame(0));
});

test('external step paths and lanes normalize to the shared hold policy', () => {
  const input = document();
  input.tracks[0].events[2].paths[0].curve = 'step';
  const adapted = adaptPerformance(input);
  assert.equal(adapted.definition.tracks.stone.controls.z[0].curve, 'hold');
  assert.equal(adapted.definition.voices[0].paths[0].curve, 'hold');
  assert.equal(adapted.engine.frame(0).voices[0].position[1], -2);
  assert.equal(adapted.engine.frame(0.5).voices[0].position[1], 4);
});

test('percussion is an exact attack stream, with explicit opt-in voice lifetime/envelopes', () => {
  const input = document();
  const adapted = adaptPerformance(input, {
    resolveVoice: (voice, attack) =>
      attack.kind === 'hit'
        ? {
            ...voice,
            end: voice.start + 0.2,
            envelopes: () => ({ amplitude: 0.5, filterEnvelope: 0 }),
          }
        : voice,
  });
  const hits = adapted.attacksBetween(0, 0.1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].model.basePitch, 52);
  assert.equal(adapted.attacksBetween(-1, 0).length, 1);
  assert.equal(adapted.engine.frame(0.1).voices.find((v) => v.track === 'kick').amplitude, 0.5);
  assert.equal(
    adapted.engine.frame(0.2).voices.some((v) => v.track === 'kick'),
    false,
  );
});

test('legacy polar tracks remain head-locked under listener motion and rotations', () => {
  const input = document();
  input.tracks[0].space = { frame: 'listener' };
  input.tracks[0].events = input.tracks[0].events.filter((e) => !e.paths);
  input.tracks[0].events.push(
    {
      sample: 50,
      type: 'on',
      id: 'legacy',
      pitch: 60,
      velocity: 1,
      locks: { 'space.az': 30, 'space.el': 20, 'space.dist': 4 },
    },
    { sample: 500, type: 'off', id: 'legacy' },
  );
  const engine = adaptPerformance(input).engine;
  const a = engine.frame(0).voices[0],
    b = engine.frame(1).voices[0];
  assert.ok(Math.abs(a.azimuth - 30) < 1e-9);
  assert.ok(Math.abs(b.elevation - 20) < 1e-9);
  assert.deepEqual(a.listenerPosition, b.listenerPosition);
  assert.notDeepEqual(a.position, b.position);
  const pose = { position: [3, 5, -2], yaw: 71, pitch: 34 },
    point = [7, -1, 15];
  const result = worldPosition(relativePosition(point, pose), pose);
  result.forEach((n, i) => assert.ok(Math.abs(n - point[i]) < 1e-9));
});

test('adapter rejects unsupported contracts without changing the input', () => {
  const input = document(),
    before = structuredClone(input);
  adaptPerformance(input);
  assert.deepEqual(input, before);
  assert.throws(() => adaptPerformance({ ...input, version: 2 }));
  assert.throws(() => adaptPerformance({ ...input, world: { ...input.world, units: 'ft' } }));
});
