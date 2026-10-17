import { readFileSync } from 'node:fs';

export type Envelope = { a: number; d: number; s: number; r: number };
export type Preset = {
  name: string;
  mode: 'analog' | 'fm' | 'pluck';
  mono: boolean;
  voices: number;
  wave1: number;
  wave2: number;
  pw: number;
  osc1: number;
  osc2: number;
  coarse2: number;
  fine1: number;
  fine2: number;
  sub: number;
  subWave: 'sine' | 'square';
  noise: number;
  cutoff: number;
  resonance: number;
  filter: 'lp24' | 'lp12' | 'hp12' | 'bp12' | 'lp18' | 'formant';
  pluckDamping: number;
  pluckBrightness: number;
  pluckDecay: number;
  pluckPick: number;
  vowel: number;
  formantShift: number;
  formantResonance: number;
  lfoVowel: number;
  keytrack: number;
  envamount: number;
  amp: Envelope;
  env: Envelope;
  velSens: number;
  drive: number;
  glide: number;
  unison: number;
  detune: number;
  width: number;
  drift: number;
  hp: number;
  chorus: number;
  chorusRate: number;
  chorusDepth: number;
  lfoRate: number;
  lfoAmount: number;
  lfoDepth: number;
  vibDelay: number;
  vibFade: number;
  fmRatio: number;
  fmIndex: number;
  fmEnv: Envelope;
  fmVel: number;
  acid: boolean;
  trim: number;
};
export type Mix = { gain: number; pan: number; room: number; echo: number };
export const db = (n: number) => 10 ** (n / 20);
export const members: Record<string, string> = {
  bass: 'round-bass',
  acid: 'acid-303',
  arp: 'saw-pluck',
  pads: 'warm-pad',
  chords: 'stab',
  lead: 'warm-lead',
  counter: 'soft-square',
  drone: 'round-drone',
  seq: 'pluck-seq',
  fx: 'noise-sweep',
  keys: 'fm-keys',
};
export const roles: Record<string, string> = {
  low: 'round-bass',
  front: 'warm-lead',
  bed: 'warm-pad',
  color: 'pluck-seq',
  high: 'soft-square',
  pulse: 'saw-pluck',
};
const mixes: Record<string, [number, number, number, number]> = {
  bass: [-2, 0, -Infinity, -Infinity],
  acid: [-4, 0, -22, -24],
  arp: [-8, -0.2, -20, -22],
  pads: [-8, 0, -12, -Infinity],
  chords: [-7, 0.1, -18, -14],
  lead: [-4, 0, -16, -16],
  counter: [-9, 0.25, -14, -18],
  drone: [-12, 0, -12, -Infinity],
  seq: [-8, -0.15, -18, -12],
  fx: [-10, 0, -8, -Infinity],
  keys: [-6, -0.1, -12, -Infinity],
};
export function memberMix(name: string): Mix {
  const [gain, pan, room, echo] = mixes[name] ?? [-8, 0, -18, -Infinity];
  return { gain: db(gain), pan, room: db(room), echo: db(echo) };
}
const defaults: Preset = {
  name: 'init',
  mode: 'analog',
  mono: false,
  voices: 8,
  wave1: 2 / 3,
  wave2: 2 / 3,
  pw: 0.5,
  osc1: 1,
  osc2: 0,
  coarse2: 0,
  fine1: 0,
  fine2: 0,
  sub: 0,
  subWave: 'square',
  noise: 0,
  cutoff: 18000,
  resonance: 0,
  filter: 'lp24',
  keytrack: 0,
  envamount: 0,
  amp: { a: 0.002, d: 0.3, s: 1, r: 0.05 },
  env: { a: 0.001, d: 0.3, s: 0, r: 0.3 },
  velSens: 0.7,
  drive: 0,
  glide: 0,
  unison: 1,
  detune: 0,
  width: 0,
  drift: 0,
  hp: 0,
  chorus: 0,
  chorusRate: 0.4,
  chorusDepth: 0,
  lfoRate: 1,
  lfoAmount: 0,
  lfoDepth: 1,
  vibDelay: 0,
  vibFade: 0,
  fmRatio: 1,
  fmIndex: 0,
  fmEnv: { a: 0.001, d: 0.3, s: 0, r: 0.3 },
  fmVel: 0,
  acid: false,
  trim: 0.2,
  pluckDamping: 0.5,
  pluckBrightness: 0.5,
  pluckDecay: 1.5,
  pluckPick: 0.5,
  vowel: 0,
  formantShift: 0,
  formantResonance: 0.5,
  lfoVowel: 0,
};
const data = JSON.parse(
  readFileSync(new URL('../presets/band.json', import.meta.url), 'utf8'),
) as Record<string, Partial<Preset>>;
export function preset(name: string): Preset {
  if (name !== 'init' && !Object.hasOwn(data, name))
    throw new RangeError(`Unknown software preset ${name}`);
  const patch = data[name] ?? {};
  for (const key of Object.keys(patch)) {
    if (!(key in defaults)) throw new RangeError(`Unknown preset field ${name}.${key}`);
  }
  const out = {
    ...defaults,
    ...patch,
    name,
    velSens: name === 'init' ? 1 : (patch.velSens ?? defaults.velSens),
    amp: { ...defaults.amp, ...patch.amp },
    env: { ...defaults.env, ...patch.env },
    fmEnv: { ...defaults.fmEnv, ...patch.fmEnv },
  };
  if ((out.fine2 || out.coarse2) && out.osc2 === 0 && out.mode === 'analog')
    throw new RangeError(`Preset ${name} configures an inaudible oscillator 2`);
  if (out.mode !== 'fm' && out.fmIndex !== 0) throw new RangeError(`Preset ${name} needs FM mode`);
  if (Object.keys(patch).some((k) => k.startsWith('pluck')) && out.mode !== 'pluck')
    throw new RangeError(`Preset ${name} needs pluck mode`);
  if (
    Object.keys(patch).some((k) =>
      ['vowel', 'formantShift', 'formantResonance', 'lfoVowel'].includes(k),
    ) &&
    out.filter !== 'formant'
  )
    throw new RangeError(`Preset ${name} needs a formant filter`);
  if (out.mode === 'pluck' && out.unison !== 1)
    throw new RangeError('Pluck mode currently uses one string per voice');
  return out;
}
export function presetNames(): string[] {
  return ['init', ...Object.keys(data)].sort();
}

export function configuredPreset(name: string, overrides: Partial<Preset> = {}): Preset {
  const base = preset(name);
  const out = { ...base, ...overrides };
  if (overrides.mono === false && base.mono && overrides.voices === undefined) out.voices = 8;
  if (out.mode === 'pluck' && out.unison > 1)
    throw new RangeError('Plucked strings currently require unison 1');
  return out;
}
