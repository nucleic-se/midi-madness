import type { Mapping, RenderContext } from './types.js';
/** Small, composable mapping functions. */
export const linear = (
  [a, b]: [number, number],
  [c, d]: [number, number],
  { clamp = false } = {},
) => {
  if (a === b) throw new Error('Mapping domain must have a nonzero span');
  return (value: number) => {
    let t = (value - a) / (b - a);
    if (clamp) t = Math.max(0, Math.min(1, t));
    return c + t * (d - c);
  };
};
export const columns = (keys: string[], spacing = 4) => {
  const positions = new Map(keys.map((key, i) => [key, (i - (keys.length - 1) / 2) * spacing]));
  return (key: string) => {
    if (!positions.has(key)) throw new Error(`Unknown column: ${key}`);
    return positions.get(key)!;
  };
};
export const radial = (angle: number, radius: number) => [
  Math.cos(angle) * radius,
  Math.sin(angle) * radius,
];
export const resolve = <T, R, D>(
  mapping: Mapping<T, R, D>,
  datum: T,
  context: RenderContext<D>,
): R =>
  typeof mapping === 'function'
    ? (mapping as (datum: T, context: RenderContext<D>) => R)(datum, context)
    : mapping;
/** Evenly distribute categories around an axis, in radians. */
export const angles = (keys: string[], offset = 0) => {
  const positions = new Map(keys.map((key, i) => [key, offset + (i * Math.PI * 2) / keys.length]));
  return (key: string) => {
    if (!positions.has(key)) throw new Error(`Unknown angle category: ${key}`);
    return positions.get(key)!;
  };
};
/** Compose a cylindrical position mapping without trigonometry at call sites. */
export function cylindrical<T, D = any>({
  angle,
  radius,
  z,
  origin = [0, 0],
}: {
  angle: Mapping<T, number, D>;
  radius: Mapping<T, number, D>;
  z: Mapping<T, number, D>;
  origin?: [number, number];
}): (datum: T, context: RenderContext<D>) => [number, number, number] {
  return (datum, context) => {
    const [x, y] = radial(resolve(angle, datum, context), resolve(radius, datum, context));
    return [x + origin[0], y + origin[1], resolve(z, datum, context)];
  };
}
