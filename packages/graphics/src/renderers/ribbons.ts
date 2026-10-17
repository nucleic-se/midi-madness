import type { GraphicsContext } from './effects.js';
import * as THREE from 'three';
import type { EngineFrame, StructureEngine } from '../engine.js';
import {
  parameterCatalogue,
  resolveParameters,
  type GraphicsEffect,
  type GraphicsFrame,
} from './effects.js';
import { ribbonParameters } from '../parameters.js';

export interface RibbonChannel {
  id: string;
  color: string;
}
export interface RibbonEffectOptions {
  ownsCamera?: boolean;
  /** Sweep spans the view; ring forms a closed crown in the XZ plane around the origin. */
  layout?: 'sweep' | 'ring';
  /** Segments per strand, 16..1024; allocated once when loaded. */
  segments?: number;
  /** Layered strands per channel, 1..6. */
  strands?: number;
}
interface Ribbon {
  channel: number;
  strand: number;
  core: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  spine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  color: THREE.Color;
}
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Flowing silk and luminous filaments, driven only by named presentation parameters.
 * Channel energy/pitch are 0..1, pan is -1..1. Global spread/flow/twist/intensity
 * default to 1; hue is a hue-wheel offset. No accumulated simulation state is used.
 */
export class RibbonEffect<D> implements GraphicsEffect<D> {
  readonly ownsCamera: boolean;
  readonly ownsEnvironment = false;
  readonly parameters;
  get object() {
    return this.root;
  }
  private readonly channels: readonly RibbonChannel[];
  private readonly segments: number;
  private readonly strands: number;
  private readonly layout: 'sweep' | 'ring';
  private readonly root = new THREE.Group();
  private readonly tint = new THREE.Color();
  private readonly hsl = { h: 0, s: 0, l: 0 };
  private ribbons: Ribbon[] = [];
  private scene?: THREE.Object3D;
  private camera?: THREE.PerspectiveCamera;

  constructor(
    readonly id: string,
    channels: readonly RibbonChannel[],
    options: RibbonEffectOptions = {},
  ) {
    if (
      !channels.length ||
      channels.some((c) => !c.id) ||
      new Set(channels.map((c) => c.id)).size !== channels.length
    )
      throw new Error('Ribbons need unique, nonempty channel IDs');
    this.channels = channels.map((c) => ({ ...c }));
    this.parameters = parameterCatalogue(ribbonParameters(channels.map((c) => c.id)));
    this.segments = options.segments ?? 192;
    this.strands = options.strands ?? 3;
    this.layout = options.layout ?? 'sweep';
    if (this.layout !== 'sweep' && this.layout !== 'ring') throw new Error('Unknown ribbon layout');
    if (!Number.isInteger(this.segments) || this.segments < 16 || this.segments > 1024)
      throw new Error('Ribbon segments must be an integer from 16 to 1024');
    if (!Number.isInteger(this.strands) || this.strands < 1 || this.strands > 6)
      throw new Error('Ribbon strands must be an integer from 1 to 6');
    this.ownsCamera = options.ownsCamera ?? false;
    this.root.name = `ribbons:${id}`;
  }

  load(_engine: StructureEngine<D>, context: GraphicsContext): void {
    this.dispose();
    this.scene = context.scene;
    this.camera = context.camera;
    const indices = new Uint16Array(this.segments * 6);
    for (let i = 0; i < this.segments; i++)
      indices.set([i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2], i * 6);
    const geometry = (strip: boolean) => {
      const result = new THREE.BufferGeometry();
      const length = (this.segments + 1) * (strip ? 2 : 1) * 3;
      for (const name of ['position', 'color'])
        result.setAttribute(
          name,
          new THREE.BufferAttribute(new Float32Array(length), 3).setUsage(THREE.DynamicDrawUsage),
        );
      if (strip) result.setIndex(new THREE.BufferAttribute(indices, 1));
      return result;
    };
    for (let channel = 0; channel < this.channels.length; channel++) {
      for (let strand = 0; strand < this.strands; strand++) {
        const material = {
          vertexColors: true,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: true,
          fog: false,
          toneMapped: true,
        };
        const core = new THREE.Mesh(
          geometry(true),
          new THREE.MeshBasicMaterial({ ...material, side: THREE.DoubleSide, opacity: 0.6 }),
        );
        const halo = new THREE.Mesh(
          geometry(true),
          new THREE.MeshBasicMaterial({ ...material, side: THREE.DoubleSide, opacity: 0.06 }),
        );
        const spine = new THREE.Line(
          geometry(false),
          new THREE.LineBasicMaterial({ ...material, opacity: 0.8 }),
        );
        for (const object of [halo, core, spine]) {
          object.frustumCulled = false;
          this.root.add(object);
        }
        this.ribbons.push({
          channel,
          strand,
          core,
          halo,
          spine,
          color: new THREE.Color(this.channels[channel].color),
        });
      }
    }
    this.scene.add(this.root);
  }

  render(frame: GraphicsFrame<D>, input: Readonly<Record<string, number>>): void {
    const parameters = resolveParameters(this.parameters, input);
    const time = frame.animationTime ?? frame.time;
    const spread = parameters['spread'],
      flow = parameters['flow'];
    const twist = parameters['twist'],
      intensity = parameters['intensity'];
    const hue = parameters['hue'];
    for (const ribbon of this.ribbons) {
      const { channel, strand, core, halo, spine } = ribbon;
      const prefix = this.channels[channel].id;
      const energy = parameters[`${prefix}.energy`];
      const pitch = parameters[`${prefix}.pitch`];
      const pan = parameters[`${prefix}.pan`];
      const phase = channel * 1.73 + strand * 0.18;
      const speed = time * (0.35 + flow * 0.48);
      const amplitude = 0.75 + energy * 1.7;
      const frequency = 5.2 + twist * 1.6 + pitch * 1.8;
      const center = (channel - (this.channels.length - 1) / 2) * 0.75 * spread;
      const positions = core.geometry.attributes.position.array as Float32Array;
      const halos = halo.geometry.attributes.position.array as Float32Array;
      const spines = spine.geometry.attributes.position.array as Float32Array;
      const colors = core.geometry.attributes.color.array as Float32Array;
      const haloColors = halo.geometry.attributes.color.array as Float32Array;
      const spineColors = spine.geometry.attributes.color.array as Float32Array;
      ribbon.color.getHSL(this.hsl);
      this.tint.setHSL(
        this.hsl.h + hue + strand * 0.025,
        Math.min(1, this.hsl.s * 0.85 + 0.1),
        this.hsl.l,
      );
      for (let i = 0; i <= this.segments; i++) {
        // Evaluate the closing vertices at exactly zero for a seamless ring, including colors.
        const u = this.layout === 'ring' && i === this.segments ? 0 : i / this.segments;
        const wave = u * frequency + speed + phase;
        const sweep = wave * 0.73 + phase;
        let x = (u - 0.5) * (16 + spread * 2) + Math.sin(wave) * amplitude + pan * 2.5;
        let y =
          Math.sin(sweep) * amplitude * 1.65 +
          center +
          (pitch - 0.5) * 2 +
          Math.sin(u * 12 - speed * 0.6 + phase) * 0.18;
        let z = Math.cos(wave + phase) * (1 + energy) + strand * 0.13;
        // Analytic screen-plane tangent keeps ribbon widths stable around the bends.
        const dx = 16 + spread * 2 + Math.cos(wave) * amplitude * frequency;
        const dy =
          Math.cos(sweep) * amplitude * 1.65 * frequency * 0.73 +
          Math.cos(u * 12 - speed * 0.6 + phase) * 2.16;
        const inverse = 1 / Math.max(0.001, Math.hypot(dx, dy));
        const roll = wave * 0.6 + twist * u * 3 + phase;
        let nx = -dy * inverse * Math.cos(roll),
          ny = dx * inverse * Math.cos(roll),
          nz = Math.sin(roll);
        const taper = Math.pow(Math.max(0, Math.sin(Math.PI * u)), 0.65);
        let width = (0.035 + energy * 0.16 + (this.strands - strand) * 0.018) * taper;
        const shimmer = 0.6 + 0.4 * Math.pow(Math.sin(u * 17 - speed * 1.5 + phase), 4);
        let light = taper * shimmer;
        if (this.layout === 'ring') {
          const angle = u * Math.PI * 2;
          const orbit = angle + pan * 0.45;
          const spacing =
            (channel - (this.channels.length - 1) / 2) / Math.max(1, this.channels.length - 1);
          // Integer spatial harmonics keep every deformation periodic as controls change.
          const radialWave = angle * 3 - speed + phase;
          const radius =
            3.8 +
            spread * 0.7 +
            spacing * 0.45 +
            strand * 0.055 +
            (pitch - 0.5) * 0.5 +
            Math.sin(radialWave) * (0.08 + energy * 0.2) * twist +
            pan * Math.cos(angle) * 0.22;
          x = Math.cos(orbit) * radius;
          z = Math.sin(orbit) * radius;
          y =
            Math.sin(angle * 2 + speed + phase) * (0.12 + energy * 0.42) +
            Math.sin(angle * 5 - speed * 0.6 + phase) * twist * 0.055 +
            spacing * 0.18 +
            strand * 0.06;
          const ringRoll = angle * 2 + phase + Math.sin(angle * 3 - speed) * twist * 0.4;
          nx = Math.cos(orbit) * Math.cos(ringRoll);
          ny = Math.sin(ringRoll);
          nz = Math.sin(orbit) * Math.cos(ringRoll);
          width = 0.018 + energy * 0.045 + (this.strands - strand) * 0.006;
          light = 0.55 + 0.45 * Math.pow(Math.sin(angle * 4 - speed * 1.5 + phase), 4);
        }
        for (let edge = 0; edge < 2; edge++) {
          const offset = (i * 2 + edge) * 3,
            sign = edge ? 1 : -1;
          positions[offset] = x + sign * nx * width;
          positions[offset + 1] = y + sign * ny * width;
          positions[offset + 2] = z + sign * nz * width;
          halos[offset] = x + sign * nx * width * 5;
          halos[offset + 1] = y + sign * ny * width * 5;
          halos[offset + 2] = z + sign * nz * width * 5;
          colors[offset] = haloColors[offset] = this.tint.r * light;
          colors[offset + 1] = haloColors[offset + 1] = this.tint.g * light;
          colors[offset + 2] = haloColors[offset + 2] = this.tint.b * light;
        }
        const offset = i * 3;
        spines[offset] = x;
        spines[offset + 1] = y;
        spines[offset + 2] = z;
        spineColors[offset] = (this.tint.r * 0.7 + 0.3) * light;
        spineColors[offset + 1] = (this.tint.g * 0.7 + 0.3) * light;
        spineColors[offset + 2] = (this.tint.b * 0.7 + 0.3) * light;
      }
      core.material.opacity = (0.18 + energy * 0.62) * intensity;
      halo.material.opacity = (0.025 + energy * 0.08) * intensity;
      spine.material.opacity = (0.2 + energy * 0.7) * intensity;
      for (const object of [core, halo, spine]) {
        object.geometry.attributes.position.needsUpdate = true;
        object.geometry.attributes.color.needsUpdate = true;
      }
    }
    this.root.rotation.set(
      Math.sin(time * 0.11) * 0.12,
      Math.sin(time * 0.09) * 0.14,
      Math.sin(time * 0.07) * 0.05,
    );
    if (this.ownsCamera && this.camera) {
      this.camera.position.set(Math.sin(time * 0.1) * 0.65, Math.cos(time * 0.13) * 0.45, 21);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(0, 0, 0);
      this.camera.fov = 48;
      this.camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    for (const ribbon of this.ribbons)
      for (const object of [ribbon.core, ribbon.halo, ribbon.spine]) {
        object.geometry.dispose();
        object.material.dispose();
      }
    this.ribbons = [];
    this.root.clear();
    this.scene?.remove(this.root);
    this.scene = undefined;
    this.camera = undefined;
  }
}
