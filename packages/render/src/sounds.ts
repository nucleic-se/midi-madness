import { lowerEnvelopeTimes } from './envelope-times.ts';
import { scoreLine } from '../../core/src/score-error.ts';
import { routedTargets, routingNames } from '../../synth/src/modulation.ts';
import { preset, type Preset } from '../../synth/src/presets.ts';
export const soundDomains: Record<string, readonly [number, number]> = {
  'pluck.damping': [0, 1],
  'pluck.brightness': [0, 1],
  'pluck.decay': [0, 1],
  'pluck.pick': [0, 1],
  vowel: [0, 1],
  'formant.vowel': [0, 1],
  'formant.shift': [-12, 12],
  'formant.resonance': [0, 1],
  'lfo.vowel': [0, 1],
  'osc1.level': [0, 1],
  'osc2.level': [0, 1],
  'osc1.wave': [0, 1],
  'osc2.wave': [0, 1],
  'osc1.fine': [-100, 100],
  'osc2.fine': [-100, 100],
  'osc2.semitone': [-48, 48],
  pw: [0.02, 0.98],
  'fm.index': [0, 20],
  'fm.ratio': [0.01, 32],
  sync: [0, 1],
  'sync.ratio': [1, 16],
  fold: [0, 1],
  'filter.type': [0, 6],
  keytrack: [0, 2],
  'filter.fm': [0, 4],
  'unison.spread': [0, 100],
  'unison.width': [0, 1],
  'lfo.ratio': [0, 32],
  'lfo.trigger': [0, 1],
  'lfo.phase': [0, 1],
  'lfo.delay': [0, 10],
  'lfo.fade': [0, 10],
  'lfo.slew': [0, 1],
  velSens: [0, 1],
  'lfo2.hz': [0.01, 5000],
  'lfo2.ratio': [0, 32],
  'lfo2.shape': [0, 1],
  'lfo2.phase': [0, 1],
  'lfo2.trigger': [0, 1],
  'lfo2.pitch': [-2400, 2400],
  'lfo2.cutoff': [-4, 4],
  'lfo2.amp': [-1, 1],
  'lfo2.pan': [-1, 1],
  'lfo2.rateMod': [-4, 4],
  'lfo2.depthMod': [-1, 1],
  'drum.pitch': [0, 127],
  'drum.pitch.depth': [-48, 48],
  'drum.pitch.decay': [0.001, 2],
  'drum.lfo.hz': [0.01, 5000],
  'drum.lfo.pitch': [-24, 24],
  'drum.lfo.tone': [0, 1],
  'drum.lfo.amp': [0, 1],
  'lfo.resonance': [-1, 1],
  'lfo.pw': [-0.48, 0.48],
  'lfo.wave': [-1, 1],
  'lfo.detune': [-100, 100],
  'modenv.attack': [0.001, 10],
  'modenv.decay': [0.001, 10],
  'modenv.sustain': [0, 1],
  'modenv.release': [0.001, 10],
  'modenv.pitch': [-2400, 2400],
  'modenv.cutoff': [-4, 4],
  'modenv.lfo': [-1, 1],
  'modenv.curve': [0.25, 4],
};
for (const [target, depth] of Object.entries(routedTargets))
  for (const source of ['lfo', 'lfo2', 'modenv'])
    soundDomains[`${source}.${target}`] = [-depth, depth];
const lockUnits: Record<string, string> = {
  'drum.pitch.decay': 's',
  'modenv.attack': 's',
  'modenv.decay': 's',
  'modenv.release': 's',
  'lfo.delay': 's',
  'lfo.fade': 's',
  'lfo.slew': 's',
  'lfo.hz': 'Hz',
  'lfo2.hz': 'Hz',
  'drum.lfo.hz': 'Hz',
  'lfo.pitch': 'ct',
  'lfo2.pitch': 'ct',
  'modenv.pitch': 'ct',
  'osc1.fine': 'ct',
  'osc2.fine': 'ct',
  'unison.spread': 'ct',
  'lfo.detune': 'ct',
  cents: 'ct',
  'osc2.semitone': 'st',
  'drum.pitch.depth': 'st',
  'drum.lfo.pitch': 'st',
  'lfo.cutoff': 'oct',
  'lfo2.cutoff': 'oct',
  'modenv.cutoff': 'oct',
  'filter.fm': 'oct',
};
for (const target of ['sync.ratio', 'filter.fm'] as const)
  for (const name of routingNames[target]) lockUnits[name] = 'oct';
function lowerLockUnits(source: string) {
  return source.replace(/\{([^{}]*)\}/g, (block, body: string, offset: number) =>
    scoreLine(
      source.slice(0, offset).split(/\r?\n/).length,
      () =>
        `{${body
          .split(',')
          .map((item) => {
            const m = item.match(
              /^(\s*)([\w.]+)\s+([-+]?\d+(?:\.\d+)?)(ms|s|Hz|kHz|ct|st|oct)\s*$/,
            );
            if (!m || !lockUnits[m[2]]) return item;
            const wanted = lockUnits[m[2]],
              unit = m[4];
            if (
              unit !== wanted &&
              !(wanted === 's' && unit === 'ms') &&
              !(wanted === 'Hz' && unit === 'kHz')
            )
              throw new RangeError(`Wrong unit for ${m[2]} lock: ${m[3]}${unit}`);
            const n = Number(m[3]) * (unit === 'ms' ? 0.001 : unit === 'kHz' ? 1000 : 1);
            const domain = soundDomains[m[2]];
            if (domain && (n < domain[0] || n > domain[1]))
              throw new RangeError(`${m[2]} lock must be ${domain[0]}..${domain[1]}`);
            return `${m[1]}${m[2]} ${n}`;
          })
          .join(',')}}`,
    ),
  );
}
export function extractSounds(source: string, bpm = 120) {
  source = lowerLockUnits(lowerEnvelopeTimes(source, bpm));
  const sounds: Record<string, string> = {};
  const overrides: Record<string, Partial<Preset>> = {};
  let part: string | undefined;
  const coreSource = source
    .split(/\r?\n/)
    .map((raw, sourceLineIndex) =>
      scoreLine(sourceLineIndex + 1, () => {
        const line = raw.replace(/\/\/.*$/, ''),
          text = line.trim();
        if (text && !/^\s/.test(line)) part = text.match(/^part ([\w-]+)$/)?.[1];
        const selection = line.match(/^(\s+)sound\s+([\w-]+)\s*$/);
        if (selection) {
          if (!part || selection[1].length !== 2)
            throw new RangeError(
              'Sound selection belongs directly under a part; changing sounds in when blocks is deferred',
            );
          if (sounds[part]) throw new RangeError(`Duplicate sound selection for ${part}`);
          preset(selection[2]);
          sounds[part] = selection[2];
          return '';
        }
        const config = line.match(/^(\s+)(mono|voices|unison)\s+(?:=\s*)?(.+?)\s*$/);
        if (config) {
          if (!part || config[1].length !== 2)
            throw new RangeError(
              'Declare mono/voices/unison directly under a part; runtime changes are not supported',
            );
          const o = (overrides[part] ??= {});
          const field = config[2],
            value = config[3];
          if (field === 'mono') {
            if (!['on', 'off', 'true', 'false', '1', '0'].includes(value))
              throw new RangeError('Mono must be on or off');
            o.mono = ['on', 'true', '1'].includes(value);
          } else if (field === 'voices' && value === 'mono') o.mono = true;
          else {
            const n = Number(value.replace(/^poly\s+/, ''));
            const max = field === 'unison' ? 8 : 32;
            if (!Number.isInteger(n) || n < 1 || n > max)
              throw new RangeError(`${field} must be an integer 1..${max}`);
            if (field === 'unison') o.unison = n;
            else {
              o.voices = n;
              o.mono ??= false;
            }
          }
          return '';
        }
        const native = line.match(/^(\s+)([\w.]+)\s*=\s*([^\s]+)\s*$/);
        const sync = line.match(/^(\s+)(lfo2|drum\.lfo)\.sync\s*(?:=\s*)?(\d+)\/(\d+)(\.|t)?\s*$/);
        if (sync) {
          const seconds =
            ((Number(sync[3]) / Number(sync[4])) *
              (sync[5] === '.' ? 1.5 : sync[5] === 't' ? 2 / 3 : 1) *
              240) /
            bpm;
          return `${sync[1]}${sync[2]}.hz = ${1 / seconds}`;
        }
        if (native && lockUnits[native[2]] && /(?:ms|s|Hz|kHz|ct|st|oct)$/.test(native[3])) {
          const converted = lowerLockUnits(`{${native[2]} ${native[3]}}`);
          return `${native[1]}${converted.slice(1, -1).replace(/^([\w.]+)\s+/, '$1 = ')}`;
        }
        if (native && native[2] in soundDomains) {
          const field = native[2],
            raw = native[3];
          const types = ['lp12', 'lp24', 'hp12', 'hp24', 'bp', 'notch', 'lp18'];
          if (field === 'filter.type' && types.includes(raw))
            return `${native[1]}${field} = ${types.indexOf(raw)}`;
          if (['lfo.trigger', 'lfo2.trigger'].includes(field) && ['song', 'note'].includes(raw))
            return `${native[1]}${field} = ${raw === 'note' ? 1 : 0}`;
          if (
            field === 'lfo2.shape' &&
            ['sine', 'triangle', 'square', 'saw', 'sample-and-hold'].includes(raw)
          )
            return `${native[1]}${field} = ${['sine', 'triangle', 'square', 'saw', 'sample-and-hold'].indexOf(raw) / 4}`;
          if (field === 'drum.pitch' && /^[A-G][#b]?-?\d+$/.test(raw)) {
            const m = raw.match(/^([A-G])([#b]?)(-?\d+)$/)!;
            const n =
              ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as Record<string, number>)[m[1]] +
              (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) +
              (Number(m[3]) + 1) * 12;
            return `${native[1]}${field} = ${n}`;
          }
          const unit = raw.match(/^([-+\d.]+)(ct|st|oct|ms|s|Hz|kHz)$/);
          if (
            unit &&
            [
              'osc1.fine',
              'osc2.fine',
              'osc2.semitone',
              'unison.spread',
              'filter.fm',
              'lfo.delay',
              'lfo.fade',
              'lfo.slew',
              'lfo2.hz',
              'lfo2.pitch',
              'lfo2.cutoff',
              'modenv.attack',
              'modenv.decay',
              'modenv.release',
              'modenv.pitch',
              'modenv.cutoff',
              'drum.pitch.depth',
              'drum.pitch.decay',
              'drum.lfo.hz',
              'drum.lfo.pitch',
              'lfo.detune',
            ].includes(field)
          ) {
            const wanted =
              field.endsWith('.fine') ||
              (field.endsWith('.pitch') && field !== 'drum.lfo.pitch') ||
              field === 'unison.spread' ||
              field === 'lfo.detune'
                ? 'ct'
                : ['osc2.semitone', 'drum.pitch.depth', 'drum.lfo.pitch'].includes(field)
                  ? 'st'
                  : field === 'filter.fm' || field.endsWith('.cutoff')
                    ? 'oct'
                    : ['lfo2.hz', 'drum.lfo.hz'].includes(field)
                      ? 'Hz'
                      : 's';
            if (
              unit[2] !== wanted &&
              !(wanted === 's' && unit[2] === 'ms') &&
              !(wanted === 'Hz' && unit[2] === 'kHz')
            )
              throw new RangeError(`Wrong unit for ${field}: ${raw}`);
            return `${native[1]}${field} = ${Number(unit[1]) * (unit[2] === 'ms' ? 0.001 : unit[2] === 'kHz' ? 1000 : 1)}`;
          }
        }
        const perDecay = line.match(/^(\s+)pluck\.decay\s*=\s*(per\s+[^:]+:)\s*(.+)$/);
        if (perDecay) {
          const values = perDecay[3].split(',').map((v) => {
            const m = v.trim().match(/^([\d.]+)(ms|s)$/);
            if (!m) return v.trim();
            const seconds = Number(m[1]) * (m[2] === 'ms' ? 0.001 : 1);
            if (seconds < 0.05 || seconds > 30)
              throw new RangeError('Pluck decay must be 50ms..30s');
            return String(Math.log(seconds / 0.05) / Math.log(600));
          });
          return `${perDecay[1]}pluck.decay = ${perDecay[2]} ${values.join(', ')}`;
        }
        const decay = line.match(/^(\s+)pluck\.decay\s*=\s*([\d.]+)(ms|s)\s*$/);
        if (decay) {
          const seconds = Number(decay[2]) * (decay[3] === 'ms' ? 0.001 : 1);
          if (seconds < 0.05 || seconds > 30) throw new RangeError('Pluck decay must be 50ms..30s');
          return `${decay[1]}pluck.decay = ${Math.log(seconds / 0.05) / Math.log(600)}`;
        }
        const shift = line.match(/^(\s+)formant\.shift\s*=\s*([-+\d.]+)st\s*$/);
        if (shift) return `${shift[1]}formant.shift = ${Number(shift[2])}`;
        return raw;
      }),
    )
    .join('\n');
  return { coreSource, sounds, overrides };
}
