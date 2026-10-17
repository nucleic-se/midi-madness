/** Lower only shape endpoints, leaving durations, shape types and operators intact. */
export function mapShapeEndpoints(
  text: string,
  lower: (literal: string) => string,
): string | undefined {
  if (!/\bacross\b/.test(text)) return undefined;
  const scalar = String.raw`(?:[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\/\d+(?:\.|t)?)?(?:kHz|Hz|ms|s|oct|%)?|[A-G][#b]?-?\d+)`;
  const shape = new RegExp(
    String.raw`\b(ramp|sine|triangle|saw|square|random|exp|log|hold)(\s+)(${scalar})(?:\s*\.\.\s*(${scalar}))?(?=\s|[),\]]|$)`,
    'g',
  );
  let found = false;
  const result = text.replace(shape, (_, name, space, from, to) => {
    found = true;
    return `${name}${space}${lower(from)}${to === undefined ? '' : `..${lower(to)}`}`;
  });
  return found ? result : undefined;
}
