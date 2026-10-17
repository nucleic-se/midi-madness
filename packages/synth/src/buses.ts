import type { AudioBuses } from './engine.ts';
import { createProcessor, nativeEffectValue, type EffectType } from './processors.ts';

export type Stereo = { left: Float32Array; right: Float32Array };
export type Stage = {
  id: string;
  type: EffectType;
  params: Record<string, number>;
  tone: 'lp' | 'bp';
  pattern?: number[];
};
export type Bus = {
  name: string;
  stages: Stage[];
  sends: { bus: string; gain: number }[];
  explicit?: boolean;
  duck?: { part: string; depthDb: number; release: number };
};
export type BusEvent = { sample: number; stage: string; field: string; value: number | null };
export type BusSection = { name: string; from: number; to: number };
export type BusReport = {
  peak: number;
  rmsDb: number;
  tailSeconds: number;
  tailGrew: boolean;
  pendingAtLimit: boolean;
  lowStereoRatio: number;
  sections: { name: string; rmsDb: number }[];
};
const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const delayTime = (v: number) => 0.001 * 10000 ** v;
export const reverbDecay = (v: number) => 0.05 * 600 ** v;
export function busValue(stage: Stage, field: string, v: number): number {
  if (stage.type !== 'delay' && stage.type !== 'reverb')
    return nativeEffectValue(stage.type, field, v);
  if (field === 'time') return delayTime(v);
  if (field === 'decay') return reverbDecay(v);
  if (field === 'predelay') return 2 * v ** 3;
  if (field === 'tone' || field === 'damping') return 20 * 1000 ** v;
  if (field === 'feedback') return Math.min(0.98, v);
  return v;
}
export function busOrder(buses: Bus[]): Bus[] {
  const map = new Map(buses.map((b) => [b.name, b])),
    visited = new Set<string>(),
    visiting = new Set<string>(),
    order: Bus[] = [];
  function visit(b: Bus) {
    if (visiting.has(b.name)) throw new RangeError(`Effects routing cycle at bus ${b.name}`);
    if (visited.has(b.name)) return;
    visiting.add(b.name);
    for (const send of b.sends) {
      const target = map.get(send.bus);
      if (!target) throw new RangeError(`Bus ${b.name} sends to unknown bus ${send.bus}`);
      visit(target);
    }
    visiting.delete(b.name);
    visited.add(b.name);
    order.push(b);
  }
  for (const b of buses) visit(b);
  return order.reverse(); // Sources run first, accumulating into downstream inputs.
}
export function busBuffers(buses: Bus[], frames: number): Record<string, Stereo> {
  return Object.fromEntries(
    buses.map((b) => [b.name, { left: new Float32Array(frames), right: new Float32Array(frames) }]),
  );
}
function tap(buffer: Float32Array, pos: number, delay: number): number {
  let t = pos - delay;
  if (t < 0) t += buffer.length;
  // A tiny negative offset can round to exactly buffer.length when wrapped
  // (e.g. 150 BPM's 14400.000000000002-sample echo). Keep the tap in bounds.
  if (t >= buffer.length) t -= buffer.length;
  const j = Math.floor(t),
    f = t - j,
    next = j + 1 === buffer.length ? 0 : j + 1;
  return buffer[j] * (1 - f) + buffer[next] * f;
}
function pending(buffer: Float32Array, pos: number, length: number): boolean {
  for (let n = 1; n <= Math.min(buffer.length, Math.ceil(length) + 2); n++) {
    let i = pos - n;
    if (i < 0) i += buffer.length;
    if (Math.abs(buffer[i]) > 0.00001) return true;
  }
  return false;
}
function processEffect(
  audio: Stereo,
  stage: Stage,
  events: BusEvent[],
  sr: number,
  cuts: number[],
) {
  const processor = createProcessor(stage, sr);
  let cursor = 0,
    cutCursor = 0;
  for (let i = 0; i < audio.left.length; i++) {
    while (cutCursor < cuts.length && cuts[cutCursor] <= i) {
      cutCursor++;
      processor.reset();
    }
    while (cursor < events.length && events[cursor].sample <= i) {
      const e = events[cursor++];
      processor.params[e.field] =
        e.value === null ? stage.params[e.field] : busValue(stage, e.field, e.value);
    }
    processor.process(audio.left[i], audio.right[i], i);
    audio.left[i] = processor.left;
    audio.right[i] = processor.right;
  }
  return processor.pending();
}
function processReverb(
  audio: Stereo,
  stage: Stage,
  events: BusEvent[],
  sr: number,
  cuts: number[],
) {
  const p = { ...stage.params },
    base = { ...p };
  const times = [0.0297, 0.0371, 0.0411, 0.0437, 0.0531, 0.0617, 0.0713, 0.0797];
  const lines = times.map(() => new Float32Array(Math.ceil(sr * 0.5)));
  const positions = new Int32Array(8),
    damped = new Float64Array(8),
    values = new Float64Array(8);
  const lengths = new Float64Array(8),
    target = new Float64Array(8),
    feedback = new Float64Array(8);
  const pre = new Float32Array(sr * 2 + 2);
  let cutCursor = 0,
    prePos = 0,
    cursor = 0,
    preTime = p.predelay,
    damping = 0.35;
  const smoothing = 1 - Math.exp(-64 / (sr * 0.02)),
    preSmooth = 1 - Math.exp(-1 / (sr * 0.02));
  const update = (i: number, initial = false) => {
    damping = 1 - Math.exp((-TAU * p.damping) / sr);
    for (let j = 0; j < 8; j++) {
      // Long decays lengthen the network instead of requiring loop gain above .98.
      const minTime = p.decay * (-Math.log(0.98) / Math.log(1000)) * (1 + j * 0.025);
      target[j] = Math.max((times[j] * (0.5 + p.size)) / 1.2, minTime) * sr;
      if (initial) lengths[j] = target[j];
      else lengths[j] += smoothing * (target[j] - lengths[j]);
      feedback[j] = Math.min(0.98, 10 ** ((-3 * lengths[j]) / sr / p.decay));
    }
  };
  const mods = new Float64Array(8);
  update(0, true);
  for (let i = 0; i < audio.left.length; i++) {
    while (cutCursor < cuts.length && cuts[cutCursor] <= i) {
      cutCursor++;
      pre.fill(0);
      lines.forEach((l) => l.fill(0));
      damped.fill(0);
    }
    while (cursor < events.length && events[cursor].sample <= i) {
      const e = events[cursor++];
      p[e.field] = e.value === null ? base[e.field] : busValue(stage, e.field, e.value);
    }
    if ((i & 63) === 0) {
      update(i);
      for (let j = 0; j < 8; j++)
        mods[j] = p.mod
          ? Math.sin((TAU * (0.07 + j * 0.009) * i) / sr + j) * p.mod * sr * 0.0003
          : 0;
    }
    preTime += preSmooth * (p.predelay - preTime);
    const inputMono = (audio.left[i] + audio.right[i]) * 0.5;
    const input = preTime < 1 / sr ? inputMono : tap(pre, prePos, Math.max(1, preTime * sr));
    pre[prePos] = inputMono;
    if (++prePos === pre.length) prePos = 0;
    let sum = 0,
      left = 0,
      right = 0;
    for (let j = 0; j < 8; j++) {
      const modulation = mods[j];
      const y = tap(lines[j], positions[j], clamp(lengths[j] + modulation, 1, lines[j].length - 2));
      values[j] = y;
      damped[j] += damping * (y - damped[j]);
      sum += damped[j];
      if (j & 1) right += y;
      else left += y;
    }
    for (let j = 0; j < 8; j++) {
      lines[j][positions[j]] = input * 0.3 + Math.tanh(feedback[j] * (damped[j] - sum * 0.25));
      if (++positions[j] === lines[j].length) positions[j] = 0;
    }
    audio.left[i] = left * 0.25;
    audio.right[i] = right * 0.25;
  }
  return (
    pending(pre, prePos, p.predelay * sr) ||
    lines.some((line, j) => pending(line, positions[j], lengths[j] + sr * 0.0003)) ||
    damped.some((v) => Math.abs(v) > 0.00001)
  );
}
export function renderBuses(
  out: AudioBuses,
  buses: Bus[],
  controls: Record<string, BusEvent[]>,
  sr: number,
  sections: BusSection[],
  formEnd: number,
  processing: {
    cuts?: number[];
    triggers?: Record<string, { sample: number; velocity: number }[]>;
  } = {},
) {
  const frames = out.left.length,
    reports: Record<string, BusReport> = {},
    warnings: string[] = [];
  const tailPeak = new Float32Array(frames);
  for (const bus of busOrder(buses)) {
    const audio = out.buses![bus.name];
    const windows = Math.ceil(frames / (sr * 0.1)),
      inputEnergy = new Float64Array(windows);
    // Compare input and wet decay at the same relative level. A fixed, lower
    // input threshold used to count almost-silent instrument releases as input
    // after the quieter wet output had already crossed its threshold.
    let inputPeak = 0;
    for (let i = 0; i < frames; i++)
      inputPeak = Math.max(inputPeak, Math.abs(audio.left[i]), Math.abs(audio.right[i]));
    const inputThreshold = Math.max(1e-8, inputPeak * 0.001);
    let lastInput = 0;
    for (let i = 0; i < frames; i++) {
      const energy = audio.left[i] ** 2 + audio.right[i] ** 2;
      inputEnergy[Math.floor(i / (sr * 0.1))] += energy;
      if (Math.max(Math.abs(audio.left[i]), Math.abs(audio.right[i])) > inputThreshold)
        lastInput = i;
    }
    const events = controls[bus.name] ?? [];
    let pendingAtLimit = false;
    for (const stage of bus.stages) {
      const selected = events.filter((e) => e.stage === stage.id);
      const remaining =
        stage.type === 'reverb'
          ? processReverb(audio, stage, selected, sr, processing.cuts ?? [])
          : processEffect(audio, stage, selected, sr, processing.cuts ?? []);
      pendingAtLimit ||= remaining;
    }
    let wetPeak = 0;
    for (let i = 0; i < frames; i++)
      wetPeak = Math.max(wetPeak, Math.abs(audio.left[i]), Math.abs(audio.right[i]));
    const wetThreshold = Math.max(1e-8, wetPeak * 0.001);
    const returns = events.filter((e) => e.stage === '$bus'),
      outputEnergy = new Float64Array(windows);
    const triggers = bus.duck ? (processing.triggers?.[bus.duck.part] ?? []) : [];
    let triggerCursor = 0,
      duck = 0,
      duckTarget = 0;
    const duckRelease = bus.duck ? Math.exp(-1 / (sr * bus.duck.release)) : 0;
    const duckSmooth = 1 - Math.exp(-1 / (sr * 0.003));
    let index = 0,
      gain = 1,
      targetGain = 1,
      lastAudible = 0,
      peak = 0,
      total = 0;
    const smooth = 1 - Math.exp(-1 / (sr * 0.002));
    const lowCoef = 1 - Math.exp((-TAU * 150) / sr);
    let lowL = 0,
      lowR = 0,
      lowSide = 0;
    for (let i = 0; i < frames; i++) {
      while (index < returns.length && returns[index].sample <= i) {
        const v = returns[index++].value;
        targetGain = v === null ? 1 : v * v;
      }
      gain += smooth * (targetGain - gain);
      while (triggerCursor < triggers.length && triggers[triggerCursor].sample <= i)
        duckTarget = Math.max(duckTarget, triggers[triggerCursor++].velocity);
      duck += duckSmooth * (duckTarget - duck);
      duckTarget *= duckRelease;
      const duckGain = bus.duck ? 10 ** ((-bus.duck.depthDb * duck) / 20) : 1;
      const internal = Math.max(Math.abs(audio.left[i]), Math.abs(audio.right[i]));
      tailPeak[i] = Math.max(tailPeak[i], internal);
      if (internal > wetThreshold) lastAudible = i;
      audio.left[i] *= gain * duckGain;
      audio.right[i] *= gain * duckGain;
      const energy = audio.left[i] ** 2 + audio.right[i] ** 2;
      lowL += lowCoef * (audio.left[i] - lowL);
      lowR += lowCoef * (audio.right[i] - lowR);
      lowSide += (lowL - lowR) ** 2 * 0.25;
      total += energy;
      outputEnergy[Math.floor(i / (sr * 0.1))] += energy;
      peak = Math.max(peak, Math.abs(audio.left[i]), Math.abs(audio.right[i]));
      out.left[i] += audio.left[i];
      out.right[i] += audio.right[i];
    }
    for (const send of bus.sends) {
      const target = out.buses![send.bus];
      for (let i = 0; i < frames; i++) {
        target.left[i] += audio.left[i] * send.gain;
        target.right[i] += audio.right[i] * send.gain;
      }
    }
    let growing = 0,
      tailGrew = false;
    for (let w = 1; w < windows; w++) {
      if (
        inputEnergy[w] < 1e-10 &&
        outputEnergy[w] > 1e-9 &&
        outputEnergy[w] > outputEnergy[w - 1] * 1.001
      )
        growing++;
      else growing = 0;
      if (growing >= 20) tailGrew = true;
    }
    if (tailGrew)
      warnings.push(`Bus ${bus.name}: tail energy grew for more than 2 seconds without input`);
    if (
      tailPeak[frames - 1] > 0.001 &&
      Math.max(Math.abs(audio.left[frames - 1]), Math.abs(audio.right[frames - 1])) > 0.001
    )
      warnings.push(`Bus ${bus.name}: audible tail reached the render limit`);
    if (pendingAtLimit)
      warnings.push(`Bus ${bus.name}: queued or active tail reached the render limit`);
    reports[bus.name] = {
      peak,
      rmsDb: 10 * Math.log10(Math.max(1e-20, total / (2 * frames))),
      // Instrument releases can feed a bus beyond the score end. Include that
      // audible return in the render tail rather than moving its origin later.
      tailSeconds: Math.max(0, (lastAudible - Math.min(lastInput, formEnd - 1)) / sr),
      tailGrew,
      pendingAtLimit,
      lowStereoRatio: lowSide / Math.max(1e-20, total * 0.5),
      sections: sections.map((s) => {
        let sum = 0;
        const from = Math.max(0, s.from),
          to = Math.min(frames, s.to);
        for (let i = from; i < to; i++) sum += audio.left[i] ** 2 + audio.right[i] ** 2;
        return {
          name: s.name,
          rmsDb: 10 * Math.log10(Math.max(1e-20, sum / Math.max(1, 2 * (to - from)))),
        };
      }),
    };
  }
  let peak = 0,
    beforePeak = 0,
    limitedSamples = 0;
  for (let i = 0; i < frames; i++) {
    const p = Math.max(Math.abs(out.left[i]), Math.abs(out.right[i]));
    beforePeak = Math.max(beforePeak, p);
    const gain = Math.min(1, 0.95 / Math.max(0.000001, p));
    if (gain < 1) limitedSamples++;
    out.left[i] *= gain;
    out.right[i] *= gain;
    peak = Math.max(peak, p * gain);
  }
  return {
    peak,
    beforePeak,
    reports,
    warnings,
    tailPeak,
    limitedSamples,
    pendingAtLimit: Object.values(reports).some((r) => r.pendingAtLimit),
  };
}
