/** Routing depths use native target units; sync ratio depth uses octaves. */
export const routedTargets = {
  'fm.index': 20,
  fold: 1,
  'sync.ratio': 4,
  pw: 0.48,
  'filter.fm': 4,
};
export const routingNames = Object.fromEntries(
  Object.keys(routedTargets).map((target) => [
    target,
    ['lfo', 'lfo2', 'modenv'].map((source) => `${source}.${target}`),
  ]),
) as Record<keyof typeof routedTargets, [string, string, string]>;
