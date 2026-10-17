import * as THREE from 'three';
import { monumentParameters } from '../parameters.js';
import type { StructureEngine } from '../engine.js';
import { PlacedEffect, applyPlacement, type Placement } from './composition.js';
import { ResonatorEffect } from './resonators.js';
import { RibbonEffect, type RibbonChannel } from './ribbons.js';
import { PlasmaEffect } from './plasma.js';
import {
  parameterCatalogue,
  resolveParameters,
  type GraphicsContext,
  type GraphicsEffect,
  type GraphicsFrame,
} from './effects.js';

export interface MonumentClock {
  /** Seconds represented by one frame.time unit; normally 1 for media playback. */
  secondsPerUnit: number;
  /** Visual rates retain the original bar-based phase, independently of hit-age seconds. */
  secondsPerBar: number;
}
export interface MonumentOptions {
  channels: readonly RibbonChannel[];
  clock: MonumentClock;
  placement?: Placement;
  /** Both are off by default for an embedded stage. Lights affect the entire host scene. */
  ownsCamera?: boolean;
  lighting?: boolean;
  heartColor?: string;
  particleCount?: number;
}
type Part = 'foundation' | 'crown' | 'heart';

/** A resonator foundation, ring-ribbon crown and kick-driven plasma heart.
 * No audio/files, song names, renderer, transport or animation loop are owned here.
 */
export class MonumentEffect<D> implements GraphicsEffect<D> {
  readonly object = new THREE.Group();
  readonly ownsEnvironment = false;
  readonly ownsCamera: boolean;
  readonly parameters;
  private readonly parts: readonly { name: Part; effect: PlacedEffect<D> }[];
  private readonly clock: Readonly<MonumentClock>;
  private loaded = false;
  constructor(
    readonly id: string,
    options: MonumentOptions,
  ) {
    if (
      !id ||
      ![options.clock.secondsPerUnit, options.clock.secondsPerBar].every(
        (value) => Number.isFinite(value) && value > 0,
      )
    )
      throw new Error('Monument needs an ID and positive finite clock units');
    this.clock = Object.freeze({ ...options.clock });
    this.ownsCamera = options.ownsCamera ?? false;
    this.object.name = `monument:${id}`;
    applyPlacement(this.object, options.placement ?? {});
    const channels = options.channels.map((channel) => ({ ...channel }));
    this.parts = [
      {
        name: 'foundation',
        effect: new PlacedEffect(
          new ResonatorEffect<D>(`${id}/foundation`, channels, {
            showCore: false,
            ownsCamera: this.ownsCamera,
            lighting: options.lighting ?? false,
          }),
          [0, 0, 0],
          [1, 0.42, 1],
        ),
      },
      {
        name: 'crown',
        effect: new PlacedEffect(
          new RibbonEffect<D>(`${id}/crown`, channels, { layout: 'ring', strands: 2 }),
          [0, 6.2, 0],
        ),
      },
      {
        name: 'heart',
        effect: new PlacedEffect(
          new PlasmaEffect<D>(`${id}/heart`, {
            color: options.heartColor ?? '#83edff',
            particleCount: options.particleCount ?? 420,
          }),
          [0, 3.6, 0],
        ),
      },
    ];
    this.parameters = parameterCatalogue(monumentParameters(channels.map((channel) => channel.id)));
  }
  load(engine: StructureEngine<D>, context: GraphicsContext): void {
    this.dispose();
    try {
      for (const { effect } of this.parts)
        effect.load(engine, { scene: this.object, camera: context.camera });
      context.scene.add(this.object);
      this.loaded = true;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  render(frame: GraphicsFrame<D>, input: Readonly<Record<string, number>>): void {
    if (!this.loaded) return;
    const parameters = resolveParameters(this.parameters, input);
    const animationTime =
      frame.animationTime ?? (frame.time * this.clock.secondsPerUnit) / this.clock.secondsPerBar;
    if (!Number.isFinite(animationTime)) throw new Error('Monument phase must be finite');
    const childFrame = { ...frame, animationTime };
    for (const { name, effect } of this.parts) {
      const prefix = `${name}.`;
      effect.render(
        childFrame,
        Object.fromEntries(
          Object.entries(parameters)
            .filter(([id]) => id.startsWith(prefix))
            .map(([id, value]) => [id.slice(prefix.length), value]),
        ),
      );
    }
  }
  dispose(): void {
    this.loaded = false;
    try {
      for (const { effect } of this.parts) effect.dispose();
    } finally {
      this.object.clear();
      this.object.removeFromParent();
    }
  }
}
