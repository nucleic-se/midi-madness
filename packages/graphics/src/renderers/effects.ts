import type { StructureEngine, EngineFrame } from '../engine.js';
import type { Object3D, PerspectiveCamera } from 'three';
import {
  parameterValue,
  validateDescriptor,
  type ParameterDescriptor,
} from '@midi-madness/foundation/parameters';

export interface GraphicsContext {
  scene: Object3D;
  camera: PerspectiveCamera;
}
export interface GraphicsFrame<D = unknown> extends EngineFrame<D> {
  /** Explicit caller-selected visual phase; frame.time retains the data's coordinate. */
  animationTime?: number;
}

export function parameterCatalogue(
  descriptors: readonly ParameterDescriptor[],
): readonly ParameterDescriptor[] {
  const ids = new Set<string>();
  return Object.freeze(
    descriptors.map((descriptor) => {
      validateDescriptor(descriptor);
      if (ids.has(descriptor.id)) throw new Error(`Duplicate parameter ${descriptor.id}`);
      ids.add(descriptor.id);
      return Object.freeze({ ...descriptor });
    }),
  );
}
/** Resolve only declared parameters. Defaults and bounds come from the same catalogue. */
export function resolveParameters(
  catalogue: readonly ParameterDescriptor[],
  input: Readonly<Record<string, number>>,
) {
  const values = new Map(Object.entries(input));
  for (const key of values.keys())
    if (!catalogue.some((parameter) => parameter.id === key))
      throw new Error(`Unknown parameter ${key}`);
  return Object.fromEntries(
    catalogue.map((parameter) => [parameter.id, parameterValue(parameter, values)]),
  );
}

/** Graphics modules can share a scene and clock without depending on each other. */
export interface GraphicsEffect<D> {
  id: string;
  /** At most one composed effect may write the shared camera. */
  readonly ownsCamera?: boolean;
  /** At most one composed effect may write scene-wide state such as fog. */
  readonly ownsEnvironment?: boolean;
  readonly parameters: readonly ParameterDescriptor[];
  /** A world-space root, when the effect exposes one for host composition. */
  readonly object?: Object3D | undefined;
  load(engine: StructureEngine<D>, context: GraphicsContext): void;
  render(frame: GraphicsFrame<D>, parameters: Readonly<Record<string, number>>): void;
  dispose(): void;
}

/** Destination IDs match bindParameters' effect/parameter packet addresses. */
export function bindingDestinations<D>(
  effects: readonly GraphicsEffect<D>[],
): ParameterDescriptor[] {
  return effects.flatMap((effect) =>
    effect.parameters.map((parameter) => ({
      ...parameter,
      id: JSON.stringify([effect.id, parameter.id]),
      label: `${effect.id} / ${parameter.label}`,
    })),
  );
}
