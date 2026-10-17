import type { GraphicsContext } from './effects.js';
import * as THREE from 'three';
import type { GraphicsEffect } from './effects.js';
import type { EngineFrame, StructureEngine } from '../engine.js';
import type { Position3 } from '../performance.js';
import type { ScheduledAttack } from '../performance-adapter.js';
import { RibbonMesh } from './ribbon-mesh.js';
import {
  FrameCache,
  attackPosition,
  envelopeSourceOf,
  trackPosition,
  voiceLevel,
  type AdaptedPerformance,
  type EnvelopeSource,
} from './performance-effects.js';

const hash = (n: number) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};

/** Real point lights carried by sounding voices: they light physically based materials and
 * pool on the floor. A fixed pool of lights, so shaders never recompile during playback. */
export class VoiceLightsEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  private root = new THREE.Group();
  private scene?: THREE.Object3D;
  private lights: THREE.PointLight[] = [];
  private frames: FrameCache;
  envelopeSource: EnvelopeSource = 'idle';
  constructor(
    readonly id: string,
    performance: AdaptedPerformance,
    private options: {
      tracks: readonly string[];
      color?: string;
      intensity?: number;
      distance?: number;
      count?: number;
      /** Lift the light above the voice (for example above a stone's top). */
      offset?: Position3;
    },
  ) {
    this.frames = new FrameCache(performance);
  }
  load(_engine: StructureEngine<D>, context: Pick<GraphicsContext, 'scene'>) {
    this.dispose();
    this.scene = context.scene;
    for (let i = 0; i < (this.options.count ?? 2); i++) {
      const light = new THREE.PointLight(
        this.options.color ?? '#ff4fd8',
        0,
        this.options.distance ?? 40,
        2,
      );
      this.lights.push(light);
      this.root.add(light);
    }
    this.scene.add(this.root);
  }
  render(frame: EngineFrame<D>) {
    const tracks = new Set(this.options.tracks),
      offset = this.options.offset ?? [0, 0, 0];
    const voices = this.frames
      .at(frame.time)
      .voices.filter((v) => tracks.has(v.track))
      .map((v) => ({ v, ...voiceLevel(v) }))
      .sort((a, b) => b.level - a.level);
    this.envelopeSource = envelopeSourceOf(voices);
    this.lights.forEach((light, i) => {
      const entry = voices[i];
      // Intensity in candela at full level (physically based lights).
      light.intensity = entry ? entry.level * (this.options.intensity ?? 60) : 0;
      if (entry)
        light.position.set(
          entry.v.position[0] + offset[0],
          entry.v.position[1] + offset[1],
          entry.v.position[2] + offset[2],
        );
    });
  }
  dispose() {
    this.scene?.remove(this.root);
    this.root.clear();
    this.lights = [];
  }
}

/** Halo rings: the circle a source traces around a vertical axis, with a bright comet at the
 * source's actual position. Radius and height come from its position lanes; brightness from
 * its level. */
export class HaloRingsEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  private root = new THREE.Group();
  private scene?: THREE.Object3D;
  private camera?: THREE.PerspectiveCamera;
  private rings: { track: string; ribbon: RibbonMesh; at: (t: number) => Position3 }[] = [];
  private frames: FrameCache;
  envelopeSource: EnvelopeSource = 'idle';
  constructor(
    readonly id: string,
    private performance: AdaptedPerformance,
    private options: {
      tracks: readonly string[];
      colors?: readonly string[];
      axis?: [number, number];
      width?: number;
      segments?: number;
    },
  ) {
    this.frames = new FrameCache(performance);
  }
  load(_engine: StructureEngine<D>, context: GraphicsContext) {
    this.dispose();
    this.scene = context.scene;
    this.camera = context.camera;
    this.options.tracks.forEach((track, i) => {
      const colors = this.options.colors ?? ['#3fb8ff', '#8a6cff', '#c45cff', '#ff5fcf'];
      const ribbon = new RibbonMesh((this.options.segments ?? 160) + 1, colors[i % colors.length]);
      this.root.add(ribbon.mesh);
      this.rings.push({ track, ribbon, at: trackPosition(this.performance, track) });
    });
    this.scene.add(this.root);
  }
  /** Ring geometry for a track at a time: centre, radius, height, head angle and level. */
  ring(track: string, time: number) {
    const entry = this.rings.find((r) => r.track === track)!,
      [ax, az] = this.options.axis ?? [0, 0];
    const [x, y, z] = entry.at(time),
      [px, , pz] = entry.at(time - 0.05);
    let level = 0;
    const sources: { exported: boolean }[] = [];
    for (const v of this.frames.at(time).voices)
      if (v.track === track) {
        const l = voiceLevel(v);
        level = Math.max(level, l.level);
        sources.push(l);
      }
    const head = Math.atan2(x - ax, -(z - az)),
      previous = Math.atan2(px - ax, -(pz - az));
    const direction = Math.sign(Math.sin(head - previous)) || 1;
    return { radius: Math.hypot(x - ax, z - az), y, head, direction, level, sources };
  }
  render(frame: EngineFrame<D>) {
    const camera = this.camera;
    if (!camera) return;
    const segments = this.options.segments ?? 160,
      width = this.options.width ?? 0.05,
      [ax, az] = this.options.axis ?? [0, 0];
    const sources: { exported: boolean }[] = [];
    for (const { track, ribbon } of this.rings) {
      const r = this.ring(track, frame.time);
      sources.push(...r.sources);
      const points: [number, number, number][] = [],
        widths: number[] = [],
        alphas: number[] = [];
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        points.push([ax + Math.sin(angle) * r.radius, r.y, az - Math.cos(angle) * r.radius]);
        // Angular distance behind the head, in the direction of travel.
        const behind =
          (((r.direction * (r.head - angle)) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const comet = Math.exp(-behind * 1.6);
        alphas.push(0.12 + r.level * (0.25 + 2.2 * comet));
        widths.push(width * (1 + 1.5 * comet * r.level));
      }
      ribbon.update(points, widths, alphas, camera.position);
    }
    this.envelopeSource = envelopeSourceOf(sources);
  }
  dispose() {
    this.scene?.remove(this.root);
    for (const { ribbon } of this.rings) ribbon.dispose();
    this.root.clear();
    this.rings = [];
  }
}

/** Vertical beams of light: from a base height up to each sounding voice, or from the voice
 * upward. Width and brightness follow the voice's level. */
export class BeamEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  private root = new THREE.Group();
  private scene?: THREE.Object3D;
  private camera?: THREE.PerspectiveCamera;
  private beams: RibbonMesh[] = [];
  private frames: FrameCache;
  envelopeSource: EnvelopeSource = 'idle';
  constructor(
    readonly id: string,
    performance: AdaptedPerformance,
    private options: {
      tracks: readonly string[];
      /** 'to-voice': from `base` height up to the voice. 'up': from the voice upward `length` m. */
      mode?: 'to-voice' | 'up';
      base?: number;
      length?: number;
      width?: number;
      color?: string;
      count?: number;
    },
  ) {
    this.frames = new FrameCache(performance);
  }
  load(_engine: StructureEngine<D>, context: GraphicsContext) {
    this.dispose();
    this.scene = context.scene;
    this.camera = context.camera;
    for (let i = 0; i < (this.options.count ?? 4); i++) {
      const beam = new RibbonMesh(12, this.options.color ?? '#bfe8ff');
      this.beams.push(beam);
      this.root.add(beam.mesh);
    }
    this.scene.add(this.root);
  }
  render(frame: EngineFrame<D>) {
    const camera = this.camera;
    if (!camera) return;
    const tracks = new Set(this.options.tracks);
    const voices = this.frames
      .at(frame.time)
      .voices.filter((v) => tracks.has(v.track))
      .map((v) => ({ v, ...voiceLevel(v) }))
      .sort((a, b) => b.level - a.level);
    this.envelopeSource = envelopeSourceOf(voices);
    this.beams.forEach((beam, i) => {
      const entry = voices[i];
      if (!entry) {
        beam.update([], [], [], camera.position);
        return;
      }
      const [x, y, z] = entry.v.position;
      const from = this.options.mode === 'up' ? y : (this.options.base ?? 0),
        to =
          this.options.mode === 'up'
            ? y + (this.options.length ?? 40) * (0.3 + 0.7 * entry.level)
            : y;
      const points: [number, number, number][] = [],
        widths: number[] = [],
        alphas: number[] = [];
      for (let j = 0; j < 12; j++) {
        const t = j / 11;
        points.push([x, from + (to - from) * t, z]);
        widths.push((this.options.width ?? 0.08) * (0.6 + entry.level));
        // Brightest at the source end, fading away from it.
        const near = this.options.mode === 'up' ? 1 - t : t;
        alphas.push(entry.level * (0.25 + 1.6 * near ** 2));
      }
      beam.update(points, widths, alphas, camera.position);
    });
  }
  dispose() {
    this.scene?.remove(this.root);
    for (const beam of this.beams) beam.dispose();
    this.root.clear();
    this.beams = [];
  }
}

/** Sparks thrown from each attack: count follows velocity; each particle's path is a pure
 * function of its attack and age, so any time renders identically. */
export class SparkBurstEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  private scene?: THREE.Object3D;
  private points?: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private attacks: ScheduledAttack[];
  constructor(
    readonly id: string,
    private performance: AdaptedPerformance,
    private options: {
      tracks: readonly string[];
      count?: number;
      speed?: number;
      life?: number;
      color?: string;
      size?: number;
      max?: number;
    },
  ) {
    const tracks = new Set(options.tracks);
    this.attacks = performance.attacks.filter((a) => tracks.has(a.track));
  }
  load(_engine: StructureEngine<D>, context: Pick<GraphicsContext, 'scene'>) {
    this.dispose();
    this.scene = context.scene;
    const max = this.options.max ?? 3000;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    geometry.setAttribute('level', new THREE.BufferAttribute(new Float32Array(max), 1));
    this.points = new THREE.Points(
      geometry,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          color: { value: new THREE.Color(this.options.color ?? '#ffd9a8') },
          size: { value: this.options.size ?? 0.25 },
        },
        vertexShader: /* glsl */ `
attribute float level;
uniform float size;
varying float vLevel;
void main() {
  vLevel = level;
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = max(1.5, size * 700.0 / max(0.5, -view.z));
  gl_Position = projectionMatrix * view;
}`,
        fragmentShader: /* glsl */ `
uniform vec3 color;
varying float vLevel;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  gl_FragColor = vec4(color * exp(-r * r * 5.0) * vLevel * 4.0, 1.0);
}`,
      }),
    );
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }
  /** Live particles at a time: world positions and brightness. */
  state(time: number) {
    const life = this.options.life ?? 0.9,
      speed = this.options.speed ?? 3,
      perAttack = this.options.count ?? 10;
    const result: { position: Position3; level: number }[] = [];
    let lo = 0,
      hi = this.attacks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.attacks[mid].start < time - life) lo = mid + 1;
      else hi = mid;
    }
    for (let a = lo; a < this.attacks.length && this.attacks[a].start <= time; a++) {
      const attack = this.attacks[a],
        age = time - attack.start,
        velocity = 'velocity' in attack.source ? attack.source.velocity : 0.8;
      const origin = attackPosition(this.performance, attack),
        fade = (1 - age / life) ** 2;
      const n = Math.round(perAttack * (0.4 + velocity));
      for (let j = 0; j < n; j++) {
        const seed = a * 97 + j * 13,
          theta = hash(seed) * Math.PI * 2,
          up = 0.25 + 0.75 * hash(seed + 1),
          s = speed * (0.4 + hash(seed + 2)) * velocity;
        const flat = Math.sqrt(1 - up * up);
        // Ease out: sparks slow down; a little gravity pulls them back.
        const travel = s * (age - (age * age) / (2 * life));
        result.push({
          position: [
            origin[0] + Math.cos(theta) * flat * travel,
            origin[1] + up * travel - 1.2 * age * age,
            origin[2] + Math.sin(theta) * flat * travel,
          ],
          level: fade * velocity,
        });
      }
    }
    return result;
  }
  render(frame: EngineFrame<D>) {
    const points = this.points;
    if (!points) return;
    const sparks = this.state(frame.time).slice(0, this.options.max ?? 3000);
    const position = points.geometry.attributes.position,
      level = points.geometry.attributes.level;
    sparks.forEach((spark, i) => {
      position.setXYZ(i, ...spark.position);
      level.setX(i, spark.level);
    });
    points.geometry.setDrawRange(0, sparks.length);
    position.needsUpdate = level.needsUpdate = true;
  }
  dispose() {
    this.points?.removeFromParent();
    this.points?.geometry.dispose();
    this.points?.material.dispose();
    this.points = undefined;
  }
}
