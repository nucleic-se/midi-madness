import type { GraphicsContext } from './effects.js';
import * as THREE from 'three';
import {
  parameterCatalogue,
  resolveParameters,
  type GraphicsEffect,
  type GraphicsFrame,
} from './effects.js';
import { resonatorParameters } from '../parameters.js';
import { disposeTree } from './resources.js';
import type { StructureEngine, EngineFrame } from '../engine.js';

/** Reusable geometric instrument: scalar parameters build a luminous moving lattice. */
export class ResonatorEffect<D> implements GraphicsEffect<D> {
  readonly ownsCamera: boolean;
  readonly parameters;
  get object() {
    return this.root;
  }
  private root = new THREE.Group();
  private camera?: THREE.PerspectiveCamera;
  private scene?: THREE.Object3D;
  private banks: {
    id: string;
    mesh: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
    material: THREE.MeshStandardMaterial;
    color: THREE.Color;
  }[] = [];
  private center?: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshBasicMaterial>;
  private rings: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>[] = [];
  private transform = new THREE.Object3D();
  constructor(
    readonly id: string,
    private channels: { id: string; color: string }[],
    private options: { showCore?: boolean; ownsCamera?: boolean; lighting?: boolean } = {},
  ) {
    if (
      !channels.length ||
      channels.some((channel) => !channel.id) ||
      new Set(channels.map((c) => c.id)).size !== channels.length
    )
      throw new Error('Resonators need unique, nonempty channel IDs');
    this.channels = channels.map((channel) => ({ ...channel }));
    this.options = { ...options };
    this.ownsCamera = options.ownsCamera ?? false;
    this.parameters = parameterCatalogue(
      resonatorParameters(channels.map((channel) => channel.id)),
    );
    this.root.name = `resonators:${id}`;
  }
  load(_engine: StructureEngine<D>, context: GraphicsContext) {
    this.dispose();
    this.scene = context.scene;
    this.camera = context.camera;
    this.scene.add(this.root);
    const geometry = new THREE.BoxGeometry(0.48, 1, 0.48);
    this.channels.forEach((channel) => {
      const color = new THREE.Color(channel.color);
      const material = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.6,
        roughness: 0.22,
        metalness: 0.5,
      });
      const mesh = new THREE.InstancedMesh(geometry, material, 28);
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.root.add(mesh);
      this.banks.push({ id: channel.id, mesh, material, color });
    });
    if (this.options.lighting) {
      this.root.add(new THREE.HemisphereLight('#adbfff', '#080319', 0.8));
      const light = new THREE.DirectionalLight('#fff5de', 1.3);
      light.position.set(4, 12, 8);
      this.root.add(light);
    }
    if (this.options.showCore !== false) {
      this.center = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1.6, 1),
        new THREE.MeshBasicMaterial({
          color: '#d2b5ff',
          wireframe: true,
          transparent: true,
          opacity: 0.7,
        }),
      );
      this.center.position.y = 3.5;
      this.root.add(this.center);
    }
    for (let i = 0; i < 5; i++) {
      const points = Array.from(
        { length: 97 },
        (_, j) =>
          new THREE.Vector3(
            Math.cos((j / 96) * Math.PI * 2) * 8,
            0,
            Math.sin((j / 96) * Math.PI * 2) * 8,
          ),
      );
      const ring = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({
          color: '#6783ed',
          transparent: true,
          opacity: 0.18,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      this.rings.push(ring);
      this.root.add(ring);
    }
  }
  render(frame: GraphicsFrame<D>, input: Readonly<Record<string, number>>) {
    const parameters = resolveParameters(this.parameters, input);
    const time = frame.animationTime ?? frame.time,
      spread = parameters.spread,
      flow = parameters.flow;
    const pulse = Math.min(3, parameters.pulse),
      intensity = parameters.intensity;
    this.banks.forEach((bank, row) => {
      const energy = Math.min(3, parameters[`${bank.id}.energy`]),
        pitch = parameters[`${bank.id}.pitch`],
        pan = parameters[`${bank.id}.pan`];
      bank.material.emissiveIntensity = (0.35 + energy * 1.1) * intensity;
      bank.material.color.copy(bank.color).offsetHSL(parameters.hue, 0, 0);
      bank.material.emissive.copy(bank.material.color);
      for (let i = 0; i < 28; i++) {
        const phase = (i / 28) * Math.PI * 2 + time * flow * 0.65 + row * 0.7;
        const height =
          0.25 +
          (0.35 + energy * 4 + pulse * 0.7) * (0.35 + Math.pow(Math.sin(phase * (1 + pitch)), 2));
        const arc = ((i - 13.5) / 28) * Math.PI * 1.65;
        const radius = (6 + row * 1.5) * spread;
        this.transform.position.set(
          Math.sin(arc) * radius + pan,
          height / 2,
          Math.cos(arc) * radius,
        );
        this.transform.rotation.set(0, arc, Math.sin(time * 0.35 + i * 0.18) * energy * 0.05);
        this.transform.scale.set(1, height, 1);
        this.transform.updateMatrix();
        bank.mesh.setMatrixAt(i, this.transform.matrix);
      }
      bank.mesh.instanceMatrix.needsUpdate = true;
    });
    if (this.center) {
      this.center.rotation.set(time * 0.12, time * 0.2, time * 0.07);
      this.center.scale.setScalar(0.8 + pulse * 0.35);
    }
    this.rings.forEach((ring, i) => {
      ring.position.y = -0.1 + i * 0.02;
      ring.scale.setScalar(0.45 + ((time * 0.15 + i / 5) % 1) * 1.5);
      ring.material.opacity = 0.07 + pulse * 0.09;
    });
    if (this.ownsCamera && this.camera) {
      this.camera.position.set(Math.sin(time * 0.09) * 8, 7 + Math.sin(time * 0.12), 20);
      this.camera.up.set(0, 1, 0);
      this.camera.fov = 48;
      this.camera.lookAt(0, 2.8, 0);
      this.camera.updateProjectionMatrix();
    }
  }
  dispose() {
    disposeTree(this.root);
    this.root.clear();
    this.scene?.remove(this.root);
    this.banks = [];
    this.rings = [];
    this.center = undefined;
    this.camera = undefined;
    this.scene = undefined;
  }
}
