import { disposeTree } from './resources.js';
import type { SceneConfig, LayerFactory, Selection, Vec3 } from '../types.js';
import type { StructureEngine, EngineFrame } from '../engine.js';
export type * from '../types.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { resolve, radial } from '../mappings.js';
export { linear, columns, angles, cylindrical, radial } from '../mappings.js';
export { THREE };

const factories = new Map<string, LayerFactory>();
/** Register a layer factory: ({ layer, data, context }) => THREE.Object3D. */
export function registerLayer(type: string, factory: LayerFactory) {
  if (typeof factory !== 'function') throw new TypeError('Layer factory must be a function');
  factories.set(type, factory);
}
registerLayer('blocks', ({ layer, data, context }) => {
  const group = new THREE.Group();
  if (!layer.position) throw new Error(`Layer ${layer.id} requires position`);
  if (!data.length) return group;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  for (const datum of data) {
    const material = new THREE.MeshStandardMaterial({
      color: resolve(layer.color ?? '#a4a5ff', datum, context),
      roughness: 0.4,
      metalness: 0.15,
      transparent: true,
      opacity: resolve(layer.opacity ?? 0.9, datum, context),
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.fromArray(resolve(layer.position!, datum, context));
    mesh.scale.fromArray(resolve(layer.size ?? [1, 1, 1], datum, context));
    mesh.userData = { datum, layerId: layer.id };
    group.add(mesh);
  }
  return group;
});
registerLayer('line', ({ layer, data, context }) => {
  const points = data.map((d) => new THREE.Vector3(...resolve(layer.position!, d, context)));
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  if (typeof layer.color === 'function') {
    const colors = data.flatMap((d) =>
      new THREE.Color(resolve(layer.color!, d, context)).toArray(),
    );
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  }
  return new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({
      color: typeof layer.color === 'function' ? '#ffffff' : (layer.color ?? '#ffffff'),
      vertexColors: typeof layer.color === 'function',
      transparent: true,
      opacity: typeof layer.opacity === 'number' ? layer.opacity : 1,
    }),
  );
});
registerLayer('radial', ({ layer, data, context }) => {
  const group = new THREE.Group();
  const points = data.map((d) => {
    const angle = resolve(layer.angle!, d, context);
    const radius = resolve(layer.radius!, d, context);
    const [x, y] = radial(angle, radius);
    const origin = resolve(layer.origin ?? [0, 0], d, context);
    return new THREE.Vector3(x + origin[0], y + origin[1], resolve(layer.z!, d, context));
  });
  group.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({
        color: data.length ? resolve(layer.color ?? '#88e2ce', data[0], context) : '#88e2ce',
      }),
    ),
  );
  if (layer.spokes) {
    const segments: THREE.Vector3[] = [];
    data.forEach((d, i) => {
      const origin = resolve(layer.origin ?? [0, 0], d, context);
      segments.push(new THREE.Vector3(origin[0], origin[1], points[i].z), points[i]);
    });
    group.add(
      new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(segments),
        new THREE.LineBasicMaterial({
          color: data.length ? resolve(layer.color ?? '#88e2ce', data[0], context) : '#88e2ce',
          transparent: true,
          opacity: 0.12,
        }),
      ),
    );
  }
  return group;
});

/** Build scene geometry without a canvas; useful for composition and testing. */
export function createLayers<D>(data: D, config: SceneConfig<D>) {
  const next = new THREE.Group();
  const context = { data, config, THREE };
  try {
    for (const layer of config.layers) {
      const factory = factories.get(layer.type);
      if (!factory) throw new Error(`Unknown layer type: ${layer.type}`);
      const items = typeof layer.data === 'function' ? layer.data(data) : (data[layer.data] ?? []);
      if (!Array.isArray(items)) throw new Error(`Layer ${layer.id} data must be an array`);
      const object = factory({ layer, data: items, context });
      object.name = layer.id ?? layer.type;
      object.visible = layer.visible !== false;
      next.add(object);
    }
  } catch (error) {
    disposeTree(next);
    throw error;
  }
  return next;
}

/** Configuration-driven scene; data schema is owned by the caller. */
export class StructureRenderer<D = any> {
  container: HTMLElement;
  onSelect: (selection: Selection | null) => void;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  root: THREE.Group;
  cursor: THREE.Group;
  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
  downPoint?: number[];
  down: (event: PointerEvent) => void;
  pick: (event: PointerEvent) => void;
  resize: ResizeObserver;
  config?: SceneConfig<D>;
  time = 0;
  constructor(
    container: HTMLElement,
    { background = '#0c1019', onSelect = (_selection: Selection | null) => {} } = {},
  ) {
    this.container = container;
    this.onSelect = onSelect;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight('#e0e5ff', '#434767', 3));
    const light = new THREE.DirectionalLight('#ffffff', 3);
    light.position.set(10, 20, 20);
    this.scene.add(light);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.cursor = new THREE.Group();
    this.scene.add(this.cursor);
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.down = (event) => {
      this.downPoint = [event.clientX, event.clientY];
    };
    this.pick = (event) => {
      if (
        !this.downPoint ||
        Math.hypot(event.clientX - this.downPoint[0], event.clientY - this.downPoint[1]) > 5
      )
        return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = this.raycaster.intersectObjects(this.root.children, true).find((h) => {
        if (!('datum' in h.object.userData)) return false;
        for (let object: THREE.Object3D | null = h.object; object; object = object.parent)
          if (!object.visible) return false;
        return true;
      });
      this.onSelect(
        hit
          ? { datum: hit.object.userData.datum, layerId: String(hit.object.userData.layerId) }
          : null,
      );
    };
    this.renderer.domElement.addEventListener('pointerdown', this.down);
    this.renderer.domElement.addEventListener('pointerup', this.pick);
    this.resize = new ResizeObserver(() => {
      const { width, height } = container.getBoundingClientRect();
      this.camera.aspect = width / Math.max(1, height);
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
    });
    this.resize.observe(container);
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }
  setData(data: D, config: SceneConfig<D>) {
    // Build transactionally so a failed custom layer leaves the current score intact.
    const next = createLayers(data, config);
    this.scene.remove(this.root);
    disposeTree(this.root);
    this.root = next;
    this.scene.add(next);
    this.config = config;
    disposeTree(this.cursor);
    this.cursor.clear();
    const { width = 24, height = 18, centerY = 5 } = config.cursor ?? {};
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({
        color: '#c5cbff',
        transparent: true,
        opacity: 0.045,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    plane.position.y = centerY;
    this.cursor.add(plane);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(plane.geometry),
      new THREE.LineBasicMaterial({ color: '#aebaff', transparent: true, opacity: 0.35 }),
    );
    edges.position.y = centerY;
    this.cursor.add(edges);
    this.cursor.visible = Boolean(config.cursor);
    this.setCursor(this.time);
  }
  /** Presentation mappings remain inspector-owned; the engine owns source data and time. */
  setEngine(engine: StructureEngine<D>, config: SceneConfig<D>) {
    this.setData(engine.data, config);
  }
  render(frame: EngineFrame<D>) {
    this.setCursor(frame.time);
  }
  setCursor(time: number) {
    this.time = time;
    if (this.config?.cursor) this.cursor.position.fromArray(this.config.cursor.position(time));
  }
  setLayerVisible(id: string, visible: boolean) {
    const layer = this.root.getObjectByName(id);
    if (layer) layer.visible = visible;
  }
  setCamera(position: Vec3, target: Vec3) {
    this.camera.position.fromArray(position);
    this.controls.target.fromArray(target);
    this.controls.update();
  }
  fit() {
    const box = new THREE.Box3().setFromObject(this.root);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const fov = (this.camera.fov * Math.PI) / 180;
    const limitingFov = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect));
    const distance = (size / (2 * Math.sin(limitingFov / 2))) * 1.15;
    const direction = new THREE.Vector3(0.85, 0.6, 1).normalize();
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.controls.target.copy(center);
    this.camera.far = Math.max(2000, distance * 10);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
  dispose() {
    this.renderer.setAnimationLoop(null);
    this.resize.disconnect();
    this.controls.dispose();
    this.renderer.domElement.removeEventListener('pointerdown', this.down);
    this.renderer.domElement.removeEventListener('pointerup', this.pick);
    disposeTree(this.root);
    disposeTree(this.cursor);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
