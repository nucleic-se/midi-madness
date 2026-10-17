export type Vec3 = [number, number, number];
export type Mapping<T, R, D = unknown> = R | ((datum: T, context: RenderContext<D>) => R);
export interface RenderContext<D = unknown> {
  data: D;
  config: SceneConfig<D>;
  THREE: typeof import('three');
}
export interface Layer<T = any, D = any> {
  id: string;
  type: string;
  data: keyof D | ((data: D) => T[]);
  visible?: boolean;
  position?: Mapping<T, Vec3, D>;
  size?: Mapping<T, Vec3, D>;
  color?: Mapping<T, string, D>;
  opacity?: Mapping<T, number, D>;
  angle?: Mapping<T, number, D>;
  radius?: Mapping<T, number, D>;
  z?: Mapping<T, number, D>;
  origin?: Mapping<T, [number, number], D>;
  spokes?: boolean;
  [option: string]: unknown;
}
export interface SceneConfig<D = any> {
  layers: Layer<any, D>[];
  /** Optional scalar -> scene position. No musical units are assumed. */
  cursor?: { position: (value: number) => Vec3; width?: number; height?: number; centerY?: number };
}
export type LayerFactory = (input: {
  layer: Layer;
  data: any[];
  context: RenderContext<any>;
}) => import('three').Object3D;
export interface Selection {
  datum: unknown;
  layerId: string;
}
