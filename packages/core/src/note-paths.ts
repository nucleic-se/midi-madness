import type { Rational } from '@midi-madness/foundation/time';
export type NotePath = {
  name: string;
  from?: number;
  to: number;
  duration: Rational;
  curve: 'linear' | 'exp' | 'log';
  absolutePitch?: boolean;
};
/** Convert native path endpoints in the destination's units, not always cents. */
export function pathEndpoint(name: string, text: string): number {
  const m = text.replace(/\s+/g, '').match(/^([+-]?\d+(?:\.\d+)?)(ct|st|oct|ms|s|Hz|kHz|%)?$/);
  if (!m) throw new RangeError('Note path endpoint must be a number or an absolute pitch');
  const value = Number(m[1]),
    unit = m[2];
  if (!Number.isFinite(value)) throw new RangeError('Note path endpoints must be finite');
  if (!unit) return value;
  if (unit === '%') return value / 100;
  const octaves =
    ['lfo.cutoff', 'lfo2.cutoff', 'modenv.cutoff', 'filter.fm'].includes(name) ||
    /^(lfo|lfo2|modenv)\.(sync\.ratio|filter\.fm)$/.test(name);
  const semitones = [
    'osc2.semitone',
    'drum.pitch.depth',
    'drum.lfo.pitch',
    'formant.shift',
  ].includes(name);
  const cents = [
    'pitch',
    'cents',
    'lfo.pitch',
    'lfo2.pitch',
    'modenv.pitch',
    'lfo.detune',
    'osc1.fine',
    'osc2.fine',
    'unison.spread',
  ].includes(name);
  if (['ct', 'st', 'oct'].includes(unit) && (octaves || semitones || cents)) {
    const inCents = value * (unit === 'oct' ? 1200 : unit === 'st' ? 100 : 1);
    return inCents / (octaves ? 1200 : semitones ? 100 : 1);
  }
  if (
    ['ms', 's'].includes(unit) &&
    [
      'modenv.attack',
      'modenv.decay',
      'modenv.release',
      'lfo.delay',
      'lfo.fade',
      'lfo.slew',
      'comb.time',
    ].includes(name)
  )
    return value * (unit === 'ms' ? 0.001 : 1);
  if (
    ['Hz', 'kHz'].includes(unit) &&
    ['lfo.hz', 'lfo2.hz', 'drum.lfo.hz', 'ring.hz', 'comb.hz'].includes(name)
  )
    return value * (unit === 'kHz' ? 1000 : 1);
  throw new RangeError(`Wrong unit for ${name} path: ${text}`);
}
