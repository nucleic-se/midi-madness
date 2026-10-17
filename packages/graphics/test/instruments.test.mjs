import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { adaptPerformance } from '../dist/performance-adapter.js';
import { envelopeTimeline, relativePosition } from '../dist/performance.js';
import { ListenerCameraEffect } from '../dist/renderers/listener-camera.js';
import { MonolithEffect } from '../dist/renderers/monolith.js';
import { SweepBloomEffect } from '../dist/renderers/sweep-bloom.js';

const sr = 100;
const close = (a, b, tolerance = 1e-9, label = '') =>
  assert.ok(Math.abs(a - b) <= tolerance, `${label} ${a} vs ${b}`);
const frame = (time) => ({ time, data: {}, active: {}, signals: {} });
const load = (effect, camera = new THREE.PerspectiveCamera()) => {
  effect.load(undefined, { scene: new THREE.Scene(), camera });
  return camera;
};

function document(listener = {}) {
  return {
    format: 'midi-madness-performance',
    version: 1,
    audio: { sampleRate: sr, originSample: 0, frames: 2000 },
    world: { version: 1, units: 'm', axes: '+x right, +y up, -z forward', listener },
    tracks: [
      {
        name: 'seq',
        space: { frame: 'world', position: {} },
        events: [
          // Stone A rises from y -2 to 4 over one second, then strikes again at its height.
          {
            sample: 100,
            type: 'on',
            id: 'a1',
            pitch: 42,
            velocity: 0.8,
            locks: { 'space.x': 0, 'space.z': -10 },
            paths: [{ name: 'space.y', from: -2, to: 4, samples: 100, curve: 'linear' }],
          },
          { sample: 200, type: 'off', id: 'a1' },
          {
            sample: 300,
            type: 'on',
            id: 'a2',
            pitch: 42,
            velocity: 0.5,
            locks: { 'space.x': 0, 'space.y': 4, 'space.z': -10 },
          },
          { sample: 320, type: 'off', id: 'a2' },
          // Stone B sinks while drifting outward; it stays one column.
          {
            sample: 400,
            type: 'on',
            id: 'b1',
            pitch: 47,
            velocity: 0.7,
            paths: [
              { name: 'space.x', from: 10, to: 12, samples: 100, curve: 'linear' },
              { name: 'space.y', from: 3, to: -2, samples: 100, curve: 'linear' },
            ],
          },
          { sample: 500, type: 'off', id: 'b1' },
        ],
      },
      {
        name: 'kick',
        lane: 'kick',
        space: { frame: 'world', position: { y: [{ sample: 0, value: 4, curve: 'step' }] } },
        resolved: { basePitch: 52, pitchDecay: 0.03, baseDecay: 0.35 },
        hits: [
          { sample: 1000, velocity: 1, locks: { 'drum.pitch.depth': 36, 'drum.pitch.decay': 0.2 } },
          { sample: 1050, velocity: 0.4, locks: { 'drum.pitch.depth': 24, 'space.x': 2 } },
        ],
        controls: [],
      },
    ],
  };
}

test('listener camera view space is the listener-relative space of the performance engine', () => {
  const listener = {
    x: [
      { sample: 0, value: -3, curve: 'linear' },
      { sample: 2000, value: 9, curve: 'linear' },
    ],
    y: [{ sample: 0, value: 1.7, curve: 'step' }],
    z: [
      { sample: 0, value: 30, curve: 'linear' },
      { sample: 2000, value: -4, curve: 'linear' },
    ],
    yaw: [
      { sample: 0, value: 0, curve: 'linear' },
      { sample: 2000, value: 400, curve: 'linear' },
    ],
    pitch: [
      { sample: 0, value: -20, curve: 'linear' },
      { sample: 2000, value: 35, curve: 'linear' },
    ],
  };
  const performance = adaptPerformance(document(listener));
  const effect = new ListenerCameraEffect('camera', performance);
  const camera = load(effect);
  let seed = 11;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (const time of [0, 1.3, 7.7, 12, 19.9]) {
    effect.render(frame(time));
    const state = performance.engine.listener(time);
    for (let i = 0; i < 3; i++) close(camera.position.getComponent(i), state.position[i], 1e-9);
    for (let n = 0; n < 20; n++) {
      const point = [random() * 40, random() * 10, random() * 40];
      const view = new THREE.Vector3(...point).applyMatrix4(camera.matrixWorldInverse);
      const expected = relativePosition(point, state);
      for (let i = 0; i < 3; i++)
        close(view.getComponent(i), expected[i], 1e-9, `t=${time} axis ${i}`);
    }
  }
  // Named directions: yaw 90 looks along +x; positive pitch looks up.
  const turned = adaptPerformance(
    document({
      yaw: [{ sample: 0, value: 90, curve: 'step' }],
      pitch: [{ sample: 0, value: 30, curve: 'step' }],
    }),
  );
  const look = new ListenerCameraEffect('camera', turned);
  const lookCamera = load(look);
  look.render(frame(1));
  const direction = lookCamera.getWorldDirection(new THREE.Vector3());
  close(direction.x, Math.cos(Math.PI / 6), 1e-9);
  close(direction.y, 0.5, 1e-9);
  close(direction.z, 0, 1e-9);
});

test('monolith columns stand where their voices are, persist between notes and seek exactly', () => {
  const performance = adaptPerformance(document());
  const monolith = new MonolithEffect('stones', performance, { tracks: ['seq'] });
  load(monolith);
  assert.equal(monolith.state(0).length, 2, 'one column per stone, including the sinking path');
  const at = (time) => Object.fromEntries(monolith.state(time).map((c) => [c.key, c]));
  const [a, b] = monolith.state(0).map((c) => c.key);
  // Before any attack, nothing stands.
  assert.equal(at(0.5)[a].present, false);
  // Rising: the top follows the y path, and the gate lights it (no exported envelope).
  close(at(1.5)[a].position[1], 1, 1e-9);
  assert.equal(at(1.5)[a].glow, 0.8);
  assert.equal(monolith.envelopeSource, 'gate-approximation');
  // After the gate, the column keeps the height it reached and goes dark.
  close(at(2.5)[a].position[1], 4, 1e-6);
  assert.equal(at(2.5)[a].glow, 0);
  // Sinking stone B: same column while x and y move; below ground afterwards.
  close(at(4.5)[b].position[0], 11, 1e-9);
  close(at(4.5)[b].position[1], 0.5, 1e-9);
  close(at(6)[b].position[1], -2, 1e-6);
  // Rendered geometry: the column body spans ground..top; buried stones vanish.
  monolith.render(frame(1.5));
  const matrix = new THREE.Matrix4(),
    position = new THREE.Vector3(),
    scale = new THREE.Vector3();
  const bodies = monolith.bodies ?? monolith['bodies'];
  bodies.getMatrixAt(0, matrix);
  matrix.decompose(position, new THREE.Quaternion(), scale);
  close(scale.y, 1, 1e-6);
  monolith.render(frame(6));
  bodies.getMatrixAt(1, matrix);
  matrix.decompose(position, new THREE.Quaternion(), scale);
  assert.ok(scale.y < 1e-5, 'a stone below ground has no visible body');
  // Seeking: any order of evaluation gives identical states.
  const forward = [0.5, 1.5, 2.5, 4.5, 6].map((t) => JSON.stringify(monolith.state(t)));
  const backward = [6, 4.5, 2.5, 1.5, 0.5].map((t) => JSON.stringify(monolith.state(t))).reverse();
  assert.deepEqual(forward, backward);
});

test('monolith uses exported envelopes when the audio integration supplies them', () => {
  const performance = adaptPerformance(document(), {
    resolveVoice: (voice) =>
      voice.track === 'seq'
        ? {
            ...voice,
            end: voice.gateEnd + 0.5,
            envelopes: envelopeTimeline(
              [
                { time: voice.start, value: 1, curve: 'linear' },
                { time: voice.gateEnd + 0.5, value: 0 },
              ],
              [{ time: voice.start, value: 0.25, curve: 'hold' }],
            ),
          }
        : voice,
  });
  const monolith = new MonolithEffect('stones', performance, { tracks: ['seq'] });
  load(monolith);
  const column = monolith.state(1.5)[0];
  close(column.glow, 2 / 3, 1e-9);
  close(column.crack, 0.25, 1e-9);
  assert.equal(monolith.envelopeSource, 'exported');
});

test('sweep bloom radius is the pitch sweep in octaves and each hit resets the shell', () => {
  const performance = adaptPerformance(document());
  const bloom = new SweepBloomEffect('heart', performance, {
    tracks: ['kick'],
    radius: 0.5,
    metresPerOctave: 2,
  });
  load(bloom);
  const at = (time) => bloom.state(time)[0];
  assert.equal(at(9).attack, undefined);
  // First hit: 36 semitones = 3 octaves, decaying with tau = 0.2 s.
  close(at(10).radius, 0.5 + 2 * 3, 1e-9);
  close(at(10.2).octaves, 3 * Math.exp(-1), 1e-9);
  assert.deepEqual(at(10.2).position, [0, 4, 0]);
  // Accent hit at velocity 1: (0.2 + 0.8) · +3 dB, then -40 dB per decay (0.35 s).
  close(at(10).amplitude, 10 ** (3 / 20), 1e-9);
  close(at(10.35).amplitude, 10 ** (3 / 20) * 0.01, 1e-9);
  // Second hit resets: 24 semitones with the lane's default pitch decay, at its locked x.
  close(at(10.5).octaves, 2, 1e-9);
  close(at(10.53).octaves, 2 * Math.exp(-1), 1e-9);
  assert.deepEqual(at(10.5).position, [2, 4, 0]);
  close(at(10.5).amplitude, 0.2 + 0.8 * 0.4 ** 1.5, 1e-9);
  // Silent after 3 × decay.
  assert.equal(at(10.5 + 1.06).amplitude, 0);
  bloom.render(frame(10));
  assert.equal(bloom.envelopeSource, 'lane-model');
});

test('sweep bloom prefers an exported hit envelope and reports its source', () => {
  const performance = adaptPerformance(document());
  const bloom = new SweepBloomEffect('heart', performance, {
    tracks: ['kick'],
    envelope: (attack, time) => (attack.start === 10 ? 0.5 : null),
  });
  load(bloom);
  const first = bloom.state(10.1)[0];
  close(first.amplitude, 10 ** (3 / 20) * 0.5, 1e-9);
  assert.equal(bloom.envelopeSource, 'exported');
  bloom.state(10.6);
  assert.equal(bloom.envelopeSource, 'lane-model', 'falls back per hit when unavailable');
});

import { HarmonicSkyEffect } from '../dist/renderers/harmonic-sky.js';
import { TrailEffect } from '../dist/renderers/trail.js';
import { TetherEffect } from '../dist/renderers/tether.js';
import { VoicePointsEffect } from '../dist/renderers/voice-points.js';

function moving() {
  // A pad chord (F#m then Bm) and a voice orbiting on lanes, with two acid attacks.
  const lane = (values) => values.map(([sample, value]) => ({ sample, value, curve: 'linear' }));
  const chord = (on, off, pitches) =>
    pitches.flatMap((pitch, i) => [
      { sample: on, type: 'on', id: `${on}-${i}`, pitch, velocity: 1 },
      { sample: off, type: 'off', id: `${on}-${i}` },
    ]);
  return {
    format: 'midi-madness-performance',
    version: 1,
    audio: { sampleRate: 100, originSample: 0, frames: 1000 },
    world: { version: 1, units: 'm', axes: '', listener: {} },
    tracks: [
      {
        name: 'pads',
        space: { frame: 'world', position: { y: lane([[0, 13]]) } },
        events: [...chord(0, 300, [54, 57, 61]), ...chord(300, 600, [59, 62, 66])].sort(
          (a, b) => a.sample - b.sample,
        ),
      },
      {
        name: 'orbit',
        space: {
          frame: 'world',
          position: {
            x: lane([
              [0, 0],
              [400, 4],
            ]),
            y: lane([[0, 6]]),
            z: lane([
              [0, -2],
              [400, 2],
            ]),
          },
        },
        events: [
          { sample: 0, type: 'set', name: 'cutoff', value: 0.5 },
          { sample: 100, type: 'on', id: 'a', pitch: 42, velocity: 1 },
          { sample: 150, type: 'off', id: 'a' },
          { sample: 200, type: 'on', id: 'b', pitch: 44, velocity: 1 },
          { sample: 250, type: 'off', id: 'b' },
        ],
      },
    ],
  };
}

test('harmonic sky: the chord sets the hue, silence returns to the reference, seeking is exact', () => {
  const performance = adaptPerformance(moving());
  const sky = new HarmonicSkyEffect('sky', performance, { tracks: ['pads'] });
  load(sky);
  const fsm = sky.state(1),
    bm = sky.state(4),
    silent = sky.state(8);
  close(fsm.hue, 0.5, 1e-9, 'F# minor is the reference hue');
  assert.ok(Math.abs(bm.hue - fsm.hue) > 0.05, 'a different chord moves the hue');
  close(silent.hue, 0.5, 1e-9);
  assert.equal(silent.energy, 0);
  assert.deepEqual(sky.state(4), bm);
});

test('trail follows the lane history; tether reaches the source and reshapes per attack', () => {
  const performance = adaptPerformance(moving());
  const trail = new TrailEffect('trail', performance, {
    tracks: ['orbit'],
    length: 1,
    samples: 11,
  });
  load(trail);
  const path = trail.path('orbit', 3);
  assert.deepEqual(path.at(-1), [3, 6, 1]);
  assert.deepEqual(path[0], [2, 6, 0]);
  assert.equal(trail.level('orbit', 1.2).level, 1);
  assert.equal(trail.level('orbit', 1.7).level, 0);
  const tether = new TetherEffect('tether', performance, {
    track: 'orbit',
    origin: [0, 4, 0],
    curlControl: 'cutoff',
    filaments: 2,
  });
  const camera = load(tether);
  camera.position.set(0, 2, 20);
  const ends = (time) => {
    tether.render(frame(time));
    const position = tether.strands[0].mesh.geometry.attributes.position;
    const mid = [0, 1].map((side) => [
      position.getX(side),
      position.getY(side),
      position.getZ(side),
    ]);
    const last = [54, 55].map((v) => [position.getX(v), position.getY(v), position.getZ(v)]);
    const at = (pair) => pair[0].map((v, j) => (v + pair[1][j]) / 2);
    return { start: at(mid), end: at(last), middle: [position.getX(28), position.getY(28)] };
  };
  const a = ends(1.2);
  for (let j = 0; j < 3; j++) close(a.start[j], [0, 4, 0][j], 1e-6);
  for (let j = 0; j < 3; j++) close(a.end[j], [1.2, 6, -0.8][j], 1e-6);
  assert.deepEqual(ends(1.2), a, 'the same time always draws the same filaments');
  assert.notDeepEqual(ends(2.05).middle, ends(1.95).middle, 'a new attack reshapes');
});

test('voice points sit at sounding voices with their levels', () => {
  const performance = adaptPerformance(moving());
  const points = new VoicePointsEffect('points', performance, { tracks: ['orbit'] });
  load(points);
  const [voice] = points.state(1.2);
  assert.deepEqual(voice.position, [1.2, 6, -0.8]);
  assert.equal(voice.level, 1);
  assert.equal(points.state(1.7).length, 0);
});
