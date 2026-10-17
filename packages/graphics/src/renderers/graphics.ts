import * as THREE from 'three';
import type { StructureEngine, EngineFrame, EngineRenderer } from '../engine.js';
import { bindParameters, type ParameterBinding } from '../bindings.js';
import { bindingDestinations, type GraphicsEffect } from './effects.js';

/** Composes reusable effects. Scheduling and musical interpretation live elsewhere. */
export class GraphicsRenderer<D> implements EngineRenderer<D> {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 180);
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private resize: ResizeObserver;
  constructor(
    container: HTMLElement,
    private effects: GraphicsEffect<D>[],
    private bindings: ParameterBinding<D>[] = [],
  ) {
    this.scene.background = new THREE.Color('#02040b');
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.append(this.renderer.domElement);
    this.resize = new ResizeObserver(() => {
      const { width, height } = container.getBoundingClientRect();
      this.camera.aspect = width / Math.max(1, height);
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
    });
    this.resize.observe(container);
  }
  load(engine: StructureEngine<D>) {
    const ids = new Set(this.effects.map((effect) => effect.id));
    if (ids.size !== this.effects.length) throw new Error('Effect IDs must be unique');
    if (this.effects.filter((effect) => effect.ownsCamera).length > 1)
      throw new Error('Only one effect may own the camera');
    if (this.effects.filter((effect) => effect.ownsEnvironment).length > 1)
      throw new Error('Only one effect may own the environment');
    for (const binding of this.bindings)
      if (!ids.has(binding.effect)) throw new Error(`Unknown effect ${binding.effect}`);
    for (const effect of this.effects)
      effect.load(engine, { scene: this.scene, camera: this.camera });
    this.render(engine.frame(0));
  }
  render(frame: EngineFrame<D>) {
    const parameters = bindParameters(frame, this.bindings, bindingDestinations(this.effects));
    for (const effect of this.effects) effect.render(frame, parameters[effect.id] ?? {});
    this.renderer.render(this.scene, this.camera);
  }
  dispose() {
    this.resize.disconnect();
    for (const effect of this.effects) effect.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
