import { Rational } from '@midi-madness/foundation/time';
import { scoreLine } from '../../core/src/score-error.ts';
import { mapShapeEndpoints, mapSectionValues } from './automation-literals.ts';
import { noteSeconds } from './score-settings.ts';
const timeField = /^(?:(?:filter|modenv)\.)?(?:attack|decay|release)$/;

/** Unitless fractions are existing arithmetic. Only explicit note(...) is a duration. */
export function envelopeTimeLiteral(
  field: string,
  text: string,
  bpm: number,
  allowNoteDuration = true,
): string {
  const sections = mapSectionValues(text, (value) =>
    envelopeTimeLiteral(field, value, bpm, allowNoteDuration),
  );
  if (sections !== undefined) return sections;
  const value = allowNoteDuration
    ? text
        .trim()
        .replace(/\bnote\(\s*(\d+\/\d+(?:\.|t)?)\s*\)/g, (_, note) => `${noteSeconds(note, bpm)}s`)
    : text.trim();
  if (value.includes('->')) {
    // Native-second modenv paths already belong to the core path parser.
    if (field.startsWith('modenv.')) return value;
    const path = value.match(/^(.*?)\s*->\s*(.+?)\s+(over\s+.+)$/);
    if (!path) return value;
    const from = path[1].trim();
    return `${from ? envelopeTimeLiteral(field, from, bpm, allowNoteDuration) + ' ' : ''}-> ${envelopeTimeLiteral(field, path[2], bpm, allowNoteDuration)} ${path[3]}`;
  }
  const per = value.match(/^(per\s+[^:]+:)\s*(.+)$/);
  if (per)
    return `${per[1]} ${per[2]
      .split(',')
      .map((v) => envelopeTimeLiteral(field, v, bpm, allowNoteDuration))
      .join(', ')}`;
  const shape = mapShapeEndpoints(value, (literal) =>
    envelopeTimeLiteral(field, literal, bpm, allowNoteDuration),
  );
  if (shape !== undefined) return shape;
  const scalar = value.match(/^([-+]?(?:\d+(?:\.\d+)?|\.\d+))\s*([A-Za-z]+)$/);
  if (!scalar) {
    if ((allowNoteDuration && /\bnote\s*\(/.test(value)) || /\d(?:ms|s)\b/.test(value))
      throw new RangeError(
        `${field}: native times must be literals, shape endpoints or per values; use note(1/8) for note durations`,
      );
    return value;
  }
  if (!['ms', 's'].includes(scalar[2]))
    throw new RangeError(`${field} expects ms, s or note(1/8), got ${text}`);
  const seconds = Number(scalar[1]) * (scalar[2] === 'ms' ? 0.001 : 1);
  const native = field.startsWith('modenv.');
  const maximum = native ? 10 : 5.001;
  if (!Number.isFinite(seconds) || seconds < 0.001 - 1e-12 || seconds > maximum + 1e-12)
    throw new RangeError(`${field} time must be 1ms..${maximum}s, got ${text}`);
  const bounded = Math.max(0.001, Math.min(maximum, seconds));
  return String(native ? bounded : Math.cbrt((bounded - 0.001) / 5));
}

export function lowerEnvelopeTimes(source: string, bpm: number): string {
  // An authored value function keeps precedence over the added convenience spelling.
  const allowNoteDuration = !/^define\s+note\s*\(/m.test(source);
  // The legacy software extractor has a separate tempo fallback. New note times
  // follow the actual core song tempo, including its default and rational values.
  if (/\bnote\s*\(/.test(source)) {
    let inSong = false;
    let declaredSong = false;
    let tempo = 100;
    for (const raw of source.split(/\r?\n/)) {
      const line = raw.replace(/\/\/.*$/, '');
      if (!line.trim()) continue;
      if (!/^\s/.test(line)) {
        inSong = /^song\s/.test(line);
        declaredSong ||= inSong;
      } else if (inSong) {
        const value = line.trim().match(/^tempo\s+(\S+)/)?.[1];
        if (value) {
          try {
            tempo = Rational.parse(value).toNumber();
          } catch {
            /* The core compiler diagnoses an invalid song tempo. */
          }
        }
      }
    }
    if (declaredSong && Number.isFinite(tempo) && tempo > 0) bpm = tempo;
  }
  return source
    .split(/\r?\n/)
    .map((raw, index) =>
      scoreLine(index + 1, () => {
        // Comments are not executable literals, and line counts stay unchanged.
        const comment = raw.indexOf('//');
        let text = comment < 0 ? raw : raw.slice(0, comment);
        const assignment = text.match(/^(\s+)([\w.]+)\s*=\s*(.+?)\s*$/);
        if (assignment && timeField.test(assignment[2]))
          text = `${assignment[1]}${assignment[2]} = ${envelopeTimeLiteral(assignment[2], assignment[3], bpm, allowNoteDuration)}`;
        text = text.replace(
          /\{([^{}]*)\}/g,
          (_, body: string) =>
            `{${body
              .split(',')
              .map((entry) => {
                const lock = entry.match(/^(\s*)([\w.]+)\s+(.+?)\s*$/);
                return lock && timeField.test(lock[2])
                  ? `${lock[1]}${lock[2]} ${envelopeTimeLiteral(lock[2], lock[3], bpm, allowNoteDuration)}`
                  : entry;
              })
              .join(',')}}`,
        );
        return text + (comment < 0 ? '' : raw.slice(comment));
      }),
    )
    .join('\n');
}
