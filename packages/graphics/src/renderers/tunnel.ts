import { disposeTree } from './resources.js';
import type { GraphicsContext } from './effects.js';
import * as THREE from 'three';
import type { EngineFrame, StructureEngine, TimedRecord } from '../engine.js';
import { parameterCatalogue, resolveParameters, type GraphicsEffect } from './effects.js';
import { tunnelParameters } from '../parameters.js';
import type { ParameterBinding } from '../bindings.js';
import { GraphicsRenderer } from './graphics.js';

export interface TunnelStyle<T = any> {
  collection: string;
  angle: (datum: T) => number;
  radius: (datum: T) => number;
  color: (datum: T) => string;
  strength: (datum: T) => number;
  unitsToDistance?: number;
  select?: (datum: T) => boolean;
}

export interface TunnelEffectOptions {
  ownsCamera?: boolean;
  ownsEnvironment?: boolean;
}

/** A presentation consumer: no pitch, instrument, BPM, or source format assumptions. */
export class TunnelEffect<D> implements GraphicsEffect<D> {
  readonly parameters = parameterCatalogue(tunnelParameters());
  readonly ownsCamera: boolean;
  readonly ownsEnvironment: boolean;
  private scene?: THREE.Object3D;
  private camera?: THREE.PerspectiveCamera;
  private fog?: THREE.FogExp2;
  private environment?: THREE.Scene;
  private previousFog?: THREE.Scene['fog'];
  private root = new THREE.Group();
  private rings: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>[] = [];
  private events: {
    color: string;
    record: TimedRecord;
    angle: number;
    radius: number;
    strength: number;
    length: number;
  }[] = [];
  private batches = new Map<
    string,
    {
      core: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
      halo: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
      count: number;
    }
  >();
  private transform = new THREE.Object3D();
  private distance: number;
  /** Geometry-only by default; the composition explicitly chooses its view owners. */
  constructor(
    readonly id: string,
    private style: TunnelStyle,
    options: TunnelEffectOptions = {},
  ) {
    this.distance = style.unitsToDistance ?? 12;
    this.ownsCamera = options.ownsCamera ?? false;
    this.ownsEnvironment = options.ownsEnvironment ?? false;
  }
  load(engine: StructureEngine<D>, context: GraphicsContext) {
    const records = engine.collections[this.style.collection];
    if (!records) throw new Error(`Unknown tunnel collection ${this.style.collection}`);
    this.clear();
    this.releaseEnvironment();
    this.scene?.remove(this.root);
    this.scene = context.scene;
    this.camera = context.camera;
    if (this.ownsEnvironment) {
      if (!(this.scene instanceof THREE.Scene))
        throw new Error('Tunnel environment requires a Scene');
      this.environment = this.scene;
      this.previousFog = this.environment.fog;
      this.fog = new THREE.FogExp2('#02040b', 0.024);
      this.environment.fog = this.fog;
    }
    this.scene.add(this.root);
    for (let i = 0; i < 56; i++) {
      const points = Array.from({ length: 49 }, (_, j) => {
        const angle = (j / 48) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(angle) * 8, Math.sin(angle) * 8, 0);
      });
      const ring = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({
          color: '#465aff',
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      this.rings.push(ring);
      this.root.add(ring);
    }
    for (const record of records) {
      if (this.style.select && !this.style.select(record.datum)) continue;
      const strength = this.style.strength(record.datum);
      const length = Math.max(0.15, (record.end - record.start) * this.distance);
      const angle = this.style.angle(record.datum),
        radius = this.style.radius(record.datum);
      this.events.push({
        color: this.style.color(record.datum),
        record,
        angle,
        radius,
        strength,
        length,
      });
    }
    // Full songs share geometry/materials; only the visible time window is drawn.
    const counts = new Map<string, number>();
    for (const event of this.events) counts.set(event.color, (counts.get(event.color) ?? 0) + 1);
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    for (const [color, capacity] of counts) {
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const core = new THREE.InstancedMesh(geometry, material, capacity);
      const haloMaterial = material.clone();
      haloMaterial.opacity = 0.13;
      const halo = new THREE.InstancedMesh(geometry, haloMaterial, capacity);
      for (const mesh of [core, halo]) {
        mesh.frustumCulled = false;
        mesh.count = 0;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      }
      this.batches.set(color, { core, halo, count: 0 });
      this.root.add(core, halo);
    }
  }
  render(frame: EngineFrame<D>, input: Readonly<Record<string, number>>) {
    const tunnel = resolveParameters(this.parameters, input);
    const z = frame.time * this.distance;
    const parameter = tunnel.modulation;
    const energy = tunnel.energy;
    const twist = frame.time * tunnel.twist;
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i];
      const depth = i * 2.5 - (z % 2.5);
      ring.position.set(
        Math.sin((z + depth) * 0.025) * 1.5,
        Math.cos((z + depth) * 0.019) * 1.2,
        z + depth,
      );
      ring.rotation.z = twist + i * 0.035;
      const radius =
        tunnel.radius + Math.sin((z + depth) * 0.13 + frame.time) * 0.07 + parameter * 0.12;
      ring.scale.set(radius, radius, 1);
      ring.material.color.setHSL(
        0.63 + Math.sin(i * 0.13 + frame.time * 0.3) * 0.09,
        0.9,
        0.42 + Math.min(energy * 0.02, 0.18),
      );
    }
    for (const batch of this.batches.values()) batch.count = 0;
    for (const event of this.events) {
      const depth = event.record.start * this.distance - z;
      if (depth + event.length <= -10 || depth >= 140) continue;
      const angle = event.angle + twist;
      this.transform.position.set(
        Math.cos(angle) * event.radius,
        Math.sin(angle) * event.radius,
        event.record.start * this.distance + event.length / 2,
      );
      this.transform.rotation.z = angle;
      const age = frame.time - event.record.start;
      const pulse = age >= 0 && age < 0.35 ? Math.exp(-age * 12) : 0;
      const scale = 1 + pulse * (3 + event.strength * 2);
      const batch = this.batches.get(event.color)!;
      this.transform.scale.set(0.09 * scale, 0.09 * scale, event.length);
      this.transform.updateMatrix();
      batch.core.setMatrixAt(batch.count, this.transform.matrix);
      this.transform.scale.set(0.32 * scale, 0.32 * scale, event.length);
      this.transform.updateMatrix();
      batch.halo.setMatrixAt(batch.count++, this.transform.matrix);
    }
    for (const batch of this.batches.values()) {
      for (const mesh of [batch.core, batch.halo]) {
        mesh.count = batch.count;
        if (batch.count) {
          mesh.instanceMatrix.clearUpdateRanges();
          mesh.instanceMatrix.addUpdateRange(0, batch.count * 16);
          mesh.instanceMatrix.needsUpdate = true;
        }
      }
    }
    if (this.ownsCamera && this.camera) {
      this.camera.position.set(
        Math.sin(frame.time * 0.6) * 1.1,
        Math.cos(frame.time * 0.47) * 0.8,
        z - 3,
      );
      this.camera.up.set(Math.sin(twist * 0.3), Math.cos(twist * 0.3), 0);
      this.camera.lookAt(
        Math.sin(frame.time * 0.3) * 1.2,
        Math.cos(frame.time * 0.25) * 0.6,
        z + 35,
      );
      this.camera.fov = 70 + Math.min(energy * 1.1, 7);
      this.camera.updateProjectionMatrix();
    }
  }
  private clear() {
    disposeTree(this.root);
    this.root.clear();
    this.events = [];
    this.rings = [];
    this.batches.clear();
  }
  private releaseEnvironment() {
    if (this.fog && this.environment?.fog === this.fog)
      this.environment.fog = this.previousFog ?? null;
    this.environment = undefined;
    this.fog = undefined;
    this.previousFog = undefined;
  }
  dispose() {
    this.clear();
    this.releaseEnvironment();
    this.scene?.remove(this.root);
  }
}

/** Convenience preset; applications can compose TunnelEffect with any other effects. */
export class TunnelRenderer<D> extends GraphicsRenderer<D> {
  constructor(
    container: HTMLElement,
    style: TunnelStyle,
    effects: GraphicsEffect<D>[] = [],
    bindings: ParameterBinding<D>[] = [],
  ) {
    super(
      container,
      [
        new TunnelEffect<D>('tunnel', style, { ownsCamera: true, ownsEnvironment: true }),
        ...effects,
      ],
      bindings,
    );
  }
}
