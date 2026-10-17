import type { ParameterDescriptor } from '@midi-madness/foundation/parameters';

const parameter = (
  id: string,
  unit: string,
  min: number,
  max: number,
  defaultValue: number,
): ParameterDescriptor => ({ id, label: id, unit, min, max, defaultValue });
const channels = (ids: readonly string[], energyMax = 1) =>
  ids.flatMap((id) => [
    parameter(`${id}.energy`, 'normalized', 0, energyMax, 0),
    parameter(`${id}.pitch`, 'normalized', 0, 1, 0.5),
    parameter(`${id}.pan`, 'bipolar', -1, 1, 0),
  ]);
export const resonatorParameters = (ids: readonly string[]) => [
  ...channels(ids, 3),
  parameter('spread', 'ratio', 0, 3, 1),
  parameter('flow', 'ratio', 0, 4, 1),
  parameter('pulse', 'normalized', 0, 3, 0),
  parameter('intensity', 'linear-gain', 0, 4, 1),
  parameter('hue', 'turns', -100, 100, 0),
];
export const ribbonParameters = (ids: readonly string[]) => [
  ...channels(ids),
  parameter('spread', 'ratio', 0, 3, 1),
  parameter('flow', 'ratio', 0, 4, 1),
  parameter('twist', 'ratio', -3, 3, 1),
  parameter('intensity', 'linear-gain', 0, 3, 1),
  parameter('hue', 'turns', -2, 2, 0),
];
export const plasmaParameters = () => [
  parameter('pulse', 'normalized', 0, 1, 0),
  parameter('hitAge', 'seconds', 0, 8, 8),
  parameter('intensity', 'linear-gain', 0, 4, 1),
  parameter('radius', 'stage-units', 0.2, 3, 1),
  parameter('spin', 'ratio', -4, 4, 0.5),
  parameter('hue', 'turns', -100, 100, 0),
];

/** Headless catalogue shared by persisted authoring and the Three composition. */
export const monumentParameters = (ids: readonly string[]) => [
  ...resonatorParameters(ids).map((parameter) => ({
    ...parameter,
    id: `foundation.${parameter.id}`,
    label: `foundation / ${parameter.label}`,
  })),
  ...ribbonParameters(ids).map((parameter) => ({
    ...parameter,
    id: `crown.${parameter.id}`,
    label: `crown / ${parameter.label}`,
  })),
  ...plasmaParameters().map((parameter) => ({
    ...parameter,
    id: `heart.${parameter.id}`,
    label: `heart / ${parameter.label}`,
  })),
];

export const metaballParameters = (ids: readonly string[]) => [
  ...channels(ids, 3),
  ...ids.map((id) => parameter(`${id}.radius`, 'ratio', 0.15, 2, 1)),
  parameter('merge', 'ratio', 0.05, 1.5, 0.55),
  parameter('flow', 'ratio', -4, 4, 1),
  parameter('hue', 'turns', -100, 100, 0),
  parameter('intensity', 'linear-gain', 0, 3, 1),
  parameter('spread', 'ratio', 0.3, 1.8, 1),
];
export const tunnelParameters = () => [
  parameter('modulation', 'normalized', 0, 1, 0.5),
  parameter('energy', 'normalized', 0, 3, 0),
  parameter('twist', 'radians-per-unit', -4, 4, 0.12),
];
