import * as THREE from 'three';

const vertex = /* glsl */ `
attribute float alpha;
varying float vAlpha;
varying float vEdge;
attribute float edge;
void main() {
  vAlpha = alpha;
  vEdge = edge;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const fragment = /* glsl */ `
uniform vec3 color;
uniform float gain;
varying float vAlpha;
varying float vEdge;
void main() {
  float core = 1.0 - abs(vEdge);
  gl_FragColor = vec4(color * gain * vAlpha * (core * core * 1.4 + 0.15), 1.0);
}`;

/** A camera-facing additive ribbon through a polyline; width and alpha per point. */
export class RibbonMesh {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private position: THREE.BufferAttribute;
  private alpha: THREE.BufferAttribute;
  private side = new THREE.Vector3();
  private tangent = new THREE.Vector3();
  private toCamera = new THREE.Vector3();
  constructor(
    private capacity: number,
    color: string,
  ) {
    const geometry = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(new Float32Array(capacity * 2 * 3), 3);
    this.alpha = new THREE.BufferAttribute(new Float32Array(capacity * 2), 1);
    const edge = new Float32Array(capacity * 2);
    for (let i = 0; i < capacity; i++) {
      edge[i * 2] = -1;
      edge[i * 2 + 1] = 1;
    }
    const index: number[] = [];
    for (let i = 0; i < capacity - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(index);
    geometry.setAttribute('position', this.position);
    geometry.setAttribute('alpha', this.alpha);
    geometry.setAttribute('edge', new THREE.BufferAttribute(edge, 1));
    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({
        vertexShader: vertex,
        fragmentShader: fragment,
        uniforms: { color: { value: new THREE.Color(color) }, gain: { value: 1 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    this.mesh.frustumCulled = false;
  }
  /** Points (world), half-widths and alphas; the ribbon faces `eye`. */
  update(
    points: readonly (readonly [number, number, number])[],
    widths: readonly number[],
    alphas: readonly number[],
    eye: THREE.Vector3,
  ) {
    const n = Math.min(points.length, this.capacity);
    for (let i = 0; i < n; i++) {
      const p = points[i],
        prev = points[Math.max(0, i - 1)],
        next = points[Math.min(n - 1, i + 1)];
      this.tangent.set(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]);
      this.toCamera.set(eye.x - p[0], eye.y - p[1], eye.z - p[2]);
      this.side.crossVectors(this.tangent, this.toCamera);
      if (this.side.lengthSq() < 1e-12) this.side.set(0, 1, 0);
      this.side.normalize().multiplyScalar(widths[i]);
      this.position.setXYZ(i * 2, p[0] - this.side.x, p[1] - this.side.y, p[2] - this.side.z);
      this.position.setXYZ(i * 2 + 1, p[0] + this.side.x, p[1] + this.side.y, p[2] + this.side.z);
      this.alpha.setX(i * 2, alphas[i]);
      this.alpha.setX(i * 2 + 1, alphas[i]);
    }
    this.mesh.geometry.setDrawRange(0, Math.max(0, n - 1) * 6);
    this.position.needsUpdate = this.alpha.needsUpdate = true;
  }
  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
