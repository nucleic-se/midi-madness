import * as THREE from 'three';
import { MonumentEffect } from '/graphics/renderers/monument.js';
import { monumentBindings } from '/graphics/sources/monument.js';
import { bindingDestinations } from '/graphics/renderers/effects.js';
import { bindParameters } from '/graphics/bindings.js';

const status = document.querySelector('#status');
status.textContent = 'Creating WebGL renderer…';
const renderer = new THREE.WebGLRenderer({
  canvas: document.querySelector('canvas'),
  antialias: true,
  // Diagnostic fixture only: retain the last frame for pixel inspection.
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.debug.onShaderError = () => {
  status.textContent = 'Shader compilation failed';
  status.dataset.error = 'shader';
};
const scene = new THREE.Scene();
scene.background = new THREE.Color('#10131c');
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 150);
scene.add(new THREE.HemisphereLight('#d1e8ff', '#25132f', 2));
const key = new THREE.DirectionalLight('#ffffff', 3);
key.position.set(5, 12, 6);
scene.add(key);
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(100, 100),
  new THREE.MeshStandardMaterial({ color: '#202738', roughness: 0.7 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.6;
scene.add(floor);
for (const [x, z, color] of [
  [-3, 4, '#d9aa6c'],
  [3, -4, '#85a6b7'],
]) {
  const column = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 7, 1.7),
    new THREE.MeshStandardMaterial({ color, roughness: 0.6 }),
  );
  column.position.set(x, 2.9, z);
  scene.add(column);
}
const channels = [
  { id: 'low', color: '#bf78ff', tracks: ['low'] },
  { id: 'high', color: '#63e7de', tracks: ['high'] },
];
const notes = Array.from({ length: 24 }, (_, i) => ({
  track: i % 2 ? 'high' : 'low',
  start: i * 0.5,
  duration: 0.4,
  velocity: 0.8,
  pitch: i % 2 ? 72 : 42,
  pan: i % 2 ? 0.5 : -0.5,
}));
notes.push(
  ...Array.from({ length: 12 }, (_, i) => ({
    track: 'kick',
    start: i,
    duration: 0.08,
    velocity: 0.9,
    pitch: 36,
    pan: 0,
  })),
);
const effect = new MonumentEffect('monument', {
  channels,
  clock: { secondsPerUnit: 1, secondsPerBar: 2 },
});
status.textContent = 'Loading monument geometry…';
effect.load(undefined, { scene, camera });
const bindings = monumentBindings(notes, {
  id: effect.id,
  collection: 'notes',
  channels,
  allTracks: ['low', 'high', 'kick'],
  percussionTracks: ['kick'],
  secondsPerUnit: 1,
  track: (n) => n.track,
  start: (n) => n.start,
  velocity: (n) => n.velocity,
  pitch: (n) => n.pitch,
  pan: (n) => n.pan,
});
const destinations = bindingDestinations([effect]);
const time = document.querySelector('#time'),
  orbit = document.querySelector('#orbit'),
  exposure = document.querySelector('#exposure');
const query = new URLSearchParams(location.search);
for (const [key, input] of [
  ['time', time],
  ['orbit', orbit],
  ['exposure', exposure],
]) {
  if (query.has(key)) {
    const value = Number(query.get(key));
    if (!Number.isFinite(value) || value < Number(input.min) || value > Number(input.max))
      throw new Error(`Invalid fixture ${key}`);
    input.value = String(value);
  }
}
let playing = false,
  previous;
document.querySelector('#play').onclick = (event) => {
  playing = !playing;
  event.target.textContent = playing ? 'Pause' : 'Play';
};
document.querySelector('#reload').onclick = () => {
  effect.load(undefined, { scene, camera });
  draw();
};
function draw() {
  const seconds = Number(time.value),
    angle = (Number(orbit.value) * Math.PI) / 180;
  camera.position.set(Math.sin(angle) * 24, 12, Math.cos(angle) * 24);
  camera.lookAt(0, 3, 0);
  const before = camera.matrixWorld.clone();
  const frame = {
    time: seconds,
    data: {},
    signals: {},
    active: {
      notes: notes
        .filter((n) => n.start <= seconds && seconds < n.start + n.duration)
        .map((n) => ({ datum: n, progress: (seconds - n.start) / n.duration })),
    },
  };
  effect.render(frame, bindParameters(frame, bindings, destinations).monument ?? {});
  if (!camera.matrixWorld.equals(before)) {
    status.dataset.error = 'camera';
    status.textContent = 'Effect changed the borrowed camera';
  }
  renderer.toneMappingExposure = Number(exposure.value);
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  document.querySelector('#time-label').textContent = `${seconds.toFixed(2)} s`;
  if (!status.dataset.error)
    status.textContent = `Three ${THREE.REVISION} · camera preserved · ${renderer.info.render.calls} draw calls`;
}
function render(now) {
  if (playing && previous !== undefined)
    time.value = (Number(time.value) + (now - previous) / 1000) % 12;
  previous = now;
  if (playing) draw();
  requestAnimationFrame(render);
}
for (const input of [time, orbit, exposure]) input.addEventListener('input', draw);
function capture() {
  draw();
  const png = renderer.domElement.toDataURL('image/png');
  const preview = document.querySelector('#capture-preview');
  preview.src = png;
  preview.hidden = false;
  const link = document.querySelector('#capture-link');
  link.href = png;
  link.hidden = false;
}
document.querySelector('#capture').onclick = capture;
addEventListener('resize', draw);
// Paint once even when the embedding browser throttles background animation.
draw();
if (query.has('capture')) capture();
requestAnimationFrame(render);
addEventListener('pagehide', () => {
  effect.dispose();
  renderer.dispose();
});
