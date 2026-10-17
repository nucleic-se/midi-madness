import type { GraphicsContext } from './effects.js';
import { ControlLane } from '@midi-madness/foundation/curves';
import * as THREE from 'three';
import type { GraphicsEffect } from './effects.js';
import type { EngineFrame, StructureEngine } from '../engine.js';
import { type Position3 } from '../performance.js';
import { RibbonMesh } from './ribbon-mesh.js';
import {
  FrameCache,
  envelopeSourceOf,
  trackPosition,
  voiceLevel,
  type AdaptedPerformance,
  type EnvelopeSource,
} from './performance-effects.js';

export interface TetherOptions {
  /** The moving source the filaments reach. */
  track: string;
  /** Where the filaments start (for example the heart). */
  origin: Position3;
  /** A 0..1 control of the track that sets curl (for example the filter cutoff lane). */
  curlControl?: string;
  filaments?: number;
  color?: string;
}
const hash = (n: number) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};

/** Filaments from an origin to a moving voice. Their shape is re-drawn on each new attack of
 * the track (seeded by the attack count), curl follows a control, brightness the track level.
 */
export class TetherEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  private root = new THREE.Group();
  private scene?: THREE.Object3D;
  private camera?: THREE.PerspectiveCamera;
  private strands: RibbonMesh[] = [];
  private at: (t: number) => Position3;
  private starts: number[];
  private curl?: ControlLane;
  private frames: FrameCache;
  envelopeSource: EnvelopeSource = 'gate-approximation';
  constructor(
    readonly id: string,
    performance: AdaptedPerformance,
    private options: TetherOptions,
  ) {
    this.frames = new FrameCache(performance);
    this.at = trackPosition(performance, options.track);
    this.starts = performance.attacks.filter((a) => a.track === options.track).map((a) => a.start);
    const points = options.curlControl
      ? performance.definition.tracks?.[options.track]?.controls?.[options.curlControl]
      : undefined;
    this.curl = points ? new ControlLane(points) : undefined;
  }
  load(_engine: StructureEngine<D>, context: GraphicsContext) {
    this.dispose();
    this.scene = context.scene;
    this.camera = context.camera;
    this.scene.add(this.root);
    for (let i = 0; i < (this.options.filaments ?? 7); i++) {
      const strand = new RibbonMesh(28, this.options.color ?? '#ff5fd2');
      this.strands.push(strand);
      this.root.add(strand.mesh);
    }
  }
  render(frame: EngineFrame<D>) {
    const { camera } = this;
    if (!camera) return;
    const time = frame.time,
      target = this.at(time),
      origin = this.options.origin;
    let level = 0;
    const sources: { exported: boolean }[] = [];
    for (const v of this.frames.at(time).voices)
      if (v.track === this.options.track) {
        const l = voiceLevel(v);
        level = Math.max(level, l.level);
        sources.push(l);
      }
    this.envelopeSource = envelopeSourceOf(sources);
    let lo = 0,
      hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.starts[mid] <= time) lo = mid + 1;
      else hi = mid;
    }
    const seed = lo,
      curl = 0.4 + 2.2 * (this.curl?.value(time, 0.5) ?? 0.5);
    const span = Math.hypot(target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]);
    this.strands.forEach((strand, s) => {
      const bend = [0, 1, 2].map(
        (j) => (hash(seed * 13 + s * 7 + j) - 0.5) * curl * (0.3 + span * 0.25),
      );
      const points: [number, number, number][] = [];
      for (let i = 0; i < 28; i++) {
        const t = i / 27,
          arc = Math.sin(Math.PI * t),
          wiggle =
            Math.sin(t * Math.PI * (2 + (s % 3)) + hash(seed + s) * 6.28) * 0.25 * curl * arc;
        points.push([
          origin[0] + (target[0] - origin[0]) * t + bend[0] * arc + wiggle,
          origin[1] + (target[1] - origin[1]) * t + bend[1] * arc,
          origin[2] + (target[2] - origin[2]) * t + bend[2] * arc - wiggle,
        ]);
      }
      const widths = points.map(
        (_, i) => 0.015 + 0.035 * level * Math.sin((Math.PI * i) / 27 + 0.2),
      );
      strand.update(
        points,
        widths,
        points.map(() => 0.2 + 1.3 * level),
        camera.position,
      );
    });
  }
  dispose() {
    this.scene?.remove(this.root);
    for (const strand of this.strands) strand.dispose();
    this.root.clear();
    this.strands = [];
  }
}
