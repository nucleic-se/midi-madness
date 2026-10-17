import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import type { StructureEngine, EngineFrame, EngineRenderer } from '../engine.js';
import { bindParameters, type ParameterBinding } from '../bindings.js';
import { bindingDestinations, type GraphicsEffect } from './effects.js';

/** Per-frame look, computed by the caller from the performance (a pure function of time). */
export interface StageLook {
  /** Two-tone grade in scene-linear light: shadows and highlights pulled toward these colours. */
  shadows?: [number, number, number];
  highlights?: [number, number, number];
  /** 0..1 strength of the two-tone grade. */
  tone?: number;
  /** Exposure offset in stops (for example a brief lift on a hit). */
  lift?: number;
  /** RGB separation in pixels (for example an accent on a hit). */
  split?: number;
}
export interface StageOptions {
  /** Bloom strength, radius and luminance threshold (scene-referred, before tone mapping). */
  bloom?: { strength?: number; radius?: number; threshold?: number };
  exposure?: number;
  /** Film grain and vignette amounts, 0..1 (applied in display space, after tone mapping). */
  grain?: number;
  vignette?: number;
  pixelRatio?: number;
  /** A neon studio environment for reflections on physically based materials. */
  environment?: { strips?: string[]; intensity?: number } | false;
  /** Soft shadows for lights that enable castShadow. */
  shadows?: boolean;
  /** Called every frame with media time; returns the musical look for that frame. */
  look?: (time: number) => StageLook;
}

const fullscreen = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
/** Scene-linear grade before tone mapping: exposure lift, RGB separation, two-tone tint. */
const grade = {
  uniforms: {
    tDiffuse: { value: null },
    lift: { value: 0 },
    split: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
    shadows: { value: new THREE.Color(0, 0, 0) },
    highlights: { value: new THREE.Color(1, 1, 1) },
    tone: { value: 0 },
  },
  vertexShader: fullscreen,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float lift;
uniform float split;
uniform vec2 resolution;
uniform vec3 shadows;
uniform vec3 highlights;
uniform float tone;
varying vec2 vUv;
void main() {
  vec2 centred = vUv - 0.5;
  vec2 offset = normalize(centred + 1e-5) * split / resolution * (0.4 + length(centred));
  vec3 hdr = vec3(texture2D(tDiffuse, vUv + offset).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - offset).b);
  hdr *= exp2(lift);
  float luma = dot(hdr, vec3(0.2126, 0.7152, 0.0722));
  float t = smoothstep(0.0, 1.0, log2(1.0 + luma * 4.0) / 3.0);
  vec3 ink = mix(shadows, highlights, t);
  // Luminance-preserving tint; black stays black.
  vec3 tinted = ink * luma / max(dot(ink, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
  gl_FragColor = vec4(mix(hdr, tinted, tone), 1.0);
}`,
};
/** Display-space finish after tone mapping: vignette and grain seeded by media time. */
const finish = {
  uniforms: {
    tDiffuse: { value: null },
    grain: { value: 0.03 },
    vignette: { value: 0.35 },
    seed: { value: 0 },
  },
  vertexShader: fullscreen,
  fragmentShader: /* glsl */ `
uniform sampler2D tDiffuse;
uniform float grain;
uniform float vignette;
uniform float seed;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }
void main() {
  vec3 color = texture2D(tDiffuse, vUv).rgb;
  color *= 1.0 - vignette * smoothstep(0.3, 0.85, length(vUv - 0.5));
  color += (hash(vUv * 1000.0) - 0.5) * grain;
  gl_FragColor = vec4(color, 1.0);
}`,
};

/** A cinematic stage for composed effects: physically based lights, HDR, bloom, a musical
 * grade, ACES output, film finish and SMAA. Same effect and binding contracts as
 * GraphicsRenderer; scheduling and musical interpretation live elsewhere.
 */
export class PerformanceStage<D> implements EngineRenderer<D> {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 800);
  readonly renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private gradePass: ShaderPass;
  private finishPass: ShaderPass;
  private resize: ResizeObserver;
  constructor(
    container: HTMLElement,
    private effects: GraphicsEffect<D>[],
    private bindings: ParameterBinding<D>[] = [],
    private options: StageOptions = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(options.pixelRatio ?? Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = options.exposure ?? 1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor('#000000');
    if (options.shadows !== false) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    container.append(this.renderer.domElement);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = options.bloom ?? {};
    this.composer.addPass(
      new UnrealBloomPass(
        new THREE.Vector2(256, 256),
        bloom.strength ?? 0.8,
        bloom.radius ?? 0.5,
        bloom.threshold ?? 1,
      ),
    );
    this.gradePass = new ShaderPass(grade);
    this.composer.addPass(this.gradePass);
    this.composer.addPass(new OutputPass());
    this.finishPass = new ShaderPass(finish);
    this.finishPass.uniforms.grain.value = options.grain ?? 0.03;
    this.finishPass.uniforms.vignette.value = options.vignette ?? 0.4;
    this.composer.addPass(this.finishPass);
    this.composer.addPass(new SMAAPass());
    if (options.environment !== false) {
      this.scene.environment = this.studio(options.environment ?? {});
      this.scene.environmentIntensity = 1;
    }
    this.resize = new ResizeObserver(() => {
      const { width, height } = container.getBoundingClientRect();
      this.camera.aspect = width / Math.max(1, height);
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
      this.composer.setSize(width, height);
      const ratio = this.renderer.getPixelRatio();
      this.gradePass.uniforms.resolution.value.set(width * ratio, height * ratio);
    });
    this.resize.observe(container);
  }
  /** Prefiltered environment: a dark dome with tall neon strips around it, for clearcoat and
   * metal reflections. Static: it shapes highlights, it does not animate. */
  private studio(options: { strips?: string[]; intensity?: number }) {
    const room = new THREE.Scene();
    room.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(50, 32, 16),
        new THREE.MeshBasicMaterial({ color: '#000002', side: THREE.BackSide }),
      ),
    );
    const strips = options.strips ?? [
      '#6a3cff',
      '#1fb6ff',
      '#ff3fb0',
      '#8a5cff',
      '#2fe0ff',
      '#c04cff',
    ];
    const intensity = options.intensity ?? 4;
    strips.forEach((color, i) => {
      const angle = (i / strips.length) * Math.PI * 2;
      const strip = new THREE.Mesh(
        new THREE.PlaneGeometry(0.5, 30),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(color).multiplyScalar(intensity),
          side: THREE.DoubleSide,
        }),
      );
      strip.position.set(Math.sin(angle) * 30, 8, -Math.cos(angle) * 30);
      strip.lookAt(0, 8, 0);
      room.add(strip);
    });
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const texture = pmrem.fromScene(room, 0.02).texture;
    pmrem.dispose();
    return texture;
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
    const look = this.options.look?.(frame.time) ?? {},
      u = this.gradePass.uniforms;
    u.lift.value = look.lift ?? 0;
    u.split.value = look.split ?? 0;
    u.tone.value = look.tone ?? 0;
    if (look.shadows) u.shadows.value.setRGB(...look.shadows);
    if (look.highlights) u.highlights.value.setRGB(...look.highlights);
    this.finishPass.uniforms.seed.value = (frame.time * 60) % 997;
    this.composer.render();
  }
  dispose() {
    this.resize.disconnect();
    for (const effect of this.effects) effect.dispose();
    this.composer.dispose?.();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
