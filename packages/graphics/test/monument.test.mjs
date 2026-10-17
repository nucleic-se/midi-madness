import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MonumentEffect } from '../dist/renderers/monument.js';
import { monumentBindings } from '../dist/sources/monument.js';
import { bindingDestinations } from '../dist/renderers/effects.js';
import { bindParameters } from '../dist/bindings.js';
import { PlacedEffect } from '../dist/renderers/composition.js';

const channels = [{ id: 'lead', color: '#36d9e6', tracks: ['lead'] }];
const frame = (time) => ({ time, data: {}, active: {}, signals: {} });
const create = (clock = { secondsPerUnit: 1, secondsPerBar: 2 }) =>
  new MonumentEffect('monument', { channels, clock, particleCount: 24 });
const mount = (effect) => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(3, 5, 13);
  camera.lookAt(0, 2, 0);
  effect.load(undefined, { scene, camera });
  return { scene, camera };
};
const snapshot = (effect) => {
  const result = [];
  effect.object.traverse((object) => {
    result.push(
      ...object.position.toArray(),
      ...object.quaternion.toArray(),
      ...object.scale.toArray(),
    );
    if (object.isInstancedMesh) result.push(...object.instanceMatrix.array);
    if (object.geometry?.attributes.position)
      result.push(...object.geometry.attributes.position.array);
  });
  return result;
};

test('embedded monument borrows the camera, adds no lights, and releases only its resources', () => {
  const effect = create();
  const scene = new THREE.Scene();
  const borrowed = new THREE.Group();
  scene.add(borrowed);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(7, 11, 19);
  camera.lookAt(1, 3, 2);
  const original = camera.clone();
  effect.load(undefined, { scene, camera });
  effect.render(frame(0.75), {});
  assert.deepEqual(camera.position, original.position);
  assert.deepEqual(camera.quaternion.toArray(), original.quaternion.toArray());
  assert.deepEqual(camera.projectionMatrix, original.projectionMatrix);
  let lights = 0;
  const resources = new Set();
  effect.object.traverse((object) => {
    if (object.isLight) lights++;
    // Three's sprite quad is a shared renderer resource, owned by Three itself.
    if (object.geometry && !object.isSprite) resources.add(object.geometry);
    for (const material of Array.isArray(object.material)
      ? object.material
      : object.material
        ? [object.material]
        : []) {
      resources.add(material);
      if (material.map) resources.add(material.map);
    }
  });
  assert.equal(lights, 0);
  const counts = new Map([...resources].map((resource) => [resource, 0]));
  resources.forEach((resource) =>
    resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1)),
  );
  effect.dispose();
  effect.dispose();
  assert.deepEqual(scene.children, [borrowed]);
  assert.equal(effect.object.children.length, 0);
  assert.ok(
    [...counts.values()].every((count) => count === 1),
    JSON.stringify([...counts.values()]),
  );
});

test('monument uses supplied time deterministically across sparse, dense and backward evaluation', () => {
  const effect = create();
  mount(effect);
  effect.render(frame(1.25), { 'heart.pulse': 0.8, 'heart.hitAge': 0.1 });
  const expected = snapshot(effect);
  for (let time = 0; time <= 3; time += 0.1) effect.render(frame(time), {});
  effect.render(frame(1.25), { 'heart.pulse': 0.8, 'heart.hitAge': 0.1 });
  assert.deepEqual(snapshot(effect), expected);
  const bars = create({ secondsPerUnit: 2, secondsPerBar: 2 });
  mount(bars);
  bars.render(frame(0.625), { 'heart.pulse': 0.8, 'heart.hitAge': 0.1 });
  assert.deepEqual(snapshot(bars), expected);
  effect.dispose();
  bars.dispose();
});

test('catalogues reject unknown and invalid values and placement survives reload', () => {
  const effect = new MonumentEffect('placed', {
    channels,
    clock: { secondsPerUnit: 1, secondsPerBar: 2 },
    placement: { position: [2, 3, 4], rotation: [0, Math.PI / 2, 0], scale: [0.5, 0.5, 0.5] },
    particleCount: 4,
  });
  const { scene, camera } = mount(effect);
  assert.equal(Object.isFrozen(effect.parameters), true);
  assert.throws(() => effect.render(frame(0), { 'crown.pulse': 1 }), /Unknown/);
  assert.throws(() => effect.render(frame(0), { 'heart.radius': 4 }));
  assert.throws(() => effect.render(frame(0), { 'heart.pulse': NaN }));
  effect.load(undefined, { scene, camera });
  assert.deepEqual(effect.object.position.toArray(), [2, 3, 4]);
  assert.equal(effect.object.rotation.y, Math.PI / 2);
  assert.deepEqual(effect.object.scale.toArray(), [0.5, 0.5, 0.5]);
  assert.equal(scene.children.length, 1);
  effect.dispose();
  assert.throws(
    () => new PlacedEffect({ id: 'fog', ownsEnvironment: true }, [0, 0, 0]),
    /environment/,
  );
  assert.throws(
    () => new MonumentEffect('bad', { channels, clock: { secondsPerUnit: 0, secondsPerBar: 2 } }),
  );
});

test('percussion onset continues after note gate and supports backward sampling and empty input', () => {
  const options = {
    id: 'monument',
    collection: 'notes',
    channels,
    allTracks: ['lead', 'kick'],
    percussionTracks: ['kick'],
    secondsPerUnit: 2,
    track: (note) => note.track,
    start: (note) => note.start,
    velocity: (note) => note.velocity,
    pitch: (note) => note.pitch,
    pan: (note) => note.pan,
  };
  const notes = [
    { track: 'kick', start: 1, velocity: 0.8 },
    { track: 'kick', start: 1, velocity: 0.6 },
  ];
  const effect = create();
  const sources = monumentBindings(notes, options);
  const sample = (time) =>
    bindParameters(frame(time), sources, bindingDestinations([effect])).monument;
  assert.equal(sample(0)['heart.pulse'], 0);
  assert.equal(sample(0)['heart.hitAge'], 8);
  assert.equal(sample(1)['heart.pulse'], 0.6);
  assert.equal(sample(1.25)['heart.hitAge'], 0.5);
  assert.equal(sample(1.25)['heart.pulse'], 0.6 * Math.exp(-2.5));
  sample(7);
  assert.equal(sample(1)['heart.pulse'], 0.6);
  const empty = bindParameters(
    frame(0),
    monumentBindings([], options),
    bindingDestinations([effect]),
  ).monument;
  assert.equal(empty['heart.pulse'], 0);
  assert.equal(empty['heart.radius'], 2);
});

test('partial load failure removes monument geometry without touching host objects', () => {
  const effect = create();
  const scene = new THREE.Scene();
  const borrowed = new THREE.Group();
  scene.add(borrowed);
  scene.add = () => {
    throw new Error('host refused mount');
  };
  assert.throws(
    () => effect.load(undefined, { scene, camera: new THREE.PerspectiveCamera() }),
    /refused/,
  );
  assert.deepEqual(scene.children, [borrowed]);
  assert.equal(effect.object.children.length, 0);
  effect.dispose();
});
