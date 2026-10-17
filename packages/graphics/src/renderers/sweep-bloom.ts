import { disposeTree } from './resources.js';
import type { GraphicsContext } from './effects.js';
import { ControlLane } from '@midi-madness/foundation/curves';
import * as THREE from 'three';
import type { GraphicsEffect } from './effects.js';
import type { EngineFrame, StructureEngine } from '../engine.js';
import { type Position3 } from '../performance.js';
import type { ScheduledAttack } from '../performance-adapter.js';
import { RibbonMesh } from './ribbon-mesh.js';
import {
  attackPosition,
  latestAttack,
  type AdaptedPerformance,
  type EnvelopeSource,
} from './performance-effects.js';

/** The renderer's drum lane model, as exported in `tracks[].resolved` (see SPATIAL.md). */
export interface DrumLaneModel {
  basePitch: number;
  pitchDecay: number;
  baseDecay: number;
}
export interface SweepBloomOptions {
  /** Drum tracks whose hits bloom. Each track is one monophonic shell. */
  tracks: readonly string[];
  /** Shell radius at rest, and metres per octave of pitch sweep. */
  radius?: number;
  metresPerOctave?: number;
  color?: string;
  core?: string;
  /** Exported hit envelope (1 at the attack, including chokes), or null when unavailable.
   * Without it the drum lane model supplies the envelope, reported as 'lane-model'. */
  envelope?: (attack: ScheduledAttack, time: number) => number | null;
  /** Shock rings at the sweep radius, and a point light that flashes with the hit. */
  rings?: string;
  /** Intensity in candela at full amplitude (physically based lights). */
  light?: { color?: string; intensity?: number; distance?: number; shadow?: boolean };
}
export interface BloomState {
  track: string;
  attack?: ScheduledAttack;
  position: Position3;
  age: number;
  /** Octaves above the lane's base pitch: depth/12 · e^(-age/decay). */
  octaves: number;
  /** Octaves per second the sweep is falling; drives turbulence. */
  speed: number;
  radius: number;
  /** Drum amplitude from the lane model; 0 once the hit has ended (3 × decay). */
  amplitude: number;
}

const vertex = /* glsl */ `
uniform float time;
uniform float turbulence;
varying vec3 vNormal;
varying vec3 vView;
float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
void main() {
  float n = noise(position * 2.6 + vec3(0.0, time * 3.0, 0.0)) - 0.5;
  vec3 displaced = position * (1.0 + n * 0.12 * turbulence);
  vec4 view = modelViewMatrix * vec4(displaced, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-view.xyz);
  gl_Position = projectionMatrix * view;
}`;
const fragment = /* glsl */ `
uniform vec3 color;
uniform float amplitude;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float rim = pow(1.0 - abs(dot(normalize(vNormal), vView)), 3.5);
  gl_FragColor = vec4(color * (0.02 + rim * 1.4) * amplitude, 1.0);
}`;

/** A hit's pitch sweep drawn as a shell: radius follows the sweep in octaves, so a deep,
 * slow sweep is a large, slow bloom. Each hit resets the shell, as the drum lane resets its
 * voice. Brightness follows the drum lane model's amplitude envelope.
 */
export class SweepBloomEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  private root = new THREE.Group();
  private scene?: THREE.Object3D;
  private shells: {
    track: string;
    attacks: ScheduledAttack[];
    shell: THREE.Mesh<THREE.IcosahedronGeometry, THREE.ShaderMaterial>;
    core: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshBasicMaterial>;
    rings: RibbonMesh[];
    light?: THREE.PointLight;
  }[] = [];
  private camera?: THREE.PerspectiveCamera;
  envelopeSource: EnvelopeSource = 'lane-model';
  constructor(
    readonly id: string,
    private performance: AdaptedPerformance,
    private options: SweepBloomOptions,
  ) {}
  load(_engine: StructureEngine<D>, context: GraphicsContext) {
    this.dispose();
    this.scene = context.scene;
    this.camera = context.camera;
    this.scene.add(this.root);
    for (const track of this.options.tracks) {
      const attacks = this.performance.attacks.filter((a) => a.kind === 'hit' && a.track === track);
      const shell = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1, 4),
        new THREE.ShaderMaterial({
          vertexShader: vertex,
          fragmentShader: fragment,
          uniforms: {
            time: { value: 0 },
            turbulence: { value: 0 },
            amplitude: { value: 0 },
            color: { value: new THREE.Color(this.options.color ?? '#ff4fb8') },
          },
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      const core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1, 2),
        new THREE.MeshBasicMaterial({
          color: this.options.core ?? '#fff1c9',
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      shell.frustumCulled = core.frustumCulled = false;
      this.root.add(shell, core);
      const rings = this.options.rings
        ? [0, 1].map(() => {
            const ring = new RibbonMesh(97, this.options.rings!);
            this.root.add(ring.mesh);
            return ring;
          })
        : [];
      let light;
      if (this.options.light) {
        light = new THREE.PointLight(
          this.options.light.color ?? '#ff5fcf',
          0,
          this.options.light.distance ?? 50,
          2,
        );
        if (this.options.light.shadow) {
          light.castShadow = true;
          light.shadow.mapSize.set(1024, 1024);
          light.shadow.bias = -0.002;
          light.shadow.radius = 4;
        }
        this.root.add(light);
      }
      this.shells.push({ track, attacks, shell, core, rings, light });
    }
  }
  private control(track: string, name: string, time: number): number | undefined {
    const points = this.performance.definition.tracks?.[track]?.controls?.[name];
    if (!points?.length) return undefined;
    const value = new ControlLane(points).sample(time, null);
    return value ?? undefined;
  }
  /** Shell state per track at a time; exposed for tests and HUDs. */
  state(time: number): BloomState[] {
    return this.shells.map(({ track, attacks }) => {
      const base = this.options.radius ?? 0.5,
        perOctave = this.options.metresPerOctave ?? 1.6;
      const attack = latestAttack(attacks, time);
      if (!attack)
        return {
          track,
          position: [0, 0, 0],
          age: 0,
          octaves: 0,
          speed: 0,
          radius: base,
          amplitude: 0,
        };
      const model = attack.model as DrumLaneModel,
        locks = ('locks' in attack.source ? attack.source.locks : undefined) ?? {},
        age = time - attack.start;
      const read = (name: string) => locks[name] ?? this.control(track, name, attack.start);
      const depth = read('drum.pitch.depth') ?? 0,
        tau = read('drum.pitch.decay') ?? model.pitchDecay;
      const octaves = (depth / 12) * Math.exp(-age / tau);
      const velocity = 'velocity' in attack.source ? attack.source.velocity : 0,
        accent = Math.round(velocity * 127) >= 100;
      const decay = model.baseDecay * 0.25 * 16 ** (read('decay') ?? 0.5);
      const exported = this.options.envelope?.(attack, time) ?? null;
      this.envelopeSource = exported === null ? 'lane-model' : 'exported';
      const envelope =
        exported ??
        (age > 3 * decay ? 0 : Math.exp((-Math.log(100) * age) / Math.max(0.001, decay)));
      const amplitude = (0.2 + 0.8 * velocity ** 1.5) * (accent ? 10 ** (3 / 20) : 1) * envelope;
      return {
        track,
        attack,
        position: attackPosition(this.performance, attack),
        age,
        octaves,
        speed: octaves / tau,
        radius: base + perOctave * octaves,
        amplitude,
      };
    });
  }
  render(frame: EngineFrame<D>) {
    const { camera } = this;
    if (!camera) return;
    this.state(frame.time).forEach((state, i) => {
      const { shell, core } = this.shells[i];
      shell.position.fromArray(state.position);
      core.position.fromArray(state.position);
      shell.scale.setScalar(state.radius);
      core.scale.setScalar((this.options.radius ?? 0.5) * (0.2 + 0.35 * state.amplitude));
      shell.material.uniforms.time.value = frame.time;
      shell.material.uniforms.turbulence.value = Math.min(1.5, state.speed / 8);
      shell.material.uniforms.amplitude.value = state.amplitude;
      core.material.opacity = 0.15 + 0.6 * Math.min(1, state.amplitude);
      const { rings, light } = this.shells[i];
      // Two shock rings at the sweep radius: one level, one tilted, fading with the hit.
      rings.forEach((ring, r) => {
        const radius = state.radius * (1.25 + r * 0.3),
          tilt = r ? 1.1 : 0;
        const points: [number, number, number][] = [];
        for (let j = 0; j <= 96; j++) {
          const a = (j / 96) * Math.PI * 2;
          const x = Math.cos(a) * radius,
            y = Math.sin(a) * radius;
          points.push([
            state.position[0] + x,
            state.position[1] + y * Math.sin(tilt),
            state.position[2] + y * Math.cos(tilt),
          ]);
        }
        ring.update(
          points,
          points.map(() => 0.04 + 0.05 * state.amplitude),
          points.map(() => state.amplitude * 1.4),
          camera.position,
        );
      });
      if (light) {
        light.position.fromArray(state.position);
        light.intensity = state.amplitude * (this.options.light?.intensity ?? 150);
      }
    });
  }
  dispose() {
    this.scene?.remove(this.root);
    disposeTree(this.root);
    // Ribbon mesh resources were included in the owned tree above.
    this.root.clear();
    this.shells = [];
  }
}
