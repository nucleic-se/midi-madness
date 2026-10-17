import { scoreLine } from '../../core/src/score-error.ts';
export type Tuning =
  | { kind: 'equal' }
  | { kind: 'table'; root: number; cents: number[] }
  | { kind: 'chord'; cents: number[] };
const mod = (n: number) => ((n % 12) + 12) % 12;
function pc(name: string) {
  const m = name.match(/^([A-G])([#b]?)$/);
  if (!m) throw new RangeError(`Expected tuning root pitch class, got ${name}`);
  return mod(
    ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as Record<string, number>)[m[1]] +
      (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0),
  );
}
export function extractTuning(source: string) {
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.replace(/\/\/.*$/, '');
    for (const m of line.matchAll(/([A-G][#b]?-?\d+|c[13579]|[1-7])([+-]\d+(?:\.\d+)?)ct\b/g)) {
      const before = line.slice(0, m.index).trimEnd().at(-1),
        after = line.slice(m.index! + m[0].length).trimStart()[0];
      if (before === '+' || after === '+')
        scoreLine(index + 1, () => {
          throw new RangeError(
            'Individual cents suffixes inside + chords are deferred; use tuning just chord, a tuning table, or separate note attacks',
          );
        });
    }
  }
  let tuning: Tuning = { kind: 'equal' },
    seen = false;
  const coreSource = source
    .split(/\r?\n/)
    .map((raw, sourceLineIndex) =>
      scoreLine(sourceLineIndex + 1, () => {
        const text = raw.replace(/\/\/.*$/, '').trim();
        if (!/^tuning\b/.test(text)) return raw;
        if (!/^\s{2}tuning\b/.test(raw)) throw new RangeError('Tuning belongs in the song header');
        if (seen) throw new RangeError('Declare tuning once');
        seen = true;
        if (text === 'tuning equal') return '';
        const just = text.match(/^tuning just(?: (7-limit))? (?:from ([A-G][#b]?)|(chord))$/);
        if (just) {
          const ratios = just[1]
            ? [1, 16 / 15, 9 / 8, 7 / 6, 5 / 4, 4 / 3, 7 / 5, 3 / 2, 8 / 5, 5 / 3, 7 / 4, 15 / 8]
            : [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5, 15 / 8];
          const cents = ratios.map((r, i) => 1200 * Math.log2(r) - i * 100);
          tuning = just[3] ? { kind: 'chord', cents } : { kind: 'table', root: pc(just[2]), cents };
          return '';
        }
        if (text.startsWith('tuning cents ')) {
          const tokens = text.slice(13).trim().split(/\s+/),
            cents = new Array<number>(12),
            used = new Set<number>();
          if (tokens.length !== 24)
            throw new RangeError('Tuning cents needs all 12 pitch classes and offsets');
          for (let i = 0; i < tokens.length; i += 2) {
            const pitch = pc(tokens[i]),
              amount = Number(tokens[i + 1].replace(/ct$/, ''));
            if (used.has(pitch) || !Number.isFinite(amount) || Math.abs(amount) > 2400)
              throw new RangeError('Invalid or repeated tuning table entry');
            used.add(pitch);
            cents[pitch] = amount;
          }
          tuning = { kind: 'table', root: 0, cents };
          return '';
        }
        throw new RangeError(`Unsupported tuning declaration: ${text}`);
      }),
    )
    .join('\n')
    .replace(
      /(?<![\w-])([A-G][#b]?-?\d+|c[13579]|[1-7])([+-]\d+(?:\.\d+)?)ct\b(?:\{([^}]*)\})?/g,
      (_, pitch, amount, locks) => `${pitch}{cents ${amount}${locks ? `, ${locks}` : ''}}`,
    )
    .replace(/(\bcents\s+)([-+]?\d+(?:\.\d+)?)ct\b/g, '$1$2');
  return { tuning, coreSource };
}
export function tuningCents(tuning: Tuning, pitch: number, chordRoot: number | null = null) {
  if (tuning.kind === 'equal') return 0;
  if (tuning.kind === 'chord' && chordRoot === null) return 0;
  const root = tuning.kind === 'chord' ? chordRoot! : tuning.root;
  return tuning.cents[mod(Math.round(pitch) - root)];
}
