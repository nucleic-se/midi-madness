import { disposeTree } from './resources.js';
import type { GraphicsContext } from './effects.js';
import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import type { GraphicsEffect } from './effects.js';
import type { EngineFrame, StructureEngine } from '../engine.js';
import {
  FrameCache,
  trackPosition,
  voiceLevel,
  type AdaptedPerformance,
} from './performance-effects.js';

const hash = (n: number) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};
/** A wet ground: a lit, physically based floor (lights pool on it) under an additive mirror
 * layer that doubles every light, broken by fine ripples and dry patches. Static. */
export class WetGroundEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  private scene?: THREE.Object3D;
  private mirror?: Reflector;
  private floor?: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>;
  constructor(
    readonly id: string,
    private options: {
      radius?: number;
      color?: string;
      reflectivity?: number;
      resolution?: number;
    } = {},
  ) {}
  load(_engine: StructureEngine<D>, context: Pick<GraphicsContext, 'scene'>) {
    this.dispose();
    this.scene = context.scene;
    const size = this.options.resolution ?? 1024;
    this.mirror = new Reflector(new THREE.CircleGeometry(this.options.radius ?? 400, 96), {
      textureWidth: size,
      textureHeight: size,
      clipBias: 0.002,
      shader: {
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            color: { value: null },
            tDiffuse: { value: null },
            textureMatrix: { value: null },
            reflectivity: { value: this.options.reflectivity ?? 0.8 },
          },
        ]),
        vertexShader: /* glsl */ `
uniform mat4 textureMatrix;
varying vec4 vUv;
varying vec3 vWorld;
varying float vDepth;
void main() {
  vUv = textureMatrix * vec4(position, 1.0);
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}`,
        fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float reflectivity;
uniform float fogDensity;
varying vec4 vUv;
varying vec3 vWorld;
varying float vDepth;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  // Static ripples and puddles: distort and blur the mirror image; dry patches reflect less.
  vec2 ripple = vec2(noise(vWorld.xz * 0.6), noise(vWorld.xz * 0.6 + 17.0)) - 0.5;
  float wet = smoothstep(0.25, 0.7, noise(vWorld.xz * 0.08));
  vec4 uv = vUv;
  uv.xy += ripple * uv.w * mix(0.005, 0.0015, wet);
  vec3 reflection = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(float(i - 1) * 0.004, float(i % 2) * 0.008 - 0.004) * uv.w * (1.0 - wet * 0.7);
    reflection += texture2DProj(tDiffuse, vec4(uv.xy + o, uv.zw)).rgb;
  }
  reflection *= 0.25;
  // Additive over the lit floor; the fog thins the reflection with distance. Only light
  // brighter than the dark sky really shows: black glass with sharp neon in it.
  float fade = exp(-pow(fogDensity * vDepth, 2.0));
  vec3 bright = max(reflection - vec3(0.045), 0.0);
  gl_FragColor = vec4(bright * reflectivity * mix(0.75, 1.0, wet) * fade, 1.0);
}`,
      },
    });
    const mirrorMaterial = this.mirror.material;
    if (!(mirrorMaterial instanceof THREE.ShaderMaterial))
      throw new Error('Reflector requires a shader material');
    mirrorMaterial.fog = true;
    mirrorMaterial.transparent = true;
    mirrorMaterial.blending = THREE.AdditiveBlending;
    mirrorMaterial.depthWrite = false;
    this.mirror.rotateX(-Math.PI / 2);
    this.mirror.position.y = 0.004;
    this.floor = new THREE.Mesh(
      new THREE.CircleGeometry(this.options.radius ?? 400, 96).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: this.options.color ?? '#07080c',
        roughness: 0.42,
        metalness: 0.1,
        envMapIntensity: 0.25,
      }),
    );
    this.floor.receiveShadow = true;
    this.scene.add(this.floor, this.mirror);
  }
  render() {}
  dispose() {
    this.mirror?.removeFromParent();
    this.floor?.removeFromParent();
    this.floor?.geometry.dispose();
    this.floor?.material.dispose();
    this.mirror?.dispose();
    this.mirror?.geometry.dispose();
    this.mirror = undefined;
    this.floor = undefined;
    this.scene = undefined;
  }
}

/** Static backdrop: dark skyline silhouettes on the horizon, stars and a planet. */
export class BackdropEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  private root = new THREE.Group();
  private scene?: THREE.Object3D;
  constructor(
    readonly id: string,
    private options: { seed?: number; towers?: number; rim?: string } = {},
  ) {}
  load(_engine: StructureEngine<D>, context: Pick<GraphicsContext, 'scene'>) {
    this.dispose();
    this.scene = context.scene;
    const seed = this.options.seed ?? 1,
      count = this.options.towers ?? 90;
    const towers = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
      new THREE.MeshBasicMaterial({ color: '#010102', fog: false }),
      count,
    );
    const strips = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
      new THREE.MeshBasicMaterial({ color: this.options.rim ?? '#5a3cff', fog: false }),
      count,
    );
    const o = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + hash(seed + i) * 0.05,
        distance = 150 + hash(seed + i * 3) * 110,
        height = 8 + hash(seed + i * 7) ** 2.2 * 70,
        width = 4 + hash(seed + i * 11) * 10;
      o.position.set(Math.sin(angle) * distance, 0, -Math.cos(angle) * distance);
      o.rotation.set(0, -angle, 0);
      o.scale.set(width, height, width * 0.6);
      o.updateMatrix();
      towers.setMatrixAt(i, o.matrix);
      // A thin vertical light strip on some towers, facing the monument.
      const lit = hash(seed + i * 13) > 0.55;
      o.scale.set(lit ? 0.25 : 0, height * (0.4 + 0.5 * hash(seed + i * 17)), 0.3);
      o.translateZ(width * 0.3 + 0.2);
      o.updateMatrix();
      strips.setMatrixAt(i, o.matrix);
    }
    const stars = new THREE.BufferGeometry(),
      points: number[] = [];
    for (let i = 0; i < 1400; i++) {
      const u = hash(seed * 31 + i),
        v = hash(seed * 37 + i);
      const theta = u * Math.PI * 2,
        phi = Math.acos(0.15 + 0.85 * v);
      points.push(
        Math.sin(phi) * Math.cos(theta) * 450,
        Math.cos(phi) * 450,
        Math.sin(phi) * Math.sin(theta) * 450,
      );
    }
    stars.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    const sky = new THREE.Points(
      stars,
      new THREE.PointsMaterial({ color: '#9fb4ff', size: 1.1, sizeAttenuation: false, fog: false }),
    );
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(60, 48, 24),
      new THREE.ShaderMaterial({
        fog: false,
        uniforms: { rim: { value: new THREE.Color(this.options.rim ?? '#5a3cff') } },
        vertexShader: /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-view.xyz);
  gl_Position = projectionMatrix * view;
}`,
        fragmentShader: /* glsl */ `
uniform vec3 rim;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float edge = pow(1.0 - max(0.0, dot(vNormal, vView)), 4.0);
  gl_FragColor = vec4(vec3(0.006, 0.007, 0.012) + rim * edge * 0.9, 1.0);
}`,
      }),
    );
    planet.position.set(-160, 130, -330);
    for (const mesh of [towers, strips, sky, planet]) mesh.frustumCulled = false;
    this.root.add(towers, strips, sky, planet);
    this.scene.add(this.root);
  }
  render() {}
  dispose() {
    this.scene?.remove(this.root);
    disposeTree(this.root);
    this.root.clear();
  }
}

/** Low mist that drifts with a wind source's actual position and takes the fog's colour. */
export class GroundMistEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  private scene?: THREE.Object3D;
  private sprites?: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private wind?: (t: number) => readonly [number, number, number];
  constructor(
    readonly id: string,
    performance: AdaptedPerformance,
    private options: { windTrack?: string; count?: number; radius?: number } = {},
  ) {
    if (options.windTrack) this.wind = trackPosition(performance, options.windTrack);
  }
  load(_engine: StructureEngine<D>, context: Pick<GraphicsContext, 'scene'>) {
    this.dispose();
    this.scene = context.scene;
    const count = this.options.count ?? 160,
      radius = this.options.radius ?? 70;
    const positions: number[] = [],
      seeds: number[] = [];
    for (let i = 0; i < count; i++) {
      const r = 6 + Math.sqrt(hash(i * 3.1)) * radius,
        a = hash(i * 7.3) * Math.PI * 2;
      positions.push(Math.sin(a) * r, 0.4 + hash(i * 1.7) * 2.2, -Math.cos(a) * r);
      seeds.push(hash(i * 5.9));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('seed', new THREE.Float32BufferAttribute(seeds, 1));
    this.sprites = new THREE.Points(
      geometry,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          color: { value: new THREE.Color('#202040') },
          drift: { value: new THREE.Vector2() },
          scale: { value: 600 },
        },
        vertexShader: /* glsl */ `
attribute float seed;
uniform vec2 drift;
uniform float scale;
varying float vSeed;
void main() {
  vSeed = seed;
  vec3 p = position;
  p.xz += drift * (0.5 + seed);
  vec4 view = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = (9.0 + seed * 9.0) * scale / max(1.0, -view.z);
  gl_Position = projectionMatrix * view;
}`,
        fragmentShader: /* glsl */ `
uniform vec3 color;
varying float vSeed;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  gl_FragColor = vec4(color * exp(-r * r * 3.0) * (0.012 + 0.012 * vSeed), 1.0);
}`,
      }),
    );
    this.sprites.frustumCulled = false;
    this.scene.add(this.sprites);
  }
  render(frame: EngineFrame<D>) {
    if (!this.sprites) return;
    if (this.scene instanceof THREE.Scene && this.scene.fog)
      this.sprites.material.uniforms.color.value.copy(this.scene.fog.color).multiplyScalar(1.6);
    if (this.wind) {
      const [x, , z] = this.wind(frame.time);
      this.sprites.material.uniforms.drift.value.set(x * 0.15, z * 0.15);
    }
  }
  dispose() {
    this.sprites?.removeFromParent();
    this.sprites?.geometry.dispose();
    this.sprites?.material.dispose();
    this.sprites = undefined;
  }
}

/** A stepped dark plinth under the monument; its step edges glow with a track's level. */
export class PlinthEffect<D> implements GraphicsEffect<D> {
  readonly parameters = [];
  private root = new THREE.Group();
  private scene?: THREE.Object3D;
  private edges: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>[] = [];
  private frames: FrameCache;
  constructor(
    readonly id: string,
    performance: AdaptedPerformance,
    private options: { radii?: number[]; step?: number; track?: string; color?: string } = {},
  ) {
    this.frames = new FrameCache(performance);
  }
  load(_engine: StructureEngine<D>, context: Pick<GraphicsContext, 'scene'>) {
    this.dispose();
    this.scene = context.scene;
    const radii = this.options.radii ?? [15, 13, 11.5],
      step = this.options.step ?? 0.25;
    radii.forEach((radius, i) => {
      const slab = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius + 0.05, step, 72),
        new THREE.MeshStandardMaterial({ color: '#0a0b10', roughness: 0.32, metalness: 0.2 }),
      );
      slab.receiveShadow = true;
      slab.position.y = step * (i + 0.5);
      const edge = new THREE.Mesh(
        new THREE.TorusGeometry(radius, 0.025, 6, 144),
        new THREE.MeshBasicMaterial({
          color: this.options.color ?? '#7a5cff',
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      edge.rotation.x = Math.PI / 2;
      edge.position.y = step * (i + 1);
      this.edges.push(edge);
      this.root.add(slab, edge);
    });
    this.scene.add(this.root);
  }
  render(frame: EngineFrame<D>) {
    let level = 0;
    if (this.options.track)
      for (const v of this.frames.at(frame.time).voices)
        if (v.track === this.options.track) level = Math.max(level, voiceLevel(v).level);
    this.edges.forEach((edge, i) => {
      edge.material.color
        .set(this.options.color ?? '#7a5cff')
        .multiplyScalar(0.2 + 1.2 * level * (1 - i * 0.2));
    });
  }
  dispose() {
    this.scene?.remove(this.root);
    disposeTree(this.root);
    this.root.clear();
    this.edges = [];
  }
}
