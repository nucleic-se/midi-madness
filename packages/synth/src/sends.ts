export type StereoInput = { left: Float32Array; right: Float32Array };
export type Send = {
  name: string;
  input: StereoInput;
  level: number;
  baseline: number;
  pre: boolean;
};
export type Throw = { route: Send; gain: number };
export function createSends(
  inputs: Record<string, StereoInput> | undefined,
  defaults: Record<string, number>,
): Send[] {
  return Object.entries(inputs ?? {}).map(([name, input]) => ({
    name,
    input,
    level: defaults[name] ?? 0,
    baseline: defaults[name] ?? 0,
    pre: false,
  }));
}
export function setSend(routes: Send[], key: string, value: number | null): boolean {
  const m = key.match(/^send\.([\w-]+)(\.pre)?$/);
  if (!m) return false;
  const route = routes.find((r) => r.name === m[1]);
  if (!route) return false;
  if (m[2]) route.pre = value !== null && value >= 0.5;
  else route.level = value === null ? route.baseline : Math.max(0, Math.min(1, value)) ** 2;
  return true;
}
export function noteThrows(routes: Send[], values: Record<string, number> | undefined): Throw[] {
  return Object.entries(values ?? {})
    .map(([bus, v]) => ({
      route: routes.find((r) => r.name === bus)!,
      gain: Math.max(0, Math.min(1, v)) ** 2,
    }))
    .filter((t) => t.route);
}
export function throwAudio(
  throws: Throw[],
  sample: number,
  left: number,
  right: number,
  fader: number,
) {
  for (const t of throws) {
    const gain = t.gain * (t.route.pre ? 1 : fader);
    t.route.input.left[sample] += left * gain;
    t.route.input.right[sample] += right * gain;
  }
}
export function sendAudio(
  routes: Send[],
  sample: number,
  preLeft: number,
  preRight: number,
  left: number,
  right: number,
) {
  for (const r of routes)
    if (r.level) {
      r.input.left[sample] += (r.pre ? preLeft : left) * r.level;
      r.input.right[sample] += (r.pre ? preRight : right) * r.level;
    }
}
