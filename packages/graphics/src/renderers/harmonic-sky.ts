import type { GraphicsContext } from './effects.js';
import * as THREE from 'three';
import type { GraphicsEffect } from './effects.js';
import type { EngineFrame, StructureEngine } from '../engine.js';
import { FrameCache, voiceLevel, type AdaptedPerformance } from './performance-effects.js';

export interface HarmonicSkyOptions {
  /** Tracks whose sounding pitch classes colour the sky. */
  tracks: readonly string[];
  /** Pitch classes (0 = C) of a reference chord and the hue (0..1) it should give. */
  reference?: { pitchClasses: readonly number[]; hue: number };
  /** Hue turns per turn of the circle of fifths; larger spreads chords further apart. */
  spread?: number;
  fogDensity?: number;
}
export interface SkyState {
  hue: number;
  /** Summed level of the sounding voices (0 when silent). */
  energy: number;
  horizon: [number, number, number];
  zenith: [number, number, number];
}

const fifths = (pc: number) => (((pc * 7) % 12) / 12) * Math.PI * 2;
function centroid(pitches: readonly { pc: number; weight: number }[]) {
  let x = 0,
    y = 0;
  for (const { pc, weight } of pitches) {
    x += Math.cos(fifths(pc)) * weight;
    y += Math.sin(fifths(pc)) * weight;
  }
  return Math.atan2(y, x);
}

/** The sky is the harmony: the level-weighted pitch classes on the circle of fifths set the
 * hue, their energy the brightness. Owns scene-wide environment (sky dome and fog colour).
 */
export class HarmonicSkyEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  readonly ownsEnvironment = true;
  private scene?: THREE.Scene;
  private dome?: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private fog?: THREE.FogExp2;
  private previousFog?: THREE.Scene['fog'];
  private frames: FrameCache;
  private offset = 0;
  private color = new THREE.Color();
  constructor(
    readonly id: string,
    private performance: AdaptedPerformance,
    private options: HarmonicSkyOptions,
  ) {
    this.frames = new FrameCache(performance);
    const reference = options.reference ?? { pitchClasses: [6, 9, 1], hue: 0.5 };
    this.offset =
      reference.hue +
      (centroid(reference.pitchClasses.map((pc) => ({ pc, weight: 1 }))) / (Math.PI * 2)) *
        (options.spread ?? 1.6);
  }
  load(_engine: StructureEngine<D>, context: Pick<GraphicsContext, 'scene'>) {
    this.dispose();
    if (!(context.scene instanceof THREE.Scene))
      throw new Error('Sky environment requires a Scene');
    this.scene = context.scene;
    this.previousFog = this.scene.fog;
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(500, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { horizon: { value: new THREE.Color() }, zenith: { value: new THREE.Color() } },
        vertexShader: /* glsl */ `
varying vec3 vDirection;
void main() {
  vDirection = normalize(position);
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * view;
}`,
        fragmentShader: /* glsl */ `
uniform vec3 horizon;
uniform vec3 zenith;
varying vec3 vDirection;
void main() {
  float up = vDirection.y;
  vec3 color = mix(horizon, zenith, smoothstep(0.0, 0.55, up));
  color = mix(color, horizon * 0.35, smoothstep(0.0, -0.25, up));
  gl_FragColor = vec4(color, 1.0);
}`,
      }),
    );
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;
    this.scene.add(this.dome);
    this.fog = new THREE.FogExp2('#000000', this.options.fogDensity ?? 0.012);
    this.scene.fog = this.fog;
  }
  state(time: number): SkyState {
    const tracks = new Set(this.options.tracks);
    const sounding = this.frames
      .at(time)
      .voices.filter((v) => tracks.has(v.track))
      .map((v) => ({ pc: ((Math.round(v.pitch) % 12) + 12) % 12, weight: voiceLevel(v).level }))
      .filter((p) => p.weight > 0);
    const energy = sounding.reduce((sum, p) => sum + p.weight, 0);
    // Silence returns to the reference hue, so any time renders the same regardless of history.
    const hue = sounding.length
      ? (((this.offset - (centroid(sounding) / (Math.PI * 2)) * (this.options.spread ?? 1.6)) % 1) +
          1) %
        1
      : (this.options.reference?.hue ?? 0.5);
    const level = Math.min(1, energy / 2);
    this.color.setHSL(hue, 0.65, 0.006 + 0.02 * level);
    const horizon: [number, number, number] = [this.color.r, this.color.g, this.color.b];
    this.color.setHSL((hue + 0.08) % 1, 0.6, 0.001 + 0.004 * level);
    return { hue, energy, horizon, zenith: [this.color.r, this.color.g, this.color.b] };
  }
  render(frame: EngineFrame<D>) {
    if (!this.dome || !this.fog) return;
    const state = this.state(frame.time);
    this.dome.material.uniforms.horizon.value.setRGB(...state.horizon);
    this.dome.material.uniforms.zenith.value.setRGB(...state.zenith);
    this.fog.color.setRGB(...state.horizon);
  }
  dispose() {
    if (this.scene) {
      if (this.dome) this.scene.remove(this.dome);
      if (this.scene.fog === this.fog) this.scene.fog = this.previousFog ?? null;
    }
    this.dome?.geometry.dispose();
    this.dome?.material.dispose();
    this.dome = undefined;
    this.scene = undefined;
    this.fog = undefined;
    this.previousFog = undefined;
  }
}
