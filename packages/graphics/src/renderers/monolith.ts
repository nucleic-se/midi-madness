import { disposeTree } from './resources.js';
import type { GraphicsContext } from './effects.js';
import * as THREE from 'three';
import type { GraphicsEffect } from './effects.js';
import type { EngineFrame, StructureEngine } from '../engine.js';
import type { VoiceDefinition, VoiceState } from '../performance.js';
import {
  FrameCache,
  envelopeSourceOf,
  voiceAt,
  type AdaptedPerformance,
  type EnvelopeSource,
} from './performance-effects.js';

export interface MonolithOptions {
  /** Tracks whose voices raise columns. */
  tracks: readonly string[];
  /** Column identity. Default: track plus the voice's horizontal position at its attack. */
  key?: (start: VoiceState) => string;
  /** World height of the ground the columns stand on. */
  ground?: number;
  width?: number;
  stone?: string;
  ember?: string;
  maxColumns?: number;
  /** 'menhir' (default): a rough tapered standing stone; 'box': a plain column. */
  shape?: 'menhir' | 'box';
  /** 'seams' (default): glowing seams in stone. 'meter': obsidian pillar with an LED level
   * meter (fill = amplitude, colour = pitch) and neon edges. */
  style?: 'seams' | 'meter';
  /** Pitch range mapped to hue for the meter style (MIDI low, high → hue low, high). */
  hues?: { low: number; high: number; from: number; to: number };
}
type Column = { voices: { voice: VoiceDefinition; end: VoiceState }[] };

const noise = /* glsl */ `
float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`;
const vertex = /* glsl */ `
attribute float aGlow;
attribute float aCrack;
varying float vGlow;
varying float vCrack;
varying vec3 vWorld;
varying vec3 vNormal;
${noise}
#include <fog_pars_vertex>
void main() {
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix * instanceMatrix) * normal);
  // Weathered surface: displace along the normal by world-space noise (no motion over time).
  world.xyz += n * (noise(world.xyz * 2.1) - 0.5) * 0.12;
  vWorld = world.xyz;
  vNormal = n;
  vGlow = aGlow;
  vCrack = aCrack;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const fragment = /* glsl */ `
uniform vec3 stone;
uniform vec3 ember;
varying float vGlow;
varying float vCrack;
varying vec3 vWorld;
varying vec3 vNormal;
${noise}
#include <fog_pars_fragment>
void main() {
  vec3 n3 = normalize(vNormal);
  // Key light from above plus a cool fill, so idle stone still reads against the dark.
  float light = 0.08 + 0.7 * max(0.0, dot(n3, normalize(vec3(0.4, 1.0, 0.3)))) + 0.12 * max(0.0, dot(n3, normalize(vec3(-0.6, 0.2, 0.8))));
  float grain = 0.75 + 0.5 * noise(vWorld * 9.0);
  float n = noise(vWorld * 1.7) * 0.65 + noise(vWorld * 4.3) * 0.35;
  // Amplitude lights the seams; the filter envelope makes them hotter and wider (HDR for bloom).
  float heat = vGlow * (0.55 + 1.25 * vCrack);
  float wide = 1.0 - smoothstep(0.0, 0.05 + 0.08 * vCrack, abs(n - 0.5));
  vec3 color = stone * light * grain + ember * (wide * heat * 4.0 + vGlow * 0.15);
  gl_FragColor = vec4(color, 1.0);
  #include <fog_fragment>
}`;

/** Inject the LED level meter and neon edges into a physically based material's emissive term,
 * so the pillar keeps real lighting, clearcoat reflections and fog. */
function meterMaterial() {
  const material = new THREE.MeshPhysicalMaterial({
    // Obsidian: a black dielectric, dark head-on, reflective at grazing angles.
    color: '#020203',
    roughness: 0.35,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: 0.6,
  });
  material.onBeforeCompile = (shader) => {
    const declarations = `
attribute float aGlow;
attribute float aCrack;
attribute float aHue;
attribute float aHeight;
varying float vGlow;
varying float vCrack;
varying float vHue;
varying float vHeight;
varying vec3 vLocal;
varying vec3 vLocalNormal;`;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${declarations}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vLocal = position; vLocalNormal = normal; vGlow = aGlow; vCrack = aCrack; vHue = aHue; vHeight = aHeight;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${declarations.replace(/attribute float \w+;\n/g, '')}
vec3 meterHue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  vec3 tint = meterHue(vHue);
  float side = 1.0 - abs(vLocalNormal.y);
  float across = abs(vLocalNormal.x) > 0.5 ? vLocal.z : vLocal.x;
  // A segmented LED strip up each face, lit up to the voice's level like a VU meter.
  float strip = (1.0 - smoothstep(0.1, 0.13, abs(across))) * side;
  float segment = step(0.22, fract(vLocal.y * vHeight / 0.3));
  float lit = step(vLocal.y, 0.03 + 0.97 * sqrt(vGlow));
  float led = strip * segment * (lit * (3.5 + 6.0 * vCrack) + 0.07);
  // Neon along each face's vertical edges (the across coordinate nears ±0.5 at the corners).
  float edge = smoothstep(0.46, 0.497, abs(across)) * side;
  totalEmissiveRadiance += tint * (led + edge * (0.08 + 1.4 * vGlow));
}`,
      );
  };
  return material;
}

/** Standing columns under positioned voices. The column's top is where the sound is; seams
 * glow with the voice's amplitude envelope and run hotter with its filter envelope. Columns stay where
 * their last voice left them, so state at any time is derived from data, not playback history.
 */
export class MonolithEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  private root = new THREE.Group();
  private scene?: THREE.Object3D;
  private columns = new Map<string, Column>();
  private keys: string[] = [];
  private bodies?: THREE.InstancedMesh<
    THREE.BufferGeometry,
    THREE.MeshPhysicalMaterial | THREE.ShaderMaterial
  >;
  private caps?: THREE.InstancedMesh<THREE.OctahedronGeometry, THREE.MeshBasicMaterial>;
  private glow?: THREE.InstancedBufferAttribute;
  private crack?: THREE.InstancedBufferAttribute;
  private hue?: THREE.InstancedBufferAttribute;
  private height?: THREE.InstancedBufferAttribute;
  private frames: FrameCache;
  private transform = new THREE.Object3D();
  private color = new THREE.Color();
  private emberColor: THREE.Color;
  /** Brightness source in the most recent frame. */
  envelopeSource: EnvelopeSource = 'gate-approximation';
  constructor(
    readonly id: string,
    private performance: AdaptedPerformance,
    private options: MonolithOptions,
  ) {
    this.frames = new FrameCache(performance);
    this.emberColor = new THREE.Color(options.ember ?? '#ff7a2e');
  }
  load(_engine: StructureEngine<D>, context: GraphicsContext) {
    this.dispose();
    this.scene = context.scene;
    this.scene.add(this.root);
    const tracks = new Set(this.options.tracks);
    for (const voice of this.performance.definition.voices) {
      if (!tracks.has(voice.track) || voice.end <= voice.start) continue;
      const start = voiceAt(this.performance, voice, voice.start);
      // Voices are half-open [start, end): the held pose is the last instant before the end.
      const end =
        voiceAt(this.performance, voice, voice.end - 1e-9 * Math.max(1, Math.abs(voice.end))) ??
        start;
      if (!start || !end) continue;
      const key =
        this.options.key?.(start) ??
        `${voice.track}@${Math.round(start.position[0] * 4)}:${Math.round(start.position[2] * 4)}`;
      let column = this.columns.get(key);
      if (!column) this.columns.set(key, (column = { voices: [] }));
      column.voices.push({ voice, end });
    }
    for (const column of this.columns.values())
      column.voices.sort((a, b) => a.voice.start - b.voice.start);
    this.keys = [...this.columns.keys()];
    const count = this.keys.length;
    if (count > (this.options.maxColumns ?? 64))
      throw new Error(`Monolith ${this.id}: ${count} columns exceed maxColumns`);
    const meter = this.options.style === 'meter';
    const body =
      meter || this.options.shape === 'box'
        ? new THREE.BoxGeometry(1, 1, 1, 1, 6, 1)
        : new THREE.CylinderGeometry(0.38, 0.55, 1, 7, 8);
    body.translate(0, 0.5, 0);
    this.glow = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.crack = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.glow.setUsage(THREE.DynamicDrawUsage);
    this.crack.setUsage(THREE.DynamicDrawUsage);
    body.setAttribute('aGlow', this.glow);
    body.setAttribute('aCrack', this.crack);
    this.hue = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.height = new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
    this.hue.setUsage(THREE.DynamicDrawUsage);
    this.height.setUsage(THREE.DynamicDrawUsage);
    body.setAttribute('aHue', this.hue);
    body.setAttribute('aHeight', this.height);
    this.bodies = new THREE.InstancedMesh(
      body,
      meter
        ? meterMaterial()
        : new THREE.ShaderMaterial({
            vertexShader: vertex,
            fragmentShader: fragment,
            fog: true,
            uniforms: THREE.UniformsUtils.merge([
              THREE.UniformsLib.fog,
              {
                stone: { value: new THREE.Color(this.options.stone ?? '#151920') },
                ember: { value: this.emberColor },
              },
            ]),
          }),
      Math.max(1, count),
    );
    this.caps = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(1, 0),
      new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      Math.max(1, count),
    );
    if (meter) this.bodies.castShadow = this.bodies.receiveShadow = true;
    for (const mesh of [this.bodies, this.caps]) {
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = count;
      this.root.add(mesh);
    }
  }
  /** Column tops (world x, y, z) and brightness at a time; exposed for tests and HUDs. */
  state(time: number) {
    const active = new Map(this.frames.at(time).voices.map((v) => [v.id, v]));
    const sources: { exported: boolean }[] = [];
    const result = this.keys.map((key) => {
      const voices = this.columns.get(key)!.voices;
      let lo = 0,
        hi = voices.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (voices[mid].voice.start <= time) lo = mid + 1;
        else hi = mid;
      }
      if (!lo)
        return { key, present: false, position: [0, 0, 0] as const, glow: 0, crack: 0, pitch: 0 };
      const latest = voices[lo - 1],
        live = active.get(latest.voice.id);
      const state = live ?? latest.end;
      let glow = 0,
        crack = 0;
      if (live) {
        sources.push({ exported: live.amplitude !== null });
        if (live.amplitude !== null) {
          glow = live.amplitude;
          crack = live.filterEnvelope ?? live.amplitude;
        } else glow = crack = live.held ? live.velocity : 0;
      }
      return { key, present: true, position: state.position, glow, crack, pitch: state.pitch };
    });
    this.envelopeSource = envelopeSourceOf(sources);
    return result;
  }
  render(frame: EngineFrame<D>) {
    const { bodies, caps, glow, crack, hue, height: heightAttribute } = this;
    if (!bodies || !caps || !glow || !crack || !hue || !heightAttribute) return;
    if (!bodies) return;
    const ground = this.options.ground ?? 0,
      width = this.options.width ?? 0.9,
      meter = this.options.style === 'meter';
    this.state(frame.time).forEach((column, i) => {
      const [x, y, z] = column.position,
        height = column.present ? Math.max(0, y - ground) : 0;
      this.transform.position.set(x, ground, z);
      this.transform.rotation.set(0, Math.atan2(x, z), 0);
      this.transform.scale.set(height ? width : 0, height || 1e-6, height ? width : 0);
      this.transform.updateMatrix();
      bodies.setMatrixAt(i, this.transform.matrix);
      glow.setX(i, column.glow);
      crack.setX(i, column.crack);
      const hues = this.options.hues ?? { low: 42, high: 66, from: 0.52, to: 0.86 };
      const t = Math.max(0, Math.min(1, (column.pitch - hues.low) / (hues.high - hues.low)));
      hue.setX(i, hues.from + (hues.to - hues.from) * t);
      heightAttribute.setX(i, height);
      const cap = height ? width * (0.22 + 0.35 * column.glow) : 0;
      this.transform.position.set(x, y, z);
      this.transform.scale.setScalar(cap || 1e-6);
      this.transform.updateMatrix();
      caps.setMatrixAt(i, this.transform.matrix);
      if (meter) this.color.setHSL(hue.getX(i), 0.9, 0.55).multiplyScalar(0.2 + 2 * column.glow);
      else this.color.copy(this.emberColor).multiplyScalar(0.25 + column.glow);
      caps.setColorAt(i, this.color);
    });
    bodies.instanceMatrix.needsUpdate = true;
    caps.instanceMatrix.needsUpdate = true;
    if (caps.instanceColor) caps.instanceColor.needsUpdate = true;
    glow.needsUpdate = true;
    crack.needsUpdate = true;
    hue.needsUpdate = true;
    heightAttribute.needsUpdate = true;
  }
  dispose() {
    this.scene?.remove(this.root);
    disposeTree(this.root);
    this.root.clear();
    this.columns.clear();
    this.keys = [];
    this.bodies = this.caps = undefined;
  }
}
