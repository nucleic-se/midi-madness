import * as THREE from 'three';
import type { StructureEngine } from '../engine.js';
import type { GraphicsEffect, GraphicsContext, GraphicsFrame } from './effects.js';

export interface Placement {
  position?: readonly [number, number, number];
  /** Euler XYZ angles in radians in the parent's coordinate system. */
  rotation?: readonly [number, number, number];
  scale?: readonly [number, number, number];
}
export function applyPlacement(object: THREE.Object3D, placement: Placement): void {
  const position = placement.position ?? [0, 0, 0];
  const rotation = placement.rotation ?? [0, 0, 0];
  const scale = placement.scale ?? [1, 1, 1];
  for (const vector of [position, rotation, scale])
    if (vector.length !== 3 || !vector.every(Number.isFinite))
      throw new Error('Placement needs finite XYZ triples');
  if (scale.some((value) => value === 0)) throw new Error('Placement scale must be nonzero');
  object.position.fromArray(position);
  object.rotation.set(...rotation, 'XYZ');
  object.scale.fromArray(scale);
  object.updateMatrixWorld(true);
}

/** Owns placement; borrows the host scene/camera. The exposed root is stable. */
export class PlacedEffect<D> implements GraphicsEffect<D> {
  readonly id: string;
  readonly ownsCamera: boolean;
  readonly object = new THREE.Group();
  get parameters() {
    return this.effect.parameters;
  }
  constructor(
    private effect: GraphicsEffect<D>,
    position: readonly [number, number, number],
    scale: readonly [number, number, number] = [1, 1, 1],
    rotation: readonly [number, number, number] = [0, 0, 0],
  ) {
    if (effect.ownsEnvironment)
      throw new Error('Place geometry effects; environment belongs to the host');
    this.id = effect.id;
    this.ownsCamera = effect.ownsCamera ?? false;
    this.object.name = `placement:${effect.id}`;
    applyPlacement(this.object, { position, scale, rotation });
  }
  load(engine: StructureEngine<D>, context: GraphicsContext) {
    this.dispose();
    context.scene.add(this.object);
    try {
      this.effect.load(engine, { scene: this.object, camera: context.camera });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  render(frame: GraphicsFrame<D>, parameters: Readonly<Record<string, number>>) {
    this.effect.render(frame, parameters);
  }
  dispose() {
    try {
      this.effect.dispose();
    } finally {
      this.object.clear();
      this.object.removeFromParent();
    }
  }
}
