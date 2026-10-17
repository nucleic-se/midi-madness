import { SpatialVoice, type SpatialSettings } from './spatial.ts';
import {
  LaneCursor,
  PoseCursor,
  relativeToListener,
  simplifyLane,
  type LanePoint,
  type ListenerLanes,
  type PositionLanes,
} from './world.ts';
/** The envelope values one note actually had, from its attack until its voice went silent,
 * was stolen or handed over legato. `amplitude` is the amp envelope stage (0..1, or the grain
 * window), before velocity, note level, member level and tremolo; `filter` is the filter
 * envelope (0..1) before envamount. Several records can share an id (a mono note resumed).
 */
export type EnvelopeRecord = {
  id: string;
  on: number;
  end: number;
  amplitude: LanePoint[];
  filter: LanePoint[];
};
/** Recording grid and simplification tolerance for exported envelopes. */
export const envelopeGrid = 64,
  envelopeTolerance = 0.001;
import { interpolate } from '@midi-madness/foundation/curves';
export type VoicePath = { name: string; from: number; to: number; samples: number; curve: string };
import { routedTargets, routingNames } from './modulation.ts';
const secondRouting = Object.values(routingNames).map((names) => names[1]);
import { createSends, setSend, noteThrows, throwAudio, sendAudio, type Throw } from './sends.ts';
import { configuredPreset, type Preset, type Envelope, type Mix } from './presets.ts';
import { createInsertChain } from './processors.ts';
import type { Stage } from './buses.ts';
import { PluckedString, VowelFilter } from './physical.ts';

export type SynthEvent =
  | {
      sample: number;
      type: 'on';
      id: string;
      pitch: number;
      velocity: number;
      grainSamples?: number;
      paths?: VoicePath[];
      pan?: number;
      panOffset?: number;
      sends?: Record<string, number>;
      locks?: Record<string, number>;
    }
  | { sample: number; type: 'off'; id: string }
  | { sample: number; type: 'set'; name: string; value: number | null; phaseAnchor?: boolean };
export type MemberReport = {
  notes: number;
  slides: number;
  accents: number;
  retriggers: number;
  peak: number;
  ignored: string[];
};
export type AudioBuses = {
  ambisonic?: Float32Array[];
  left: Float32Array;
  right: Float32Array;
  room: Float32Array;
  echo: Float32Array;
  buses?: Record<string, { left: Float32Array; right: Float32Array }>;
};
export function buffers(frames: number): AudioBuses {
  return {
    left: new Float32Array(frames),
    right: new Float32Array(frames),
    room: new Float32Array(frames),
    echo: new Float32Array(frames),
  };
}
export const supported = new Set(
  'cutoff resonance envamount attack decay sustain release filter.attack filter.decay filter.sustain filter.release level level.db drive wave noise sub detune glide mod bend lfo.rate lfo.hz lfo.amount lfo.pitch lfo.amp lfo.pan lfo.cutoff lfo.shape bend.range ring.hz ring.ratio ring.mix comb.hz comb.time comb.mix comb.feedback comb.depth comb.rate pan reverb delay'.split(
    ' ',
  ),
);
for (const name of [
  'cents',
  'space.az',
  'space.el',
  'space.dist',
  'space.x',
  'space.y',
  'space.z',
  'pluck.damping',
  'pluck.brightness',
  'pluck.decay',
  'pluck.pick',
  'vowel',
  'formant.vowel',
  'formant.shift',
  'formant.resonance',
  'lfo.vowel',
  'osc1.level',
  'osc2.level',
  'osc1.wave',
  'osc2.wave',
  'osc1.fine',
  'osc2.fine',
  'osc2.semitone',
  'pw',
  'fm.index',
  'fm.ratio',
  'sync',
  'sync.ratio',
  'fold',
  'filter.type',
  'keytrack',
  'filter.fm',
  'unison.spread',
  'unison.width',
  'lfo.ratio',
  'lfo.trigger',
  'lfo.phase',
  'lfo.delay',
  'lfo.fade',
  'lfo.slew',
  'velSens',
])
  supported.add(name);
export const voiceControl = (name: string) =>
  name.startsWith('lfo.') ||
  name.startsWith('lfo2.') ||
  name.startsWith('modenv.') ||
  name.startsWith('space.') ||
  ['envamount', 'cutoff', 'resonance', 'pan', 'level', 'level.db', 'cents'].includes(name) ||
  [
    'fm.index',
    'fold',
    'sync',
    'sync.ratio',
    'pw',
    'filter.fm',
    'filter.attack',
    'filter.decay',
    'filter.sustain',
    'filter.release',
  ].includes(name);
for (const name of [
  'lfo.resonance',
  'lfo.pw',
  'lfo.wave',
  'lfo.detune',
  'lfo2.hz',
  'lfo2.ratio',
  'lfo2.shape',
  'lfo2.phase',
  'lfo2.trigger',
  'lfo2.pitch',
  'lfo2.cutoff',
  'lfo2.amp',
  'lfo2.pan',
  'lfo2.rateMod',
  'lfo2.depthMod',
  'modenv.attack',
  'modenv.decay',
  'modenv.sustain',
  'modenv.release',
  'modenv.pitch',
  'modenv.cutoff',
  'modenv.lfo',
  'modenv.curve',
])
  supported.add(name);
for (const names of Object.values(routingNames)) for (const name of names) supported.add(name);
const TAU = Math.PI * 2;
export const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
export const hz = (note: number) => 440 * 2 ** ((note - 69) / 12);
export const knobTime = (x: number) => 0.001 + 5 * x ** 3;
export function seedHash(s: string): number {
  let n = 2166136261;
  for (let i = 0; i < s.length; i++) n = Math.imul(n ^ s.charCodeAt(i), 16777619);
  return n >>> 0 || 1;
}
export function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
function blep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}
export function oscillator(t: number, dt: number, wave: number, pw: number): number {
  const n = clamp(wave, 0, 1) * 3;
  const sine = Math.sin(TAU * t);
  if (n < 1) return sine * (1 - n) + (1 - 4 * Math.abs(t - 0.5)) * n;
  const saw = 2 * t - 1 - blep(t, dt);
  if (n < 2) return (1 - 4 * Math.abs(t - 0.5)) * (2 - n) + saw * (n - 1);
  const square = (t < pw ? 1 : -1) + blep(t, dt) - blep((t - pw + 1) % 1, dt);
  return saw * (3 - n) + square * (n - 2);
}
function saturate(x: number): number {
  return x / (1 + Math.abs(x));
}
class Env {
  value = 0;
  stage = 0;
  start = 0;
  age = 0;
  on() {
    this.start = this.value;
    this.age = 0;
    this.stage = 1;
  }
  off() {
    this.start = this.value;
    this.age = 0;
    this.stage = 4;
  }
  next(e: Envelope, sr: number): number {
    const dt = 1 / sr;
    if (this.stage === 1) {
      this.age += dt;
      const t = Math.min(1, this.age / Math.max(0.001, e.a));
      this.value = this.start + (1 - this.start) * (1.2 * (1 - Math.exp(-Math.log(6) * t)));
      if (t >= 1) {
        this.value = 1;
        this.stage = 2;
        this.age = 0;
      }
    } else if (this.stage === 2) {
      // The coefficient is cached by the voice's control-rate update.
      this.value = e.s + (this.value - e.s) * this.decay;
      if (Math.abs(this.value - e.s) < 0.00001) {
        this.value = e.s;
        this.stage = 3;
      }
    } else if (this.stage === 3) this.value = e.s;
    else if (this.stage === 4) {
      this.value *= this.release;
      if (this.value < 0.00001) {
        this.value = 0;
        this.stage = 0;
      }
    }
    return this.value;
  }
  decay = 0;
  release = 0;
  coefficients(e: Envelope, sr: number) {
    this.decay = Math.exp(-Math.log(100) / (Math.max(0.001, e.d) * sr));
    this.release = Math.exp(-Math.log(100) / (Math.max(0.001, e.r) * sr));
  }
}
class Voice {
  string: PluckedString | undefined;
  vowelFilter: VowelFilter | undefined;
  id = '';
  note = 60;
  target = 60;
  velocity = 1;
  active = false;
  held = false;
  amp = new Env();
  env = new Env();
  index = new Env();
  phase = new Float64Array(8);
  phase2 = new Float64Array(8);
  subPhase = new Float64Array(8);
  low = new Float64Array(8);
  band = new Float64Array(8);
  low2 = new Float64Array(8);
  band2 = new Float64Array(8);
  freq1 = new Float64Array(8);
  freq2 = new Float64Array(8);
  pan: number | undefined;
  panOffset = 0;
  throws: Throw[] = [];
  ringPhase = 0;
  lfoCycles = 0;
  lfoSmooth = 0;
  lfoSeed = 1;
  lfo2Cycles = 0;
  spatial?: SpatialVoice;
  record?: Omit<EnvelopeRecord, 'end'>;
  grainSamples = 0;
  paths: VoicePath[] = [];
  pathStart = 0;
  locks: Record<string, number> = {};
  modEnvelope = new Env();
  modSettings: Envelope = { a: 0.01, d: 0.3, s: 0, r: 0.2 };
  filterSettings: Envelope = { a: 0.01, d: 0.3, s: 0, r: 0.2 };
  oldSlew = -1;
  slewCoef = 0;
  drift = 0;
  accent = false;
  age = 0;
  glideCoef = 0;
  glideRemaining = 0;
  random: () => number;
  constructor(random: () => number) {
    this.random = random;
  }
}
type Settings = {
  routing: Record<string, number>;
  lfoResonance: number;
  lfoPW: number;
  lfoWaveDepth: number;
  lfoDetune: number;
  lfo2Hz: number;
  lfo2Ratio: number;
  lfo2Shape: number;
  lfo2Offset: number;
  lfo2Trigger: number;
  lfo2Pitch: number;
  lfo2Cutoff: number;
  lfo2Amp: number;
  lfo2Pan: number;
  lfo2RateMod: number;
  lfo2DepthMod: number;
  modEnv: Envelope;
  modPitch: number;
  modCutoff: number;
  modLfo: number;
  modCurve: number;
  osc1: number;
  osc2: number;
  fine1: number;
  fine2: number;
  coarse2: number;
  pw: number;
  fmRatio: number;
  analogFM: number;
  sync: number;
  syncRatio: number;
  fold: number;
  filterType: number;
  keytrack: number;
  filterFM: number;
  width: number;
  velSens: number;
  lfoRatio: number;
  lfoTrigger: number;
  lfoOffset: number;
  lfoDelay: number;
  lfoFade: number;
  lfoSlew: number;

  cutoff: number;
  resonance: number;
  envamount: number;
  drive: number;
  wave1: number;
  wave2: number;
  sub: number;
  noise: number;
  detune: number;
  glide: number;
  mod: number;
  bend: number;
  lfoRate: number;
  lfoAmount: number;
  level: number;
  levelDb: number;
  pan: number;
  room: number;
  echo: number;
  amp: Envelope;
  env: Envelope;
  fmIndex: number;
  bendRange: number;
  lfoPitch: number;
  lfoAmp: number;
  lfoPan: number;
  lfoCutoff: number;
  lfoShape: number;
  ringHz: number;
  ringRatio: number;
  ringMix: number;
  combTime: number;
  combMix: number;
  combFeedback: number;
  combDepth: number;
  combRate: number;
  pluckDamping: number;
  pluckBrightness: number;
  pluckDecay: number;
  pluckPick: number;
  vowel: number;
  formantShift: number;
  formantResonance: number;
  lfoVowel: number;
};

/** Compiler-independent, sample-timed offline voice renderer. */
/** The preset and voice allocation a member renders with; the performance export reuses it. */
export function memberPreset(
  presetName: string,
  overrides: Partial<Preset> = {},
  grainCapacity?: number,
): { preset: Preset; voiceCount: number } {
  const preset = configuredPreset(presetName, {
    ...overrides,
    ...(grainCapacity ? { mono: false, voices: 32 } : {}),
  });
  return { preset, voiceCount: grainCapacity ?? (preset.mono ? 1 : preset.voices) };
}
export function renderMember(
  name: string,
  presetName: string,
  mix: Mix,
  events: SynthEvent[],
  sr: number,
  seed: number,
  out: AudioBuses,
  songStartSample = 0,
  processing: {
    inserts?: Stage[];
    cuts?: number[];
    preset?: Partial<Preset>;
    grainCapacity?: number;
    space?: SpatialSettings;
    /** Present for world-frame parts: position lanes plus the listener they are heard from. */
    world?: { position: PositionLanes; listener?: ListenerLanes };
    /** Receives each note's recorded envelope values (see EnvelopeRecord). */
    envelopes?: EnvelopeRecord[];
  } = {},
): MemberReport {
  const chain = createInsertChain(processing.inserts ?? [], sr, seed, songStartSample);
  let cutCursor = 0,
    noteHz = 440;
  const { preset: p, voiceCount } = memberPreset(
      presetName,
      processing.preset,
      processing.grainCapacity,
    ),
    random = rng(seed),
    voices = Array.from({ length: voiceCount }, () => new Voice(random));
  const world = processing.world,
    worldX = new LaneCursor(world?.position.x),
    worldY = new LaneCursor(world?.position.y),
    worldZ = new LaneCursor(world?.position.z),
    pose = new PoseCursor(world?.listener),
    relative = { azimuth: 0, elevation: 0, distance: 1 };
  for (const v of voices) {
    if (p.mode === 'pluck') v.string = new PluckedString(sr);
    if (p.filter === 'formant') v.vowelFilter = new VowelFilter(sr);
  }
  const settings: Settings = {
    routing: {},
    lfoResonance: 0,
    lfoPW: 0,
    lfoWaveDepth: 0,
    lfoDetune: 0,
    lfo2Hz: 0.3,
    lfo2Ratio: 0,
    lfo2Shape: 0,
    lfo2Offset: 0,
    lfo2Trigger: 0,
    lfo2Pitch: 0,
    lfo2Cutoff: 0,
    lfo2Amp: 0,
    lfo2Pan: 0,
    lfo2RateMod: 0,
    lfo2DepthMod: 0,
    modEnv: { a: 0.01, d: 0.3, s: 0, r: 0.2 },
    modPitch: 0,
    modCutoff: 0,
    modLfo: 0,
    modCurve: 1,
    osc1: p.osc1,
    osc2: p.osc2,
    fine1: p.fine1,
    fine2: p.fine2,
    coarse2: p.coarse2,
    pw: p.pw,
    fmRatio: p.fmRatio,
    analogFM: 0,
    sync: 0,
    syncRatio: 1,
    fold: 0,
    filterType: { lp12: 0, lp24: 1, hp12: 2, bp12: 4, lp18: 6, formant: 1 }[p.filter],
    keytrack: p.keytrack,
    filterFM: 0,
    width: p.width,
    velSens: p.velSens,
    lfoRatio: 0,
    lfoTrigger: 0,
    lfoOffset: 0,
    lfoDelay: 0,
    lfoFade: 0,
    lfoSlew: 0,

    pluckDamping: p.pluckDamping,
    pluckBrightness: p.pluckBrightness,
    pluckDecay: p.pluckDecay,
    pluckPick: p.pluckPick,
    vowel: p.vowel,
    formantShift: p.formantShift,
    formantResonance: p.formantResonance,
    lfoVowel: p.lfoVowel,
    cutoff: p.cutoff,
    resonance: p.resonance,
    envamount: p.envamount,
    drive: p.drive,
    wave1: p.wave1,
    wave2: p.wave2,
    sub: p.sub,
    noise: p.noise,
    detune: p.detune,
    glide: p.glide,
    mod: 0,
    bend: 0,
    lfoRate: p.lfoRate,
    lfoAmount: p.lfoAmount,
    level: 1,
    levelDb: 1,
    pan: mix.pan,
    room: mix.room,
    echo: mix.echo,
    amp: { ...p.amp },
    env: { ...p.env },
    fmIndex: p.fmIndex,
    bendRange: 2,
    lfoPitch: 0,
    lfoAmp: 0,
    lfoPan: 0,
    lfoCutoff: 0,
    lfoShape: 0,
    ringHz: 0,
    ringRatio: 1,
    ringMix: 0,
    combTime: 0.003,
    combMix: 0,
    combFeedback: 0.4,
    combDepth: 0,
    combRate: 0.2,
  };
  const defaults = structuredClone(settings);
  const routes = createSends(out.buses, { room: mix.room, echo: mix.echo });
  let nativeRate: number | null = null,
    normalizedRate: number | null = null;
  let combFrequency: number | null = null,
    combDelay: number | null = null;
  const report: MemberReport = {
    notes: 0,
    slides: 0,
    accents: 0,
    retriggers: 0,
    peak: 0,
    ignored: [],
  };
  const held: {
    id: string;
    pitch: number;
    velocity: number;
    pan?: number;
    panOffset?: number;
    grainSamples?: number;
    sends?: Record<string, number>;
    paths?: VoicePath[];
    locks?: Record<string, number>;
  }[] = [];
  let activeCount = 0,
    cursor = 0,
    lfoPhase = 0,
    cycles = (-songStartSample * p.lfoRate) / sr,
    charge = 0;
  let smoothCut = settings.cutoff,
    smoothGain = 1,
    smoothPan = settings.pan;
  let smoothBend = 0;
  const smoothing = 1 - Math.exp(-1 / (sr * 0.0003));
  const combL = new Float32Array(sr * 2 + 2),
    combR = new Float32Array(sr * 2 + 2);
  let combPos = 0;
  let hpLeft = 0,
    hpRight = 0,
    hpInL = 0,
    hpInR = 0;
  const hpCoef = p.hp ? Math.exp((-TAU * p.hp) / sr) : 0;
  const chorus = new Float32Array(Math.ceil(sr * 0.035)),
    chorusSize = chorus.length;
  let chorusPos = 0;
  const spatialControls: Record<string, number> = {};
  const fields: Record<string, keyof Settings> = {
    'osc1.level': 'osc1',
    'osc2.level': 'osc2',
    'osc1.wave': 'wave1',
    'osc2.wave': 'wave2',
    'osc1.fine': 'fine1',
    'osc2.fine': 'fine2',
    'osc2.semitone': 'coarse2',
    pw: 'pw',
    'fm.ratio': 'fmRatio',
    sync: 'sync',
    'sync.ratio': 'syncRatio',
    fold: 'fold',
    'filter.type': 'filterType',
    keytrack: 'keytrack',
    'filter.fm': 'filterFM',
    'unison.spread': 'detune',
    'unison.width': 'width',
    velSens: 'velSens',
    'lfo.ratio': 'lfoRatio',
    'lfo.trigger': 'lfoTrigger',
    'lfo.phase': 'lfoOffset',
    'lfo.resonance': 'lfoResonance',
    'lfo.pw': 'lfoPW',
    'lfo.wave': 'lfoWaveDepth',
    'lfo.detune': 'lfoDetune',
    'lfo2.hz': 'lfo2Hz',
    'lfo2.ratio': 'lfo2Ratio',
    'lfo2.shape': 'lfo2Shape',
    'lfo2.phase': 'lfo2Offset',
    'lfo2.trigger': 'lfo2Trigger',
    'lfo2.pitch': 'lfo2Pitch',
    'lfo2.cutoff': 'lfo2Cutoff',
    'lfo2.amp': 'lfo2Amp',
    'lfo2.pan': 'lfo2Pan',
    'lfo2.rateMod': 'lfo2RateMod',
    'lfo2.depthMod': 'lfo2DepthMod',
    'modenv.pitch': 'modPitch',
    'modenv.cutoff': 'modCutoff',
    'modenv.lfo': 'modLfo',
    'modenv.curve': 'modCurve',
    'lfo.delay': 'lfoDelay',
    'lfo.fade': 'lfoFade',
    'lfo.slew': 'lfoSlew',
  };
  const control = (key: string, value: number | null) => {
    if (chain.control(key, value)) return;
    if (
      setSend(routes, key === 'reverb' ? 'send.room' : key === 'delay' ? 'send.echo' : key, value)
    )
      return;
    if (!supported.has(key) || (p.acid && key === 'glide')) {
      if (!report.ignored.includes(key)) report.ignored.push(key);
      return;
    }
    if (
      (key.startsWith('pluck.') && p.mode !== 'pluck') ||
      ((key.startsWith('formant.') || key === 'vowel' || key === 'lfo.vowel') &&
        p.filter !== 'formant')
    ) {
      if (!report.ignored.includes(key)) report.ignored.push(key);
      return;
    }
    if (Object.values(routingNames).some((names) => names.includes(key))) {
      settings.routing[key] = value ?? 0;
      return;
    }
    if (key.startsWith('pluck.')) {
      const field = (
        {
          damping: 'pluckDamping',
          brightness: 'pluckBrightness',
          decay: 'pluckDecay',
          pick: 'pluckPick',
        } as const
      )[key.slice(6) as 'damping'];
      settings[field] =
        value === null ? defaults[field] : key === 'pluck.decay' ? 0.05 * 600 ** value : value;
      return;
    }
    if (
      ['vowel', 'formant.vowel', 'formant.shift', 'formant.resonance', 'lfo.vowel'].includes(key)
    ) {
      const field = (
        {
          vowel: 'vowel',
          'formant.vowel': 'vowel',
          'formant.shift': 'formantShift',
          'formant.resonance': 'formantResonance',
          'lfo.vowel': 'lfoVowel',
        } as const
      )[key as 'vowel'];
      settings[field] = value ?? defaults[field];
      return;
    }
    if (key.startsWith('space.')) {
      spatialControls[key] = value ?? (key === 'space.dist' ? 1 : 0);
      return;
    }
    if (key === 'fm.index') {
      if (p.mode === 'pluck') {
        if (!report.ignored.includes(key)) report.ignored.push(key);
        return;
      }
      settings.fmIndex = value ?? defaults.fmIndex;
      settings.analogFM = value ?? 0;
      return;
    }
    if (
      key.startsWith('modenv.') &&
      ['attack', 'decay', 'sustain', 'release'].includes(key.slice(7))
    ) {
      const letter = ({ attack: 'a', decay: 'd', sustain: 's', release: 'r' } as const)[
        key.slice(7) as 'attack'
      ];
      settings.modEnv[letter] = value ?? defaults.modEnv[letter];
      return;
    }
    const field = fields[key];
    if (field) {
      if (
        (p.mode === 'pluck' &&
          (key.startsWith('osc2.') ||
            ['sync', 'sync.ratio', 'pw', 'fm.ratio', 'fold', 'filter.fm'].includes(key))) ||
        (p.mode === 'fm' &&
          ['osc1.wave', 'osc2.wave', 'osc2.level', 'pw', 'sync', 'sync.ratio'].includes(key))
      ) {
        if (!report.ignored.includes(key)) report.ignored.push(key);
        return;
      }
      (settings[field] as number) = value ?? (defaults[field] as number);
      if (key === 'filter.type') settings.filterType = Math.round(settings.filterType);
      return;
    }
    if (key.startsWith('filter.') || ['attack', 'decay', 'sustain', 'release'].includes(key)) {
      const filter = key.startsWith('filter.'),
        field = key.split('.').at(-1)!;
      const letter = ({ attack: 'a', decay: 'd', sustain: 's', release: 'r' } as const)[
        field as 'attack' | 'decay' | 'sustain' | 'release'
      ];
      const target = filter ? settings.env : settings.amp,
        def = filter ? defaults.env : defaults.amp;
      target[letter] = value === null ? def[letter] : letter === 's' ? value : knobTime(value);
      if (p.acid && filter && letter === 'd') target.d = clamp(target.d, 0.2, 2);
      return;
    }
    const v = value ?? 0;
    switch (key) {
      case 'cutoff':
        settings.cutoff =
          value === null ? defaults.cutoff : p.acid ? 60 * (8000 / 60) ** v : 20 * 1000 ** v;
        break;
      case 'resonance':
        settings.resonance = value ?? defaults.resonance;
        break;
      case 'envamount':
        settings.envamount = value === null ? defaults.envamount : v * 6;
        break;
      case 'drive':
        settings.drive = value ?? defaults.drive;
        break;
      case 'wave':
        settings.wave1 = value ?? defaults.wave1;
        settings.wave2 = value ?? defaults.wave2;
        settings.fmIndex = value === null ? p.fmIndex : v * 20;
        break;
      case 'noise':
        settings.noise = value === null ? defaults.noise : v * v;
        break;
      case 'sub':
        settings.sub = value === null ? defaults.sub : v * v;
        break;
      case 'detune':
        settings.detune = value === null ? defaults.detune : v * 50;
        break;
      case 'glide':
        settings.glide = value === null ? defaults.glide : v === 0 ? 0 : knobTime(v);
        break;
      case 'mod':
        settings.mod = v * 100;
        break;
      case 'bend':
        settings.bend = v;
        break;
      case 'lfo.rate':
        normalizedRate = value;
        settings.lfoRate =
          nativeRate ??
          (normalizedRate === null ? defaults.lfoRate : 0.05 * 40000 ** normalizedRate);
        break;
      case 'lfo.hz':
        nativeRate = value;
        settings.lfoRate =
          nativeRate ??
          (normalizedRate === null ? defaults.lfoRate : 0.05 * 40000 ** normalizedRate);
        break;
      case 'bend.range':
        settings.bendRange = value ?? 2;
        break;
      case 'lfo.pitch':
        settings.lfoPitch = value ?? 0;
        break;
      case 'lfo.amp':
        settings.lfoAmp = value ?? 0;
        break;
      case 'lfo.pan':
        settings.lfoPan = value ?? 0;
        break;
      case 'lfo.cutoff':
        settings.lfoCutoff = value ?? 0;
        break;
      case 'lfo.shape':
        settings.lfoShape = Math.round(v * 4);
        break;
      case 'ring.hz':
        settings.ringHz = value ?? 0;
        break;
      case 'ring.ratio':
        settings.ringRatio = value ?? 1;
        break;
      case 'ring.mix':
        settings.ringMix = value ?? 0;
        break;
      case 'comb.hz':
        combFrequency = value;
        settings.combTime =
          combFrequency === null ? (combDelay ?? defaults.combTime) : 1 / combFrequency;
        break;
      case 'comb.time':
        combDelay = value;
        settings.combTime =
          combFrequency === null ? (combDelay ?? defaults.combTime) : 1 / combFrequency;
        break;
      case 'comb.mix':
        settings.combMix = value ?? 0;
        break;
      case 'comb.feedback':
        settings.combFeedback = value ?? 0.4;
        break;
      case 'comb.depth':
        settings.combDepth = value ?? 0;
        break;
      case 'comb.rate':
        settings.combRate = value ?? 0.2;
        break;
      case 'lfo.amount':
        settings.lfoAmount = value ?? defaults.lfoAmount;
        break;
      case 'level.db':
        settings.levelDb = value === null ? 1 : 10 ** (value / 20);
        break;
      case 'level':
        settings.level = value === null ? defaults.level : v * v;
        break;
      case 'pan':
        settings.pan = value ?? defaults.pan;
        break;
      case 'reverb':
        settings.room = value === null ? defaults.room : v * v;
        break;
      case 'delay':
        settings.echo = value === null ? defaults.echo : v * v;
        break;
    }
  };
  const routed = (
    v: Voice,
    target: keyof typeof routedTargets,
    first: number,
    second: number,
    env: number,
  ) => {
    const keys = routingNames[target];
    return (
      first * (v.locks[keys[0]] ?? settings.routing[keys[0]] ?? 0) +
      second * (v.locks[keys[1]] ?? settings.routing[keys[1]] ?? 0) +
      env * (v.locks[keys[2]] ?? settings.routing[keys[2]] ?? 0)
    );
  };
  const updateVoiceEnvelopes = (v: Voice) => {
    v.modSettings.a = v.locks['modenv.attack'] ?? settings.modEnv.a;
    v.modSettings.d = v.locks['modenv.decay'] ?? settings.modEnv.d;
    v.modSettings.s = v.locks['modenv.sustain'] ?? settings.modEnv.s;
    v.modSettings.r = v.locks['modenv.release'] ?? settings.modEnv.r;
    v.filterSettings.a =
      v.locks['filter.attack'] !== undefined ? knobTime(v.locks['filter.attack']) : settings.env.a;
    v.filterSettings.d =
      v.locks['filter.decay'] !== undefined ? knobTime(v.locks['filter.decay']) : settings.env.d;
    v.filterSettings.s = v.locks['filter.sustain'] ?? settings.env.s;
    v.filterSettings.r =
      v.locks['filter.release'] !== undefined
        ? knobTime(v.locks['filter.release'])
        : settings.env.r;
    if (p.acid && v.accent) v.filterSettings.d = 0.2;
    v.env.coefficients(v.filterSettings, sr);
    v.modEnvelope.coefficients(v.modSettings, sr);
  };
  // Envelope recording: every voice lifetime is written to the sink when it ends.
  const sink = processing.envelopes;
  let now = 0;
  const sample = (v: Voice, amplitude: number, filter: number) => {
    v.record!.amplitude.push({ sample: now, value: amplitude, curve: 'linear' });
    v.record!.filter.push({ sample: now, value: filter, curve: 'linear' });
  };
  const close = (v: Voice) => {
    if (!v.record) return;
    if (v.record.amplitude.at(-1)?.sample !== now) sample(v, v.amp.value, v.env.value);
    sink!.push({
      ...v.record,
      end: now,
      amplitude: simplifyLane(v.record.amplitude, envelopeTolerance),
      filter: simplifyLane(v.record.filter, envelopeTolerance),
    });
    v.record = undefined;
  };
  const on = (
    id: string,
    pitch: number,
    velocity: number,
    resume = false,
    pan?: number,
    sends?: Record<string, number>,
    locks?: Record<string, number>,
    paths?: VoicePath[],
    grainSamples = 0,
    panOffset = 0,
  ) => {
    noteHz = hz(pitch);
    const legato = p.mono && held.length > 0;
    const previousPitch = held.at(-1)?.pitch;
    if (!resume) {
      report.notes++;
      held.push({ id, pitch, velocity, pan, panOffset, grainSamples, sends, locks, paths });
      if (legato) {
        if (pitch !== previousPitch) report.slides++;
      } else report.retriggers++;
    }
    let v = voices[0];
    if (
      grainSamples &&
      voices.every((v) => v.active && v.grainSamples && v.age * sr < v.grainSamples)
    )
      throw new RangeError('Grain overlap exceeds 256 voices; reduce count or size');
    if (!p.mono)
      v =
        voices.find((v) => !v.active) ??
        voices.filter((v) => !v.held).sort((a, b) => b.age - a.age)[0] ??
        voices.reduce((a, b) => (a.age > b.age ? a : b));
    if (!v.active) activeCount++;
    if (sink) {
      close(v);
      v.record = { id, on: now, amplitude: [], filter: [] };
    }
    v.id = id;
    v.pan = pan;
    v.panOffset = panOffset;
    v.locks = { ...locks };
    v.paths = paths ?? [];
    v.pathStart = v.age;
    v.grainSamples = grainSamples;
    v.throws = noteThrows(routes, sends);
    v.target = pitch;
    v.velocity = velocity;
    v.held = true;
    v.active = true;
    if (!legato || !v.amp.stage) {
      v.note = pitch;
      v.age = 0;
      v.pathStart = 0;
      v.ringPhase = 0;
      const ratio = v.locks['lfo.ratio'] ?? settings.lfoRatio;
      const rate =
        v.locks['lfo.hz'] ??
        (v.locks['lfo.rate'] !== undefined
          ? 0.05 * 40000 ** v.locks['lfo.rate']
          : settings.lfoRate);
      v.lfoCycles =
        (v.locks['lfo.trigger'] ?? settings.lfoTrigger)
          ? 0
          : (((events[cursor - 1]?.sample ?? 0) - songStartSample) / sr) *
            (ratio > 0 ? hz(pitch) * ratio : rate);
      v.lfoSmooth = 0;
      v.lfoSeed = seedHash(`${seed}/${id}`);
      const ratio2 = v.locks['lfo2.ratio'] ?? settings.lfo2Ratio;
      v.lfo2Cycles =
        (v.locks['lfo2.trigger'] ?? settings.lfo2Trigger)
          ? 0
          : (((events[cursor - 1]?.sample ?? 0) - songStartSample) / sr) *
            (ratio2 > 0 ? hz(pitch) * ratio2 : (v.locks['lfo2.hz'] ?? settings.lfo2Hz));
      v.modEnvelope.on();
      v.amp.on();
      v.env.on();
      v.index.on();
      v.accent = p.acid && Math.round(velocity * 127) >= 100;
      if (v.accent) {
        charge = Math.min(1, charge + 0.35);
        report.accents++;
      }
      v.drift = (random() * 2 - 1) * p.drift;
      if (v.string)
        v.string.trigger(
          hz(pitch + settings.bend * settings.bendRange + v.drift / 100),
          settings.pluckDamping,
          settings.pluckDecay,
          settings.pluckBrightness,
          settings.pluckPick,
          random,
        );
      v.vowelFilter?.reset();
    }
    v.glideRemaining = legato && settings.glide > 0 ? Math.round(settings.glide * sr) : 0;
    v.glideCoef = v.glideRemaining ? Math.exp(-Math.log(100) / v.glideRemaining) : 0;
    if (!v.glideRemaining) v.note = pitch;
    v.amp.coefficients(p.acid ? { a: 0.003, d: 0.2, s: 1, r: 0.008 } : settings.amp, sr);
    v.env.coefficients(p.acid && v.accent ? { ...settings.env, d: 0.2 } : settings.env, sr);
    v.index.coefficients(p.fmEnv, sr);
    updateVoiceEnvelopes(v);
  };
  let first = events.find((e) => e.type === 'on')?.sample ?? out.left.length;
  let lastActivity = first;
  for (let i = 0; i < out.left.length; i++) {
    now = i;
    while (cutCursor < (processing.cuts?.length ?? 0) && processing.cuts![cutCursor] <= i) {
      cutCursor++;
      chain.reset();
      combL.fill(0);
      combR.fill(0);
      chorus.fill(0);
    }
    while (cursor < events.length && events[cursor].sample <= i) {
      const e = events[cursor++];
      if (e.type === 'set') {
        control(e.name, e.value);
        if (['lfo.rate', 'lfo.hz'].includes(e.name) && e.phaseAnchor !== false)
          cycles = ((i - songStartSample) / sr) * settings.lfoRate;
      } else if (e.type === 'on')
        on(
          e.id,
          e.pitch,
          e.velocity,
          false,
          e.pan,
          e.sends,
          e.locks,
          e.paths,
          e.grainSamples,
          e.panOffset,
        );
      else {
        const index = held.findIndex((n) => n.id === e.id);
        if (index >= 0) held.splice(index, 1);
        for (const v of voices)
          if (v.active && v.id === e.id) {
            if (p.mono && held.length) {
              const n = held.at(-1)!;
              on(
                n.id,
                n.pitch,
                n.velocity,
                true,
                n.pan,
                n.sends,
                n.locks,
                n.paths,
                n.grainSamples,
                n.panOffset,
              );
            } else {
              // The release starts here: record the corner exactly, not at the next grid point.
              if (v.record && v.record.amplitude.at(-1)?.sample !== i)
                sample(v, v.amp.value, v.env.value);
              v.held = false;
              v.amp.off();
              v.env.off();
              v.index.off();
              v.modEnvelope.off();
            }
          }
      }
    }
    const songTime = (i - songStartSample) / sr;
    lfoPhase = cycles - Math.floor(cycles);
    const lfoWave = modulationWave(lfoPhase, settings.lfoShape, Math.floor(cycles), seed);
    cycles += settings.lfoRate / sr;
    if (
      !processing.inserts?.length &&
      !activeCount &&
      i - lastActivity >
        Math.max(
          p.chorus ? chorusSize : 0,
          settings.combMix
            ? sr *
                (settings.combTime + settings.combDepth) *
                (Math.abs(settings.combFeedback) > 0
                  ? Math.log(0.00001) / Math.log(Math.abs(settings.combFeedback))
                  : 1)
            : 0,
        )
    )
      continue;
    charge *= 0.99993056; // 300 ms at 48 kHz
    smoothCut += smoothing * (settings.cutoff - smoothCut);
    smoothGain += smoothing * (settings.level * settings.levelDb - smoothGain);
    smoothPan += smoothing * (settings.pan - smoothPan);
    smoothBend += smoothing * (settings.bend * settings.bendRange - smoothBend);
    let left = 0,
      right = 0;
    const partX = world ? worldX.at(i) : 0,
      partY = world ? worldY.at(i) : 0,
      partZ = world ? worldZ.at(i) : 0,
      basis = world ? pose.at(i) : undefined;
    // World-frame sources are loud or quiet where they are, so member level is applied before
    // propagation. Head-locked members keep it as a listener-side fader, as before.
    const sourceGain = world ? smoothGain : 1,
      listenerGain = world ? 1 : smoothGain;
    for (const v of voices) {
      if (!v.active) continue;
      if (v.glideRemaining > 0) {
        v.note = v.target + (v.note - v.target) * v.glideCoef;
        if (--v.glideRemaining === 0) v.note = v.target;
      }
      const lock = v.locks;
      for (const path of v.paths)
        lock[path.name] = interpolate(
          path.from,
          path.to,
          ((v.age - v.pathStart) * sr) / Math.max(1, path.samples),
          path.curve,
        );
      const lfoRatio = lock['lfo.ratio'] ?? settings.lfoRatio;
      const lfoRate =
        lock['lfo.hz'] ??
        (lock['lfo.rate'] !== undefined ? 0.05 * 40000 ** lock['lfo.rate'] : settings.lfoRate);
      const lfoTrigger = lock['lfo.trigger'] ?? settings.lfoTrigger;
      const lfoOffset = lock['lfo.phase'] ?? settings.lfoOffset;
      const lfoPitch = lock['lfo.pitch'] ?? settings.lfoPitch;
      const lfoCutoff = lock['lfo.cutoff'] ?? settings.lfoCutoff;
      const lfoAmp = lock['lfo.amp'] ?? settings.lfoAmp;
      const lfoPan = lock['lfo.pan'] ?? settings.lfoPan;
      const lfoShape =
        lock['lfo.shape'] !== undefined ? Math.round(lock['lfo.shape'] * 4) : settings.lfoShape;
      const tracked =
        lfoRatio > 0 ||
        lfoTrigger > 0 ||
        lock['lfo.hz'] !== undefined ||
        lock['lfo.rate'] !== undefined;
      const voiceCycles = (tracked ? v.lfoCycles : cycles - settings.lfoRate / sr) + lfoOffset;
      const rawWave =
        tracked || lfoOffset
          ? modulationWave(
              voiceCycles - Math.floor(voiceCycles),
              lfoShape,
              Math.floor(voiceCycles),
              tracked ? v.lfoSeed : seed,
            )
          : lfoShape === settings.lfoShape
            ? lfoWave
            : modulationWave(lfoPhase, lfoShape, Math.floor(cycles - settings.lfoRate / sr), seed);
      const slew = lock['lfo.slew'] ?? settings.lfoSlew;
      if (slew !== v.oldSlew) {
        v.oldSlew = slew;
        v.slewCoef = slew > 0 ? Math.exp(-1 / (sr * slew)) : 0;
      }
      v.lfoSmooth = rawWave + v.slewCoef * (v.lfoSmooth - rawWave);
      const delay = lock['lfo.delay'] ?? settings.lfoDelay,
        fadeTime = lock['lfo.fade'] ?? settings.lfoFade;
      const fade = v.age < delay ? 0 : fadeTime > 0 ? Math.min(1, (v.age - delay) / fadeTime) : 1;
      const modEnv =
        v.modEnvelope.next(v.modSettings, sr) ** (lock['modenv.curve'] ?? settings.modCurve);
      const modLfo = lock['modenv.lfo'] ?? settings.modLfo;
      const voiceWave =
        v.lfoSmooth * fade * (modLfo >= 0 ? 1 - modLfo + modLfo * modEnv : 1 + modLfo * modEnv);
      v.lfoCycles +=
        (lfoRatio > 0 ? Math.min(5000, hz(v.note + smoothBend) * lfoRatio) : lfoRate) / sr;
      const phase2 = v.lfo2Cycles + (lock['lfo2.phase'] ?? settings.lfo2Offset);
      const secondActive =
        settings.lfo2Pitch ||
        settings.lfo2Cutoff ||
        settings.lfo2Amp ||
        settings.lfo2Pan ||
        lock['lfo2.pitch'] ||
        lock['lfo2.cutoff'] ||
        lock['lfo2.amp'] ||
        lock['lfo2.pan'] ||
        secondRouting.some((name) => lock[name] || settings.routing[name]);
      const secondWave = secondActive
        ? modulationWave(
            phase2 - Math.floor(phase2),
            Math.round((lock['lfo2.shape'] ?? settings.lfo2Shape) * 4),
            Math.floor(phase2),
            v.lfoSeed ^ 12345,
          ) * Math.max(0, 1 + voiceWave * (lock['lfo2.depthMod'] ?? settings.lfo2DepthMod))
        : 0;
      const ratio2 = lock['lfo2.ratio'] ?? settings.lfo2Ratio;
      v.lfo2Cycles +=
        Math.min(
          5000,
          (ratio2 > 0 ? hz(v.note + smoothBend) * ratio2 : (lock['lfo2.hz'] ?? settings.lfo2Hz)) *
            2 ** (voiceWave * (lock['lfo2.rateMod'] ?? settings.lfo2RateMod)),
        ) / sr;
      if ((i & 63) === 0) {
        v.vowelFilter?.tune(
          settings.vowel + voiceWave * (lock['lfo.vowel'] ?? settings.lfoVowel),
          settings.formantShift,
          settings.formantResonance,
        );
        v.amp.coefficients(p.acid ? { a: 0.003, d: 0.2, s: 1, r: 0.008 } : settings.amp, sr);
        v.env.coefficients(p.acid && v.accent ? { ...settings.env, d: 0.2 } : settings.env, sr);
        updateVoiceEnvelopes(v);
      }
      const amp = v.amp.next(p.acid ? acidAmp : settings.amp, sr);
      const env = v.env.next(v.filterSettings, sr);
      const indexEnv = v.index.next(p.fmEnv, sr);
      if (
        amp < 0.00001 &&
        !v.held &&
        !v.spatial?.pending &&
        (!v.grainSamples || v.age * sr >= v.grainSamples)
      ) {
        v.active = false;
        activeCount--;
        close(v);
        continue;
      }
      lastActivity = i;
      const vibrato = settings.mod
        ? (Math.sin(TAU * 5.5 * v.age) *
            settings.mod *
            Math.min(1, Math.max(0, (v.age - p.vibDelay) / Math.max(0.001, p.vibFade)))) /
          100
        : 0;
      const note =
        v.note +
        ((lock.pitch ?? 0) + (lock.cents ?? 0)) / 100 +
        smoothBend +
        vibrato +
        (voiceWave * lfoPitch +
          secondWave * (lock['lfo2.pitch'] ?? settings.lfo2Pitch) +
          modEnv * (lock['modenv.pitch'] ?? settings.modPitch)) /
          100;
      const cutoff = clamp(
        (lock.cutoff !== undefined
          ? p.acid
            ? 60 * (8000 / 60) ** lock.cutoff
            : 20 * 1000 ** lock.cutoff
          : smoothCut) *
          2 **
            ((lock.envamount !== undefined ? lock.envamount * 6 : settings.envamount) * env +
              (v.accent ? 1.5 * env : 0) +
              charge +
              voiceWave * (lock['lfo.amount'] ?? settings.lfoAmount) * p.lfoDepth +
              voiceWave * lfoCutoff +
              secondWave * (lock['lfo2.cutoff'] ?? settings.lfo2Cutoff) +
              modEnv * (lock['modenv.cutoff'] ?? settings.modCutoff) +
              (settings.keytrack * (note - 60)) / 12),
        20,
        18000,
      );
      // TPT state-variable stages: stable at high resonance and cutoff.
      let g = Math.tan((Math.PI * cutoff) / (sr * 2));
      const k = Math.max(
        0.09,
        2 *
          (1 -
            clamp(
              (lock.resonance ?? settings.resonance) +
                voiceWave * (lock['lfo.resonance'] ?? settings.lfoResonance),
              0,
              1,
            ) *
              0.96),
      );
      let a1 = 1 / (1 + g * (g + k)),
        a2 = g * a1,
        a3 = g * a2;
      const velocityGain = p.acid
        ? v.accent
          ? 2
          : 1
        : 1 - settings.velSens + settings.velSens * v.velocity ** 1.5;
      const drive = 1 + settings.drive * 5;
      const amDepth = Math.abs(lfoAmp);
      const am = 1 - amDepth + amDepth * (lfoAmp < 0 ? voiceWave : (1 + voiceWave) * 0.5);
      const am2 = lock['lfo2.amp'] ?? settings.lfo2Amp;
      const gain2 =
        1 - Math.abs(am2) + Math.abs(am2) * (am2 < 0 ? secondWave : (1 + secondWave) * 0.5);
      if (v.grainSamples && v.age * sr >= v.grainSamples && !v.spatial?.pending) {
        v.active = false;
        activeCount--;
        close(v);
        continue;
      }
      const grainGain = v.grainSamples
        ? v.age * sr >= v.grainSamples
          ? 0
          : Math.sin((Math.PI * v.age * sr) / v.grainSamples) ** 2
        : 1;
      if (v.record && (i - v.record.on) % envelopeGrid === 0)
        sample(v, v.grainSamples ? grainGain : amp, env);
      const noteGain =
        (lock.level !== undefined ? lock.level ** 2 : 1) * 10 ** ((lock['level.db'] ?? 0) / 20);
      const gain =
        ((v.grainSamples ? 1 : amp) * velocityGain * p.trim * am * gain2 * noteGain * grainGain) /
        p.unison;
      const base = hz(note + v.drift / 100);
      const fmIndex = clamp(
        (lock['fm.index'] ?? (p.mode === 'fm' ? settings.fmIndex : settings.analogFM)) +
          routed(v, 'fm.index', voiceWave, secondWave, modEnv),
        0,
        20,
      );
      const fold = clamp(
        (lock.fold ?? settings.fold) + routed(v, 'fold', voiceWave, secondWave, modEnv),
        0,
        1,
      );
      const sync = lock.sync ?? settings.sync;
      const syncRatio = clamp(
        (lock['sync.ratio'] ?? settings.syncRatio) *
          2 ** routed(v, 'sync.ratio', voiceWave, secondWave, modEnv),
        1,
        16,
      );
      const filterFM = clamp(
        (lock['filter.fm'] ?? settings.filterFM) +
          routed(v, 'filter.fm', voiceWave, secondWave, modEnv),
        0,
        4,
      );
      const detune = settings.detune + voiceWave * (lock['lfo.detune'] ?? settings.lfoDetune);
      const width = clamp(
        (lock.pw ?? settings.pw) + routed(v, 'pw', voiceWave, secondWave, modEnv),
        0.02,
        0.98,
      );
      const wave1 = clamp(
        settings.wave1 + voiceWave * (lock['lfo.wave'] ?? settings.lfoWaveDepth),
        0,
        1,
      );
      let vl = 0,
        vr = 0;
      for (let u = 0; u < p.unison; u++) {
        const spread = p.unison === 1 ? 0 : u / (p.unison - 1) - 0.5;
        const f1 = base * 2 ** ((settings.fine1 + spread * detune) / 1200);
        const f2 = fmIndex
          ? f1 * settings.fmRatio
          : base *
            2 **
              (settings.coarse2 / 12 +
                (settings.fine2 + (p.unison === 1 ? detune : spread * detune)) / 1200);
        let signal = 0;
        if (p.mode === 'pluck') {
          v.string!.tune(f1, settings.pluckDamping, settings.pluckDecay);
          signal = v.string!.next();
        } else if (p.mode === 'fm') {
          const idx = fmIndex * indexEnv * (1 - p.fmVel + p.fmVel * v.velocity);
          signal = settings.osc1 * Math.sin(TAU * v.phase[u] + idx * Math.sin(TAU * v.phase2[u]));
        } else
          signal =
            settings.osc1 *
              oscillator(
                fmIndex
                  ? (v.phase[u] + (fmIndex * Math.sin(TAU * v.phase2[u])) / TAU + 100) % 1
                  : v.phase[u],
                Math.min(0.49, f1 / sr),
                wave1,
                width,
              ) +
            settings.osc2 *
              oscillator(
                v.phase2[u],
                Math.min(0.49, (sync ? f1 * syncRatio : f2) / sr),
                settings.wave2,
                width,
              );
        if (settings.sub)
          signal +=
            settings.sub *
            (p.subWave === 'sine'
              ? Math.sin(TAU * v.subPhase[u])
              : oscillator(v.subPhase[u], f1 / (2 * sr), 1, 0.5));
        if (settings.noise) signal += settings.noise * (random() * 2 - 1);
        v.phase[u] += f1 / sr;
        const wrapped = v.phase[u] >= 1;
        v.phase[u] -= Math.floor(v.phase[u]);
        v.phase2[u] +=
          (p.mode === 'fm'
            ? f1 * settings.fmRatio * 2 ** (settings.coarse2 / 12 + settings.fine2 / 1200)
            : sync
              ? f1 * syncRatio
              : f2) / sr;
        v.phase2[u] -= Math.floor(v.phase2[u]);
        if (wrapped && sync && p.mode === 'analog') v.phase2[u] = (v.phase[u] * syncRatio) % 1;
        v.subPhase[u] += f1 / (2 * sr);
        v.subPhase[u] -= Math.floor(v.subPhase[u]);
        if (fold)
          signal = (2 / Math.PI) * Math.asin(Math.sin((signal * (1 + fold * 8) * Math.PI) / 2));
        if (filterFM) {
          const fm =
            p.mode === 'fm'
              ? Math.sin(TAU * v.phase[u] + fmIndex * Math.sin(TAU * v.phase2[u]))
              : oscillator(v.phase[u], Math.min(0.49, f1 / sr), wave1, width);
          g = Math.tan((Math.PI * clamp(cutoff * 2 ** (filterFM * fm), 20, 18000)) / (sr * 2));
          a1 = 1 / (1 + g * (g + k));
          a2 = g * a1;
          a3 = g * a2;
        }
        if (!p.acid && settings.drive) signal = saturate(signal * drive) * 1.5;
        if (v.vowelFilter) signal = v.vowelFilter.next(signal);
        let filtered = signal;
        for (let os = 0; os < 2; os++) {
          const v3 = signal - v.low[u],
            v1 = a1 * v.band[u] + a2 * v3,
            v2 = v.low[u] + a2 * v.band[u] + a3 * v3;
          v.band[u] = 2 * v1 - v.band[u];
          v.low[u] = 2 * v2 - v.low[u];
          const high = signal - k * v1 - v2;
          filtered =
            settings.filterType === 2 || settings.filterType === 3
              ? high
              : settings.filterType === 4
                ? v1
                : settings.filterType === 5
                  ? high + v2
                  : v2;
          if (settings.filterType === 1 || settings.filterType === 3 || settings.filterType === 6) {
            const w3 = filtered - v.low2[u],
              w1 = a1 * v.band2[u] + a2 * w3,
              w2 = v.low2[u] + a2 * v.band2[u] + a3 * w3;
            v.band2[u] = 2 * w1 - v.band2[u];
            v.low2[u] = 2 * w2 - v.low2[u];
            filtered =
              settings.filterType === 6
                ? 0.5 * (filtered + w2)
                : settings.filterType === 3
                  ? filtered - k * w1 - w2
                  : w2;
          }
        }
        if (p.acid && settings.drive) filtered = saturate(filtered * drive) * 1.5;
        const pos = spread * settings.width;
        vl += filtered * (1 - pos) * gain;
        vr += filtered * (1 + pos) * gain;
      }
      if (settings.ringMix) {
        const carrier = settings.ringHz
          ? Math.sin(TAU * songTime * settings.ringHz)
          : Math.sin(TAU * v.ringPhase);
        const ringGain = 1 - settings.ringMix + settings.ringMix * carrier;
        vl *= ringGain;
        vr *= ringGain;
      }
      v.ringPhase = (v.ringPhase + (base * settings.ringRatio) / sr) % 1;
      const pan = clamp(
        (lock.pan ?? v.pan ?? smoothPan) +
          v.panOffset +
          voiceWave * lfoPan +
          secondWave * (lock['lfo2.pan'] ?? settings.lfo2Pan),
        -1,
        1,
      );
      const voiceLeft = vl * Math.cos(((pan + 1) * Math.PI) / 4),
        voiceRight = vr * Math.sin(((pan + 1) * Math.PI) / 4);
      let spatialLeft = voiceLeft,
        spatialRight = voiceRight;
      const space = processing.space;
      if (
        space &&
        (basis ||
          space.output !== 'stereo' ||
          space.distance ||
          Object.keys(spatialControls).length ||
          Object.keys(lock).some((k) => k.startsWith('space.')))
      ) {
        const spatial = (v.spatial ??= new SpatialVoice(sr));
        if (basis)
          relativeToListener(
            lock['space.x'] ?? partX,
            lock['space.y'] ?? partY,
            lock['space.z'] ?? partZ,
            basis,
            relative,
          );
        spatial.process(
          (vl + vr) * 0.5 * sourceGain,
          basis ? relative.azimuth : (lock['space.az'] ?? spatialControls['space.az'] ?? pan * 90),
          basis ? relative.elevation : (lock['space.el'] ?? spatialControls['space.el'] ?? 0),
          basis ? relative.distance : (lock['space.dist'] ?? spatialControls['space.dist'] ?? 1),
          space,
        );
        spatialLeft = spatial.left;
        spatialRight = spatial.right;
        const masterGain = mix.gain * listenerGain;
        if (out.ambisonic)
          for (let ch = 0; ch < 4; ch++)
            out.ambisonic[ch][i] += spatial.mono * spatial.direction[ch] * masterGain;
        if (space.room && out.buses?.[space.room]) {
          out.buses[space.room].left[i] += spatialLeft * spatial.send * masterGain;
          out.buses[space.room].right[i] += spatialRight * spatial.send * masterGain;
        }
      }
      left += spatialLeft;
      right += spatialRight;
      throwAudio(v.throws, i, spatialLeft, spatialRight, mix.gain * listenerGain);
      v.age += 1 / sr;
    }
    const spatialDryMono = (left + right) * 0.5;
    if (p.hp) {
      hpLeft = hpCoef * (hpLeft + left - hpInL);
      hpInL = left;
      left = hpLeft;
      hpRight = hpCoef * (hpRight + right - hpInR);
      hpInR = right;
      right = hpRight;
    }
    if (settings.combMix) {
      const delay = clamp(
        sr *
          (settings.combTime + settings.combDepth * Math.sin(TAU * songTime * settings.combRate)),
        1,
        combL.length - 2,
      );
      const at = (combPos - delay + combL.length) % combL.length,
        j = Math.floor(at),
        f = at - j;
      const dl = combL[j] * (1 - f) + combL[(j + 1) % combL.length] * f;
      const dr = combR[j] * (1 - f) + combR[(j + 1) % combR.length] * f;
      combL[combPos] = left + dl * settings.combFeedback;
      combR[combPos] = right + dr * settings.combFeedback;
      combPos = (combPos + 1) % combL.length;
      left = left * (1 - settings.combMix) + dl * settings.combMix;
      right = right * (1 - settings.combMix) + dr * settings.combMix;
    }
    if (p.chorus) {
      chorus[chorusPos] = (left + right) * 0.5;
      const phase = (TAU * p.chorusRate * i) / sr;
      const d1 = sr * (0.012 + 0.004 * p.chorusDepth * Math.sin(phase));
      const d2 = sr * (0.015 + 0.004 * p.chorusDepth * Math.cos(phase));
      const read = (delay: number) => {
        const t = (chorusPos - delay + chorusSize) % chorusSize,
          j = Math.floor(t),
          f = t - j;
        return chorus[j] * (1 - f) + chorus[(j + 1) % chorusSize] * f;
      };
      left = left * (1 - p.chorus * 0.5) + read(d1) * p.chorus;
      right = right * (1 - p.chorus * 0.5) + read(d2) * p.chorus;
      chorusPos = (chorusPos + 1) % chorusSize;
    }
    if (processing.inserts?.length) {
      chain.process(left, right, i, noteHz);
      left = chain.left;
      right = chain.right;
    }
    if (out.ambisonic)
      out.ambisonic[0][i] +=
        ((left + right) * 0.5 - spatialDryMono) * Math.SQRT2 * mix.gain * (world ? 1 : smoothGain);
    const preLeft = left,
      preRight = right;
    left *= mix.gain * (world ? 1 : smoothGain);
    right *= mix.gain * (world ? 1 : smoothGain);
    report.peak = Math.max(report.peak, Math.abs(left), Math.abs(right));
    out.left[i] += left;
    out.right[i] += right;
    if (routes.length) sendAudio(routes, i, preLeft, preRight, left, right);
    else {
      out.room[i] += (left + right) * 0.5 * settings.room;
      out.echo[i] += (left + right) * 0.5 * settings.echo;
    }
  }
  now = out.left.length;
  for (const v of voices) close(v);
  return report;
}
const acidAmp: Envelope = { a: 0.003, d: 0.2, s: 1, r: 0.008 };

export function modulationWave(phase: number, shape: number, cycle: number, seed: number): number {
  if (shape === 1) return 1 - 4 * Math.abs(phase - 0.5);
  if (shape === 2) return phase < 0.5 ? 1 : -1;
  if (shape === 3) return 2 * phase - 1;
  if (shape === 4) {
    let h = Math.imul((cycle | 0) ^ seed, 0x45d9f3b);
    h ^= h >>> 16;
    return (h >>> 0) / 2147483648 - 1;
  }
  return Math.sin(TAU * phase);
}
