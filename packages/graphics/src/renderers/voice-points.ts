import type { GraphicsContext } from './effects.js';
import * as THREE from 'three';
import type { GraphicsEffect } from './effects.js';
import type { EngineFrame, StructureEngine } from '../engine.js';
import {
  FrameCache,
  envelopeSourceOf,
  voiceLevel,
  type AdaptedPerformance,
  type EnvelopeSource,
} from './performance-effects.js';

export interface VoicePointsOptions {
  tracks: readonly string[];
  color?: string;
  /** World size of a point at full level. */
  size?: number;
  max?: number;
}

/** A glowing point at every sounding voice: size and brightness follow its level. */
export class VoicePointsEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  private scene?: THREE.Object3D;
  private points?: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private frames: FrameCache;
  envelopeSource: EnvelopeSource = 'gate-approximation';
  constructor(
    readonly id: string,
    performance: AdaptedPerformance,
    private options: VoicePointsOptions,
  ) {
    this.frames = new FrameCache(performance);
  }
  load(_engine: StructureEngine<D>, context: Pick<GraphicsContext, 'scene'>) {
    this.dispose();
    this.scene = context.scene;
    const max = this.options.max ?? 256;
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
          color: { value: new THREE.Color(this.options.color ?? '#ffd7a0') },
          size: { value: this.options.size ?? 1.2 },
          scale: { value: 600 },
        },
        vertexShader: /* glsl */ `
attribute float level;
uniform float size;
uniform float scale;
varying float vLevel;
void main() {
  vLevel = level;
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * (0.35 + level) * scale / max(0.1, -view.z);
  gl_Position = projectionMatrix * view;
}`,
        fragmentShader: /* glsl */ `
uniform vec3 color;
varying float vLevel;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float glow = exp(-r * r * 4.0) + 0.6 * exp(-r * r * 40.0);
  gl_FragColor = vec4(color * glow * vLevel * 3.0, 1.0);
}`,
      }),
    );
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }
  /** Sounding voices of the selected tracks with their levels. */
  state(time: number) {
    const tracks = new Set(this.options.tracks);
    const sources: { exported: boolean }[] = [];
    const result = this.frames
      .at(time)
      .voices.filter((v) => tracks.has(v.track))
      .map((v) => {
        const { level, exported } = voiceLevel(v);
        sources.push({ exported });
        return { position: v.position, level };
      });
    this.envelopeSource = envelopeSourceOf(sources);
    return result;
  }
  render(frame: EngineFrame<D>) {
    const { points } = this;
    if (!points) return;
    const voices = this.state(frame.time).slice(0, this.options.max ?? 256);
    const position = points.geometry.attributes.position,
      level = points.geometry.attributes.level;
    voices.forEach((v, i) => {
      position.setXYZ(i, ...v.position);
      level.setX(i, v.level);
    });
    points.geometry.setDrawRange(0, voices.length);
    position.needsUpdate = level.needsUpdate = true;
  }
  dispose() {
    this.points?.removeFromParent();
    this.points?.geometry.dispose();
    this.points?.material.dispose();
    this.points = undefined;
  }
}
