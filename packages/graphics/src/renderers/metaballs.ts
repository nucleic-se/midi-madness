import type { GraphicsContext } from './effects.js';
import * as THREE from 'three';
import type { EngineFrame, StructureEngine } from '../engine.js';
import { parameterCatalogue, resolveParameters, type GraphicsEffect } from './effects.js';
import { metaballParameters } from '../parameters.js';

export interface MetaballChannel {
  id: string;
  color: string;
}

const MAX_BALLS = 12;
const vertexShader = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const fragmentShader = `
precision highp float;
varying vec2 vUv;
uniform vec4 balls[12];
uniform vec3 colors[12];
uniform int ballCount;
uniform float aspect;
uniform float time;
uniform float merge;
uniform float hue;
uniform float intensity;

float field(vec3 p) {
  float d = 100.0;
  for (int i = 0; i < 12; i++) {
    if (i >= ballCount) break;
    float b = length(p - balls[i].xyz) - balls[i].w;
    float h = max(merge - abs(d - b), 0.0) / merge;
    d = min(d, b) - h * h * merge * 0.25;
  }
  return d;
}

vec3 surfaceColor(vec3 p) {
  float d = 100.0;
  vec3 c = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    if (i >= ballCount) break;
    float b = length(p - balls[i].xyz) - balls[i].w;
    float h = clamp(0.5 + 0.5 * (b - d) / merge, 0.0, 1.0);
    c = mix(colors[i], c, h);
    d = mix(b, d, h) - merge * h * (1.0 - h);
  }
  return c;
}

vec3 normalAt(vec3 p) {
  vec2 e = vec2(0.0015, -0.0015);
  return normalize(e.xyy * field(p + e.xyy) + e.yyx * field(p + e.yyx)
    + e.yxy * field(p + e.yxy) + e.xxx * field(p + e.xxx));
}

vec3 spectrum(float x) {
  return 0.5 + 0.5 * cos(6.2831853 * (x + vec3(0.0, 0.33, 0.67)));
}

void main() {
  vec2 uv = (vUv - 0.5) * 2.0;
  uv.x *= aspect;
  // Keep the sculpture framed on narrow screens as well as wide displays.
  float framing = max(1.0, 0.85 / aspect);
  vec3 ro = vec3(0.0, 0.0, 7.5 * framing);
  vec3 rd = normalize(vec3(uv * 0.49, -1.0));
  float aurora = sin(uv.x * 1.4 + sin(uv.y * 2.1 + time * 0.15) + time * 0.11);
  vec3 background = vec3(0.008, 0.013, 0.035);
  background += spectrum(0.62 + aurora * 0.11 + hue) * 0.065
    * exp(-abs(uv.y + aurora * 0.3) * 1.5);
  background += vec3(0.025, 0.015, 0.06) / (1.0 + dot(uv, uv) * 1.8);

  // Bound the ray before marching; most background pixels do very little work.
  float b = dot(ro, rd);
  float discriminant = b * b - dot(ro, ro) + 30.25;
  float travel = 0.0;
  float glow = 0.0;
  bool hit = false;
  vec3 p = ro;
  if (discriminant > 0.0) {
    float root = sqrt(discriminant);
    travel = max(0.0, -b - root);
    float far = -b + root;
    for (int step = 0; step < 56; step++) {
      p = ro + rd * travel;
      float d = field(p);
      glow += exp(-abs(d) * 6.0) * 0.012;
      if (d < 0.0025) { hit = true; break; }
      travel += max(d * 0.85, 0.002);
      if (travel > far) break;
    }
  }

  vec3 color = background;
  if (hit) {
    vec3 n = normalAt(p);
    vec3 view = -rd;
    vec3 reflected = reflect(rd, n);
    vec3 base = surfaceColor(p);
    float fresnel = pow(1.0 - max(dot(n, view), 0.0), 3.0);
    vec3 iridescence = spectrum(dot(n, view) * 0.55 + p.z * 0.08 + hue + time * 0.025);
    vec3 key = normalize(vec3(-0.6, 0.9, 1.3));
    vec3 fill = normalize(vec3(0.9, -0.2, 0.6));
    float diffuse = max(dot(n, key), 0.0);
    float specular = pow(max(dot(reflect(-key, n), view), 0.0), 55.0);
    float secondSpecular = pow(max(dot(reflect(-fill, n), view), 0.0), 28.0);
    // Broad reflected studio strips give the liquid surface readable curvature.
    float strip = pow(max(1.0 - abs(reflected.y - 0.48), 0.0), 24.0);
    color = base * (0.16 + diffuse * 0.64);
    color += iridescence * (0.12 + fresnel * 0.7);
    color += vec3(0.65, 0.85, 1.0) * specular * 1.5;
    color += vec3(1.0, 0.4, 0.7) * secondSpecular * 0.6;
    color += mix(base, vec3(0.9, 1.0, 1.0), 0.75) * strip * 0.75;
    color *= intensity;
  }
  color += spectrum(hue + 0.62) * min(glow, 0.6) * 0.22 * intensity;
  color *= 1.0 - 0.2 * smoothstep(0.3, 1.3, length(vUv - 0.5));
  color = color / (1.0 + color);
  gl_FragColor = vec4(pow(color, vec3(0.4545)), 1.0);
}`;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * A self-contained liquid sculpture, driven only by numeric parameter packets.
 * Channel parameters: energy (0..3), pitch (0..1), pan (-1..1), radius (multiplier, default 1).
 * Global parameters: merge (0.05..1.5), flow (speed, default 1), hue (turns),
 * intensity (0..3), spread (0.3..1.8). Time uses the application's absolute units.
 * This opaque fullscreen effect supplies its own background; it does not write the
 * shared camera or scene environment. Compose overlays after it using renderOrder.
 */
export class MetaballEffect<D> implements GraphicsEffect<D> {
  readonly parameters;
  private readonly channels: readonly MetaballChannel[];
  private scene?: THREE.Object3D;
  private camera?: THREE.PerspectiveCamera;
  private mesh?: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private uniforms?: {
    balls: THREE.IUniform<THREE.Vector4[]>;
    colors: THREE.IUniform<THREE.Color[]>;
    ballCount: THREE.IUniform<number>;
    aspect: THREE.IUniform<number>;
    time: THREE.IUniform<number>;
    merge: THREE.IUniform<number>;
    hue: THREE.IUniform<number>;
    intensity: THREE.IUniform<number>;
  };

  constructor(
    readonly id: string,
    channels: readonly MetaballChannel[],
  ) {
    if (channels.length < 1 || channels.length > 4)
      throw new Error('Metaballs require one to four channels');
    if (new Set(channels.map((channel) => channel.id)).size !== channels.length)
      throw new Error('Metaball channel IDs must be unique');
    this.channels = channels.map((channel) => ({ ...channel }));
    this.parameters = parameterCatalogue(metaballParameters(channels.map((channel) => channel.id)));
  }

  load(_engine: StructureEngine<D>, context: GraphicsContext) {
    this.dispose();
    this.scene = context.scene;
    this.camera = context.camera;
    this.uniforms = {
      balls: { value: Array.from({ length: MAX_BALLS }, () => new THREE.Vector4()) },
      colors: {
        value: Array.from(
          { length: MAX_BALLS },
          (_, i) => new THREE.Color(this.channels[Math.floor(i / 3) % this.channels.length].color),
        ),
      },
      ballCount: { value: this.channels.length * 3 },
      aspect: { value: 1 },
      time: { value: 0 },
      merge: { value: 0.55 },
      hue: { value: 0 },
      intensity: { value: 1 },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    this.scene.add(this.mesh);
  }

  render(frame: EngineFrame<D>, input: Readonly<Record<string, number>>) {
    if (!this.mesh || !this.uniforms || !this.camera) return;
    const parameters = resolveParameters(this.parameters, input);
    const time = frame.time * parameters['flow'];
    const spread = parameters['spread'];
    this.uniforms.aspect.value = Math.max(0.05, this.camera.aspect || 1);
    this.uniforms.time.value = time;
    this.uniforms.merge.value = parameters['merge'];
    this.uniforms.hue.value = parameters['hue'];
    this.uniforms.intensity.value = parameters['intensity'];
    for (let channelIndex = 0; channelIndex < this.channels.length; channelIndex++) {
      const channel = this.channels[channelIndex];
      const energy = parameters[`${channel.id}.energy`];
      const pitch = parameters[`${channel.id}.pitch`];
      const pan = parameters[`${channel.id}.pan`];
      const radius = parameters[`${channel.id}.radius`];
      const phase = (channelIndex / this.channels.length) * Math.PI * 2;
      for (let satellite = 0; satellite < 3; satellite++) {
        const index = channelIndex * 3 + satellite;
        const orbit = time * (0.31 + satellite * 0.11) + phase + satellite * 1.9;
        const x = (Math.cos(orbit) * (0.8 + satellite * 0.22) + pan * 0.45) * spread;
        const y = (Math.sin(orbit * 1.17 + phase) * 0.95 + (pitch - 0.5) * 1.05) * spread;
        const z = Math.sin(time * 0.43 + phase + satellite * 2.2) * (0.65 + satellite * 0.18);
        const size = (0.36 + energy * 0.13 + satellite * 0.035) * radius;
        this.uniforms.balls.value[index].set(x, y, z, size);
      }
    }
  }

  dispose() {
    if (this.mesh) {
      this.scene?.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
    this.mesh = undefined;
    this.uniforms = undefined;
    this.scene = undefined;
    this.camera = undefined;
  }
}
