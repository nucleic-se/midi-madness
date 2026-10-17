import { createEqualizer } from './equalizer.ts';
import { createLevelMeter, stageGain } from './metering.ts';
import type { Stage } from './buses.ts';

export type EffectType =
  | 'delay'
  | 'reverb'
  | 'filter'
  | 'autofilter'
  | 'drive'
  | 'eq'
  | 'crush'
  | 'chorus'
  | 'phaser'
  | 'flanger'
  | 'tremolo'
  | 'autopan'
  | 'gate'
  | 'comb'
  | 'ring';
export type Param = {
  initial: number;
  min: number;
  max: number;
  scale?: 'exp';
  unit?: 'hz' | 'time' | 'db';
  choices?: string[];
};
const p = (initial: number, min = 0, max = 1): Param => ({ initial, min, max });
const freq = (initial: number, max = 20000): Param => ({
  initial,
  min: 20,
  max,
  scale: 'exp',
  unit: 'hz',
});
const time = (initial: number, min = 0.0001, max = 1): Param => ({
  initial,
  min,
  max,
  scale: 'exp',
  unit: 'time',
});
const shape = (): Param => ({
  ...p(0, 0, 4),
  choices: ['sine', 'triangle', 'square', 'saw', 'sample-and-hold'],
});
const rate = (): Param => ({ initial: 2, min: 0.01, max: 5000, scale: 'exp', unit: 'hz' });
const filter = () => ({
  cutoff: freq(1800),
  resonance: p(0.2),
  drive: p(0),
  type: { ...p(0, 0, 6), choices: ['lp12', 'lp24', 'hp12', 'hp24', 'bp', 'notch', 'peak'] },
});
export const effectParams: Record<EffectType, Record<string, Param>> = {
  delay: {
    time: time(0.375, 0.001, 10),
    feedback: p(0.35, 0, 0.98),
    tone: freq(4000),
    pingpong: p(0.6),
  },
  reverb: {
    decay: time(2.2, 0.05, 30),
    predelay: { ...p(0.025, 0, 2), unit: 'time' },
    size: p(0.7),
    damping: freq(6000),
    mod: p(0),
  },
  filter: filter(),
  autofilter: { ...filter(), rate: rate(), depth: p(1, 0, 4), shape: shape() },
  eq: {
    type: { ...p(0, 0, 2), choices: ['bell', 'low-shelf', 'high-shelf'] },
    frequency: freq(1000),
    gain: { ...p(0, -24, 24), unit: 'db' },
    q: p(Math.SQRT1_2, 0.1, 18),
    slope: p(1, 0.1, 1),
  },
  drive: {
    makeup: { ...p(0), choices: ['off', 'auto'] },
    amount: p(0.3),
    tone: freq(9000),
    model: { ...p(0, 0, 2), choices: ['soft', 'tube', 'hard'] },
  },
  crush: { bits: p(8, 1, 16), rate: { ...freq(11000, 48000), min: 1 }, jitter: p(0) },
  chorus: {
    rate: { ...rate(), initial: 0.3, max: 20 },
    depth: p(0.5),
    voices: p(2, 2, 4),
    width: p(0.8),
  },
  phaser: {
    rate: { ...rate(), initial: 0.2, max: 20 },
    stages: p(6, 4, 12),
    center: freq(800),
    depth: p(2, 0, 4),
    feedback: p(0.35, -0.95, 0.95),
    width: p(0.7),
  },
  flanger: {
    time: time(0.003, 0.00002, 0.03),
    rate: { ...rate(), initial: 0.2, max: 20 },
    depth: { ...p(0.002, 0, 0.01), unit: 'time' },
    feedback: p(0.5, -0.95, 0.95),
    width: p(0.7),
  },
  tremolo: { rate: rate(), depth: p(0.5), shape: shape() },
  autopan: { rate: { ...rate(), initial: 0.25 }, depth: p(0.8), shape: shape(), phase: p(0.5) },
  gate: { rate: rate(), attack: time(0.003), release: time(0.015), depth: p(1) },
  comb: {
    time: time(1 / 261.625565, 0.0002, 2),
    feedback: p(0.4, -0.95, 0.95),
    depth: p(0, 0, 0.01),
    rate: { ...rate(), initial: 0.2, max: 20 },
  },
  ring: { hz: { ...rate(), initial: 440 }, ratio: p(0, 0, 32) },
};
export function nativeEffectValue(type: EffectType, field: string, v: number): number {
  if (field === 'mix' || field === 'bypass') return Math.max(0, Math.min(1, v));
  const d = effectParams[type][field];
  if (!d) throw new RangeError(`Unknown ${type} parameter ${field}`);
  if (field === 'feedback') return Math.max(d.min, Math.min(d.max, v));
  return d.scale === 'exp' ? d.min * (d.max / d.min) ** v : d.min + (d.max - d.min) * v;
}
export function normalizedEffectValue(type: EffectType, field: string, v: number): number {
  if (field === 'mix' || field === 'bypass' || field === 'feedback') return v;
  const d = effectParams[type][field];
  return d.scale === 'exp'
    ? Math.log(v / d.min) / Math.log(d.max / d.min)
    : (v - d.min) / (d.max - d.min);
}
const tau = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
function tap(a: Float32Array, pos: number, delay: number) {
  let t = pos - delay;
  if (t < 0) t += a.length;
  if (t >= a.length) t -= a.length;
  const j = Math.floor(t),
    f = t - j;
  return a[j] * (1 - f) + a[j + 1 === a.length ? 0 : j + 1] * f;
}
function wave(phase: number, shape: number, seed: number) {
  const t = phase - Math.floor(phase);
  switch (Math.round(shape)) {
    case 1:
      return 1 - 4 * Math.abs(t - 0.5);
    case 2:
      return t < 0.5 ? 1 : -1;
    case 3:
      return 2 * t - 1;
    case 4:
      return (Math.imul(Math.floor(phase) ^ seed, 0x45d9f3b) >>> 0) / 2147483648 - 1;
    default:
      return Math.sin(tau * t);
  }
}
export function createProcessor(stage: Stage, sr: number, seed = 1, offset = 0) {
  const params = { ...stage.params };
  const type = stage.type;
  const equalizer = type === 'eq' ? createEqualizer(sr) : undefined;
  const size =
    type === 'delay'
      ? sr * 10 + 2
      : type === 'comb'
        ? sr * 2 + 2
        : type === 'chorus' || type === 'flanger'
          ? Math.ceil(sr * 0.05)
          : 2;
  const l = new Float32Array(size),
    r = new Float32Array(size);
  const low = new Float64Array(4),
    band = new Float64Array(4);
  const allpassL = new Float64Array(12),
    allpassR = new Float64Array(12);
  const coefficientsL = new Float64Array(12),
    coefficientsR = new Float64Array(12);
  let feedbackL = 0,
    feedbackR = 0,
    stageCount = 0;
  let pos = 0,
    holdPhase = 1,
    heldL = 0,
    heldR = 0,
    gate = 1,
    smoothTime = params.time ?? 0,
    phase = 0,
    g = 0,
    oldCutoff = -1,
    oldTone = -1,
    toneCoef = 0;
  let randomState = seed || 1;
  const random = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) / 4294967296;
  };
  const smooth = 1 - Math.exp(-1 / (sr * 0.02));
  const filterChannel = (x: number, index: number, k: number, mode: number) => {
    const a = 1 / (1 + g * (g + k));
    const v1 = a * (band[index] + g * (x - low[index])),
      v2 = low[index] + g * v1;
    band[index] = 2 * v1 - band[index];
    low[index] = 2 * v2 - low[index];
    const high = x - k * v1 - v2;
    return mode <= 1
      ? v2
      : mode <= 3
        ? high
        : mode === 4
          ? k * v1
          : mode === 5
            ? high + v2
            : v2 - high;
  };
  const processor = {
    params,
    left: 0,
    right: 0,
    pending() {
      if (type === 'phaser')
        return (
          Math.max(
            Math.abs(feedbackL),
            Math.abs(feedbackR),
            ...allpassL.map(Math.abs),
            ...allpassR.map(Math.abs),
          ) > 0.00001
        );
      if (!['delay', 'comb', 'chorus', 'flanger'].includes(type)) return false;
      const length =
        type === 'chorus' || type === 'flanger'
          ? size
          : Math.min(size, Math.ceil(params.time * sr) + 2);
      for (let n = 1; n <= length; n++) {
        const j = (pos - n + size) % size;
        if (Math.max(Math.abs(l[j]), Math.abs(r[j])) > 0.00001) return true;
      }
      return low.some((v) => Math.abs(v) > 0.00001);
    },
    reset() {
      equalizer?.reset();
      l.fill(0);
      r.fill(0);
      low.fill(0);
      band.fill(0);
      allpassL.fill(0);
      allpassR.fill(0);
      feedbackL = feedbackR = 0;
      heldL = heldR = 0;
      gate = 1;
    },
    process(left: number, right: number, sample: number, noteHz = 440) {
      const t = (sample - offset) / sr;
      if (params.rate !== undefined) {
        if (sample === 0) phase = t * params.rate;
        else phase += params.rate / sr;
      }
      let wl = left,
        wr = right;
      if (type === 'delay') {
        smoothTime += smooth * (params.time - smoothTime);
        const d = clamp(smoothTime * sr, 1, size - 2);
        wl = tap(l, pos, d);
        wr = tap(r, pos, d);
        if (params.tone !== oldTone) {
          oldTone = params.tone;
          toneCoef = 1 - Math.exp((-tau * params.tone) / sr);
          g = Math.tan((Math.PI * Math.min(params.tone, sr * 0.45)) / sr);
        }
        if (stage.tone === 'bp') {
          wl = filterChannel(wl, 0, Math.SQRT2, 4);
          wr = filterChannel(wr, 1, Math.SQRT2, 4);
        } else {
          low[0] += toneCoef * (wl - low[0]);
          low[1] += toneCoef * (wr - low[1]);
          wl = low[0];
          wr = low[1];
        }
        const w = params.pingpong,
          mono = (left + right) * 0.5;
        l[pos] =
          left * (1 - w) * 0.5 + mono * w + Math.tanh(params.feedback * (wl * (1 - w) + wr * w));
        r[pos] = right * (1 - w) * 0.5 + Math.tanh(params.feedback * (wr * (1 - w) + wl * w));
      } else if (type === 'comb') {
        const d = clamp(sr * (params.time + params.depth * Math.sin(tau * phase)), 1, size - 2);
        wl = tap(l, pos, d);
        wr = tap(r, pos, d);
        l[pos] = left + Math.tanh(wl * params.feedback);
        r[pos] = right + Math.tanh(wr * params.feedback);
      } else if (type === 'flanger') {
        smoothTime += smooth * (params.time - smoothTime);
        const ph = tau * phase;
        wl = tap(l, pos, clamp(sr * (smoothTime + params.depth * Math.sin(ph)), 1, size - 2));
        wr = tap(
          r,
          pos,
          clamp(
            sr * (smoothTime + params.depth * Math.sin(ph + (params.width * Math.PI) / 2)),
            1,
            size - 2,
          ),
        );
        l[pos] = left + Math.tanh(wl * params.feedback);
        r[pos] = right + Math.tanh(wr * params.feedback);
      } else if (type === 'phaser') {
        const count = Math.round(params.stages);
        if (count !== stageCount) {
          allpassL.fill(0);
          allpassR.fill(0);
          feedbackL = feedbackR = 0;
        }
        // Coefficients at 3 kHz (48 kHz audio); audio/state updates stay sample accurate.
        if (sample % 16 === 0 || count !== stageCount) {
          for (let j = 0; j < count; j++) {
            const spread = 3 * (j / (count - 1) - 0.5);
            const fl = clamp(
              params.center * 2 ** (spread + params.depth * Math.sin(tau * phase)),
              20,
              sr * 0.45,
            );
            const fr = clamp(
              params.center *
                2 ** (spread + params.depth * Math.sin(tau * phase + (params.width * Math.PI) / 2)),
              20,
              sr * 0.45,
            );
            const gl = Math.tan((Math.PI * fl) / sr),
              gr = Math.tan((Math.PI * fr) / sr);
            coefficientsL[j] = (gl - 1) / (gl + 1);
            coefficientsR[j] = (gr - 1) / (gr + 1);
          }
          stageCount = count;
        }
        wl = left + Math.tanh(feedbackL * params.feedback);
        wr = right + Math.tanh(feedbackR * params.feedback);
        for (let j = 0; j < count; j++) {
          const yl = coefficientsL[j] * wl + allpassL[j];
          const yr = coefficientsR[j] * wr + allpassR[j];
          allpassL[j] = wl - coefficientsL[j] * yl;
          allpassR[j] = wr - coefficientsR[j] * yr;
          wl = yl;
          wr = yr;
        }
        feedbackL = wl;
        feedbackR = wr;
      } else if (type === 'chorus') {
        l[pos] = left;
        r[pos] = right;
        wl = wr = 0;
        const voices = Math.round(params.voices);
        for (let v = 0; v < voices; v++) {
          const ph = tau * (phase + v / voices);
          wl += tap(l, pos, sr * (0.014 + 0.005 * params.depth * Math.sin(ph))) / voices;
          wr +=
            tap(
              r,
              pos,
              sr * (0.014 + 0.005 * params.depth * Math.sin(ph + (params.width * Math.PI) / 2)),
            ) / voices;
        }
      } else if (type === 'filter' || type === 'autofilter') {
        const cutoff = clamp(
          params.cutoff *
            (type === 'autofilter' ? 2 ** (params.depth * wave(phase, params.shape, seed)) : 1),
          20,
          Math.min(20000, sr * 0.45),
        );
        if (cutoff !== oldCutoff) {
          g = Math.tan((Math.PI * cutoff) / sr);
          oldCutoff = cutoff;
        }
        const k = Math.max(0.09, 2 * (1 - params.resonance * 0.96)),
          mode = Math.round(params.type);
        wl = filterChannel(Math.tanh(left * (1 + params.drive * 8)), 0, k, mode);
        wr = filterChannel(Math.tanh(right * (1 + params.drive * 8)), 1, k, mode);
        if (mode === 1 || mode === 3) {
          wl = filterChannel(wl, 2, k, mode);
          wr = filterChannel(wr, 3, k, mode);
        }
      } else if (type === 'eq') {
        equalizer!.process(
          left,
          right,
          params.frequency,
          params.gain,
          Math.round(params.type),
          params.q,
          params.slope,
        );
        wl = equalizer!.left;
        wr = equalizer!.right;
      } else if (type === 'drive') {
        const gain = 1 + params.amount * 30,
          model = Math.round(params.model);
        const distort = (x: number) =>
          model === 2
            ? clamp(x * gain, -1, 1)
            : model === 1
              ? Math.tanh(x * gain + 0.2) - Math.tanh(0.2)
              : Math.tanh(x * gain);
        if (params.tone !== oldTone) {
          oldTone = params.tone;
          toneCoef = 1 - Math.exp((-tau * params.tone) / sr);
        }
        // Default retains the legacy transfer, including its fixed trim.
        // Auto compensates the small-signal saturation gain, not measured LUFS.
        const trim =
          Math.round(params.makeup ?? 0) === 1
            ? 1 / (gain * (model === 1 ? 1 - Math.tanh(0.2) ** 2 : 1))
            : 1 / Math.sqrt(1 + params.amount * 10);
        low[0] += toneCoef * (distort(left) * trim - low[0]);
        low[1] += toneCoef * (distort(right) * trim - low[1]);
        wl = low[0];
        wr = low[1];
      } else if (type === 'crush') {
        holdPhase += params.rate / sr;
        if (holdPhase >= 1) {
          holdPhase %= 1;
          const levels = 2 ** (Math.round(params.bits) - 1);
          heldL = Math.round(left * levels) / levels;
          heldR = Math.round(right * levels) / levels;
          holdPhase -= params.jitter * random() * 0.5;
        }
        wl = heldL;
        wr = heldR;
      } else if (type === 'ring') {
        const carrier = Math.sin(tau * t * (params.ratio > 0 ? noteHz * params.ratio : params.hz));
        wl *= carrier;
        wr *= carrier;
      } else if (type === 'tremolo') {
        const gain = 1 - params.depth * (1 - wave(phase, params.shape, seed)) * 0.5;
        wl *= gain;
        wr *= gain;
      } else if (type === 'autopan') {
        const pl = wave(phase, params.shape, seed) * params.depth;
        const pr = wave(phase + params.phase, params.shape, seed) * params.depth;
        wl *= Math.sqrt(Math.max(0, 1 + pl));
        wr *= Math.sqrt(Math.max(0, 1 + pr));
      } else if (type === 'gate') {
        const pattern = stage.pattern ?? [1, 0, 1, 0];
        const target =
          pattern[((Math.floor(phase) % pattern.length) + pattern.length) % pattern.length];
        gate +=
          (1 - Math.exp(-1 / (sr * (target > gate ? params.attack : params.release)))) *
          (target - gate);
        const gain = 1 - params.depth + params.depth * gate;
        wl *= gain;
        wr *= gain;
      } else throw new RangeError(`Processor ${type} is not implemented`);
      if (++pos === size) pos = 0;
      processor.left = wl;
      processor.right = wr;
    },
  };
  return processor;
}

export function createInsertChain(
  stages: Stage[],
  sr: number,
  seed = 1,
  offset = 0,
  measureFrom = 0,
) {
  const nodes = stages.map((stage, i) => ({
    stage,
    processor: createProcessor(stage, sr, seed + i, offset),
    mix: stage.params.mix,
    bypass: 0,
    input: createLevelMeter(),
    output: createLevelMeter(),
  }));
  let left = 0,
    right = 0;
  const smooth = 1 - Math.exp(-1 / (sr * 0.01));
  return {
    measurements() {
      return nodes.map((n) =>
        stageGain(n.stage.id, n.stage.type, n.input.report(), n.output.report()),
      );
    },
    get left() {
      return left;
    },
    get right() {
      return right;
    },
    reset() {
      for (const n of nodes) n.processor.reset();
    },
    control(key: string, value: number | null) {
      if (!key.startsWith('insert.')) return false;
      const [id, field, extra] = key.slice(7).split('.');
      const n = nodes.find((n) => n.stage.id === id);
      if (!n || extra || !(field in n.stage.params))
        throw new RangeError(`Unknown insert parameter ${key}`);
      n.processor.params[field] =
        value === null ? n.stage.params[field] : nativeEffectValue(n.stage.type, field, value);
      return true;
    },
    process(l: number, r: number, sample: number, noteHz = 440) {
      for (const n of nodes) {
        if (sample >= measureFrom) n.input.observe(l, r);
        const p = n.processor.params;
        n.mix += smooth * (p.mix - n.mix);
        n.bypass += smooth * (p.bypass - n.bypass);
        n.processor.process(l * (1 - n.bypass), r * (1 - n.bypass), sample, noteHz);
        // Bypass stops input, while delayed audio already in the processor survives.
        const tail = ['delay', 'comb', 'flanger', 'phaser'].includes(n.stage.type);
        const wet = n.mix * (tail ? 1 : 1 - n.bypass);
        const dry = 1 - n.mix * (1 - n.bypass);
        l = l * dry + n.processor.left * wet;
        r = r * dry + n.processor.right * wet;
        if (sample >= measureFrom) n.output.observe(l, r);
      }
      left = l;
      right = r;
    },
  };
}
