import {
  Mesh,
  Line,
  Points,
  Sprite,
  Light,
  type Object3D,
  type BufferGeometry,
  type Material,
} from 'three';

/** Dispose resources owned by an effect tree once, including shared geometry.
 * Textures are disposed explicitly by their owner; borrowed material maps survive.
 */
export function disposeTree(root: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse((object) => {
    if (object instanceof Mesh || object instanceof Line || object instanceof Points) {
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        materials.add(material);
    } else if (object instanceof Sprite) materials.add(object.material);
    if (object instanceof Light && 'shadow' in object) {
      const light = object as Light & { shadow: { dispose(): void } };
      light.shadow.dispose();
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}
