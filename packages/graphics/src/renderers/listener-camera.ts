import type * as THREE from 'three';
import type { GraphicsContext } from './effects.js';
import type { GraphicsEffect } from './effects.js';
import type { EngineFrame, StructureEngine } from '../engine.js';
import type { AdaptedPerformance } from './performance-effects.js';

/** The camera is the listener: its position and orientation come only from the listener lanes.
 * Yaw turns clockwise seen from above (toward +x) and pitch looks up, so Three.js receives
 * rotation order YXZ with y = -yaw and x = pitch.
 */
export class ListenerCameraEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  readonly ownsCamera = true;
  private camera?: THREE.PerspectiveCamera;
  constructor(
    readonly id: string,
    private performance: AdaptedPerformance,
    private options: { fov?: number; near?: number; far?: number } = {},
  ) {}
  load(_engine: StructureEngine<D>, context: GraphicsContext) {
    this.camera = context.camera;
    this.camera.rotation.order = 'YXZ';
    this.camera.up.set(0, 1, 0);
    if (this.options.fov) this.camera.fov = this.options.fov;
    if (this.options.near) this.camera.near = this.options.near;
    if (this.options.far) this.camera.far = this.options.far;
    this.camera.updateProjectionMatrix();
  }
  render(frame: EngineFrame<D>) {
    const { camera } = this;
    if (!camera) return;
    const listener = this.performance.engine.listener(frame.time);
    camera.position.fromArray(listener.position);
    camera.rotation.set((listener.pitch * Math.PI) / 180, (-listener.yaw * Math.PI) / 180, 0);
    camera.updateMatrixWorld();
  }
  dispose() {
    this.camera = undefined;
  }
}
