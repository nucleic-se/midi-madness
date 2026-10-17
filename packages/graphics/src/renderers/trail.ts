import type { GraphicsContext } from './effects.js';
import * as THREE from 'three';
import type { GraphicsEffect } from './effects.js';
import type { EngineFrame, StructureEngine } from '../engine.js';
import type { Position3 } from '../performance.js';
import { RibbonMesh } from './ribbon-mesh.js';
import {
  FrameCache,
  envelopeSourceOf,
  trackPosition,
  voiceLevel,
  type AdaptedPerformance,
  type EnvelopeSource,
} from './performance-effects.js';

export interface TrailOptions {
  /** Tracks whose position lanes are traced, one ribbon each. */
  tracks: readonly string[];
  /** Seconds of history drawn; a source that stops moving pulls its trail into a point. */
  length?: number;
  /** Half-width at the head when the track sounds at full level. */
  width?: number;
  color?: string;
  samples?: number;
}

/** Light ribbons along a moving source's actual recent path. The head is where the sound is
 * now; width and brightness follow the track's sounding level; the tail fades with age.
 */
export class TrailEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  private root = new THREE.Group();
  private scene?: THREE.Object3D;
  private camera?: THREE.PerspectiveCamera;
  private ribbons: { track: string; ribbon: RibbonMesh; at: (t: number) => Position3 }[] = [];
  private frames: FrameCache;
  envelopeSource: EnvelopeSource = 'gate-approximation';
  constructor(
    readonly id: string,
    private performance: AdaptedPerformance,
    private options: TrailOptions,
  ) {
    this.frames = new FrameCache(performance);
  }
  load(_engine: StructureEngine<D>, context: GraphicsContext) {
    this.dispose();
    this.scene = context.scene;
    this.camera = context.camera;
    this.scene.add(this.root);
    for (const track of this.options.tracks) {
      const ribbon = new RibbonMesh(this.options.samples ?? 96, this.options.color ?? '#7fe8ff');
      this.root.add(ribbon.mesh);
      this.ribbons.push({ track, ribbon, at: trackPosition(this.performance, track) });
    }
  }
  /** Track level now: the loudest sounding voice of the track. */
  level(track: string, time: number) {
    let level = 0;
    const sources: { exported: boolean }[] = [];
    for (const v of this.frames.at(time).voices)
      if (v.track === track) {
        const l = voiceLevel(v);
        level = Math.max(level, l.level);
        sources.push(l);
      }
    return { level, sources };
  }
  /** History points (oldest first) of a track's trail at a time. */
  path(track: string, time: number) {
    const entry = this.ribbons.find((r) => r.track === track)!,
      count = this.options.samples ?? 96,
      length = this.options.length ?? 2.5;
    return Array.from({ length: count }, (_, i) => entry.at(time - length * (1 - i / (count - 1))));
  }
  render(frame: EngineFrame<D>) {
    const { camera } = this;
    if (!camera) return;
    const sources: { exported: boolean }[] = [];
    const count = this.options.samples ?? 96,
      width = this.options.width ?? 0.08;
    for (const { track, ribbon } of this.ribbons) {
      const { level, sources: s } = this.level(track, frame.time);
      sources.push(...s);
      const points = this.path(track, frame.time);
      const fade = Array.from({ length: count }, (_, i) => (i / (count - 1)) ** 1.6);
      // A thin streak of light: nearly constant width, brightness fading with age.
      ribbon.update(
        points,
        fade.map((a) => width * (0.5 + 0.5 * level) * (0.6 + 0.4 * a)),
        fade.map((a) => a * (0.1 + 0.8 * level)),
        camera.position,
      );
    }
    this.envelopeSource = envelopeSourceOf(sources);
  }
  dispose() {
    this.scene?.remove(this.root);
    for (const { ribbon } of this.ribbons) ribbon.dispose();
    this.root.clear();
    this.ribbons = [];
  }
}
