/** Lower only shape endpoints, leaving durations, shape types and operators intact. */
export function mapShapeEndpoints(
  text: string,
  lower: (literal: string) => string,
): string | undefined {
  // A bare shape (`random a..b every 1/8`, `ramp a..b`) has a one-bar period and needs the same mapping.
  if (!/\bacross\b/.test(text) && !/^\s*(?:ramp|sine|triangle|saw|square|random)\s/.test(text))
    return undefined;
  const scalar = String.raw`(?:[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\/\d+(?:\.|t)?)?(?:kHz|Hz|ms|s|oct|dB|%)?|[A-G][#b]?-?\d+)`;
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

/** Map software-native values without touching section selectors or smoothing time. */
export function mapSectionValues(
  text: string,
  lower: (value: string) => string,
): string | undefined {
  const match = text.trim().match(/^by\s+section\s*:\s*(.*)$/);
  if (!match) return undefined;
  const entries: string[] = [];
  let depth = 0,
    start = 0,
    end = match[1].length,
    suffix = '';
  for (let i = 0; i < match[1].length; i++) {
    const c = match[1][i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (
      !depth &&
      /^(?:\*|[A-Za-z][\w-]*)\s+.+$/.test(match[1].slice(start, i).trim()) &&
      /^\s+smooth\s+/.test(match[1].slice(i))
    ) {
      end = i;
      suffix = match[1].slice(i);
      break;
    }
    if (!depth && c === ',') {
      entries.push(match[1].slice(start, i));
      start = i + 1;
    }
  }
  entries.push(match[1].slice(start, end));
  return `by section: ${entries
    .map((entry) => {
      const value = entry.trim().match(/^(\*|[A-Za-z][\w-]*)\s+(.+)$/);
      if (!value) throw new RangeError('Expected a section selector and value');
      return `${value[1]} ${lower(value[2])}`;
    })
    .join(', ')}${suffix}`;
}
