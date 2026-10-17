import type { GraphicsContext } from './effects.js';
import * as THREE from 'three';
import type { EngineFrame, StructureEngine } from '../engine.js';
import {
  parameterCatalogue,
  resolveParameters,
  type GraphicsEffect,
  type GraphicsFrame,
} from './effects.js';
import { plasmaParameters } from '../parameters.js';
import { disposeTree } from './resources.js';

export interface PlasmaOptions {
  color?: string;
  particleCount?: number;
}
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const hash = (n: number) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};
const FILAMENTS = 18,
  SEGMENTS = 14;

const coreVertex = `
varying vec3 vNormal;
varying vec3 vPosition;
void main() {
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vPosition = view.xyz;
  gl_Position = projectionMatrix * view;
}`;
const coreFragment = `
uniform vec3 tint;
uniform float time;
uniform float power;
varying vec3 vNormal;
varying vec3 vPosition;
void main() {
  vec3 n = normalize(vNormal);
  float rim = pow(1.0 - max(dot(n, normalize(-vPosition)), 0.0), 2.0);
  float veins = pow(0.5 + 0.5 * sin(n.x * 19.0 + sin(n.y * 17.0 - time * 2.0) + n.z * 13.0), 6.0);
  vec3 color = mix(vec3(1.0, 0.98, 0.92), tint, rim * 0.8);
  color += tint * veins * 0.5;
  gl_FragColor = vec4(color * power, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const particleVertex = `
attribute float alpha;
attribute float size;
attribute float seed;
varying float vAlpha;
varying float vSeed;
uniform float power;
void main() {
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * view;
  gl_PointSize = clamp(size * 95.0 / max(0.5, -view.z), 1.0, 40.0);
  vAlpha = alpha * power;
  vSeed = seed;
}`;
const particleFragment = `
uniform vec3 tint;
varying float vAlpha;
varying float vSeed;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float halo = exp(-r * r * 5.0) * (1.0 - smoothstep(0.7, 1.0, r));
  float core = exp(-r * r * 32.0);
  vec3 color = mix(tint, vec3(1.0, 0.2, 0.65), smoothstep(0.65, 1.0, vSeed) * 0.65);
  gl_FragColor = vec4(color + vec3(core), halo * vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * A luminous 3D heart with kick-driven radial jets and curling filaments.
 * Parameters: pulse 0..1; hitAge seconds since the latest trigger (omit for idle);
 * intensity 0..4 (default 1); radius 0.2..3 (default 1); hue in turns;
 * spin -4..4 (default 0.5). All motion is a function of absolute time and hitAge.
 * Musical interpretation, positioning, camera, and environment belong to callers.
 */
export class PlasmaEffect<D> implements GraphicsEffect<D> {
  private scene?: THREE.Object3D;
  private root?: THREE.Group;
  readonly parameters = parameterCatalogue(plasmaParameters());
  get object() {
    return this.root;
  }
  private core?: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private points?: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private filaments?: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private halos: THREE.Sprite[] = [];
  private texture?: THREE.DataTexture;
  private readonly color: string;
  private readonly particleCount: number;
  private readonly tint = new THREE.Color();

  constructor(
    readonly id: string,
    options: PlasmaOptions = {},
  ) {
    this.color = options.color ?? '#75eaff';
    if (
      options.particleCount !== undefined &&
      (!Number.isInteger(options.particleCount) ||
        options.particleCount < 1 ||
        options.particleCount > 2048)
    )
      throw new Error('Plasma particleCount must be an integer from 1 to 2048');
    this.particleCount = options.particleCount ?? 320;
  }

  load(_engine: StructureEngine<D>, context: GraphicsContext) {
    this.dispose();
    this.scene = context.scene;
    this.root = new THREE.Group();
    this.root.name = this.id;
    this.tint.set(this.color);
    this.core = new THREE.Mesh(
      new THREE.SphereGeometry(0.48, 32, 24),
      new THREE.ShaderMaterial({
        vertexShader: coreVertex,
        fragmentShader: coreFragment,
        toneMapped: true,
        uniforms: { tint: { value: this.tint }, time: { value: 0 }, power: { value: 1 } },
      }),
    );
    this.root.add(this.core);

    const pixels = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const r = Math.hypot((x - 31.5) / 31.5, (y - 31.5) / 31.5);
        const i = (y * 64 + x) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
        pixels[i + 3] = Math.round(255 * Math.exp(-r * r * 5.5) * Math.max(0, 1 - r));
      }
    this.texture = new THREE.DataTexture(pixels, 64, 64, THREE.RGBAFormat);
    this.texture.magFilter = this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
    for (let i = 0; i < 3; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.texture,
          color: this.color,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: true,
        }),
      );
      this.halos.push(sprite);
      this.root.add(sprite);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(this.particleCount * 3), 3),
    );
    geometry.setAttribute(
      'alpha',
      new THREE.BufferAttribute(new Float32Array(this.particleCount), 1),
    );
    geometry.setAttribute(
      'size',
      new THREE.BufferAttribute(
        Float32Array.from({ length: this.particleCount }, (_, i) => 0.25 + hash(i + 20) * 0.7),
        1,
      ),
    );
    geometry.setAttribute(
      'seed',
      new THREE.BufferAttribute(
        Float32Array.from({ length: this.particleCount }, (_, i) => hash(i + 39)),
        1,
      ),
    );
    this.points = new THREE.Points(
      geometry,
      new THREE.ShaderMaterial({
        vertexShader: particleVertex,
        fragmentShader: particleFragment,
        uniforms: { tint: { value: this.tint }, power: { value: 1 } },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: true,
      }),
    );
    this.points.frustumCulled = false;
    this.root.add(this.points);

    const filamentGeometry = new THREE.BufferGeometry();
    filamentGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(FILAMENTS * SEGMENTS * 6), 3),
    );
    this.filaments = new THREE.LineSegments(
      filamentGeometry,
      new THREE.LineBasicMaterial({
        color: this.color,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: true,
      }),
    );
    this.filaments.frustumCulled = false;
    this.root.add(this.filaments);
    this.scene.add(this.root);
  }

  render(frame: GraphicsFrame<D>, input: Readonly<Record<string, number>>) {
    if (!this.root || !this.core || !this.points || !this.filaments) return;
    const parameters = resolveParameters(this.parameters, input);
    const pulse = parameters['pulse'],
      age = parameters['hitAge'];
    const intensity = parameters['intensity'],
      radius = parameters['radius'];
    const spin = parameters['spin'],
      time = frame.animationTime ?? frame.time;
    const burst = Math.exp(-age * 2.6);
    this.tint.set(this.color).offsetHSL(parameters['hue'], 0, 0);
    this.root.scale.setScalar(radius);
    this.root.visible = intensity > 0;
    this.core.scale.setScalar(1 + pulse * 0.42 + Math.sin(time * 2.3) * 0.025);
    this.core.rotation.set(time * 0.11, time * spin * 0.27, 0);
    this.core.material.uniforms.time.value = time;
    this.core.material.uniforms.power.value = (1.1 + pulse * 1.7) * intensity;
    for (let i = 0; i < this.halos.length; i++) {
      this.halos[i].scale.setScalar((1.5 + i * 1.25) * (1 + pulse * 0.65));
      this.halos[i].material.color.copy(this.tint);
      this.halos[i].material.opacity = (0.65 / (i + 1) + pulse * 0.18) * intensity;
    }

    const positions = this.points.geometry.attributes.position;
    const alphas = this.points.geometry.attributes.alpha;
    for (let i = 0; i < this.particleCount; i++) {
      const delay = hash(i + 2) * 0.09;
      const t = Math.max(0, age - delay);
      const azimuth = hash(i + 3) * Math.PI * 2 + time * spin * 0.16 + t * spin;
      const vertical = hash(i + 5) * 1.8 - 0.75;
      const horizontal = Math.sqrt(Math.max(0.05, 1 - vertical * vertical));
      const speed = 2.2 + hash(i + 7) * 5.5;
      const distance = 0.48 + (speed * (1 - Math.exp(-t * 1.25))) / 1.25;
      const curl = Math.sin(t * 5 + hash(i + 8) * 6.28) * t * 0.12;
      positions.setXYZ(
        i,
        Math.cos(azimuth) * horizontal * distance + curl,
        vertical * distance - t * t * 0.42,
        Math.sin(azimuth) * horizontal * distance - curl,
      );
      alphas.setX(i, age < delay ? 0 : Math.max(0, 1 - t / 1.75) ** 2 * (0.7 + hash(i + 10) * 0.5));
    }
    positions.needsUpdate = alphas.needsUpdate = true;
    this.points.material.uniforms.power.value = intensity * (0.8 + pulse * 0.6);

    const lines = this.filaments.geometry.attributes.position;
    const reach = 0.85 + (1 - Math.exp(-age * 7)) * Math.exp(-age * 1.4) * 3.2 + pulse * 1.4;
    for (let strand = 0; strand < FILAMENTS; strand++) {
      const azimuth = (strand / FILAMENTS) * Math.PI * 2 + time * spin * 0.3;
      const elevation = hash(strand + 50) * 1.5 - 0.65;
      for (let segment = 0; segment < SEGMENTS; segment++)
        for (let end = 0; end < 2; end++) {
          const u = (segment + end) / SEGMENTS;
          const distance = 0.43 + u * reach;
          const curl = Math.sin(u * 8 - age * 5 + strand) * u * 0.23;
          const angle = azimuth + u * (0.7 + spin * 0.4) + curl;
          lines.setXYZ(
            (strand * SEGMENTS + segment) * 2 + end,
            Math.cos(angle) * distance,
            elevation * distance + Math.sin(u * 10 + strand + time) * u * 0.18,
            Math.sin(angle) * distance,
          );
        }
    }
    lines.needsUpdate = true;
    this.filaments.material.color.copy(this.tint);
    this.filaments.material.opacity = (0.08 + burst * 0.8 + pulse * 0.2) * intensity;
  }

  dispose() {
    if (this.root) {
      this.scene?.remove(this.root);
      disposeTree(this.root);
    }
    this.texture?.dispose();
    this.root = undefined;
    this.core = undefined;
    this.points = undefined;
    this.filaments = undefined;
    this.texture = undefined;
    this.scene = undefined;
    this.halos = [];
  }
}
