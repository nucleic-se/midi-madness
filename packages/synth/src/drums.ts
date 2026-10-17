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
import { envelopeGrid, envelopeTolerance } from './engine.ts';
/** The envelope one drum hit actually had: 1 at its attack, including chokes, until it ended
 * or the next hit on the lane retriggered it. Velocity and accent scale it separately. */
export type DrumEnvelopeRecord = { hit: number; on: number; end: number; amplitude: LanePoint[] };
import { createSends, setSend, noteThrows, throwAudio, sendAudio, type Throw } from './sends.ts';
import { createInsertChain } from './processors.ts';
import type { Stage } from './buses.ts';
import { clamp, rng, oscillator, hz, type AudioBuses, type MemberReport } from './engine.ts';
import { db } from './presets.ts';
export const lanes = [
  'kick',
  'boom',
  'snare',
  'clap',
  'rim',
  'hat',
  'openhat',
  'ride',
  'crash',
  'shaker',
  'tom-low',
  'tom-high',
  'conga',
  'cowbell',
  'zap',
  'noise',
];
const basePitches = [
  52,
  45,
  185 / Math.SQRT2,
  1000,
  455,
  205.3,
  205.3,
  205.3 * 1.45,
  205.3 * 1.2,
  6000,
  95,
  165,
  330,
  540,
  60,
  52,
];
const pitchDecays = [
  0.03, 0.06, 0.02, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.05, 0.05, 0.015, 0.03, 0.1, 0.03,
];
const decays = [
  0.35, 1.6, 0.18, 0.16, 0.035, 0.06, 0.45, 1.8, 2.2, 0.07, 0.42, 0.3, 0.18, 0.3, 0.16, 0.45,
];
const trims = [0, -3, -5, -6, -10, -11, -12, -14, -12, -14, -6, -7, -9, -12, -10, -11];
const pans = [0, 0, 0, 0.05, -0.15, 0.2, 0.2, -0.25, 0.3, -0.3, -0.2, 0.2, -0.35, 0.25, 0.1, 0];
/** Resolved per-lane constants the drum envelope and pitch sweep are built from.
 * Amplitude: (0.2 + 0.8·velocity^1.5) · (accent ? +3 dB : 1) · exp(-ln(100)·t / decay), silent after
 * 3·decay, where decay = baseDecay · 0.25 · 16^decayKnob (knob default 0.5 → baseDecay).
 * Pitch sweep with a `drum.pitch.depth` lock: basePitch · 2^((depth/12) · exp(-t / pitchDecay)).
 */
export function drumLaneModel(lane: string) {
  const kind = lanes.indexOf(lane);
  if (kind < 0) throw new RangeError(`Unknown drum lane ${lane}; choose ${lanes.join(', ')}`);
  return {
    basePitch: basePitches[kind],
    pitchDecay: pitchDecays[kind],
    baseDecay: decays[kind],
    trimDb: trims[kind],
    pan: pans[kind],
    roomDb: rooms[kind] === -Infinity ? null : rooms[kind],
  };
}
/** Initial pan and reset value used by the drum backend. */
export function defaultDrumPan(lane: string): number {
  const kind = lanes.indexOf(lane);
  if (kind < 0) throw new RangeError(`Unknown drum lane ${lane}; choose ${lanes.join(', ')}`);
  return pans[kind];
}
const rooms = [
  -Infinity,
  -Infinity,
  -20,
  -18,
  -22,
  -Infinity,
  -24,
  -24,
  -18,
  -Infinity,
  -22,
  -22,
  -22,
  -22,
  -20,
  -16,
];
export type DrumEvent = { sample: number; velocity: number; locks: Record<string, number> };
export type DrumControl = { sample: number; name: string; value: number | null };
export function renderDrum(
  lane: string,
  events: DrumEvent[],
  controls: DrumControl[],
  hats: number[],
  sr: number,
  seed: number,
  out: AudioBuses,
  processing: {
    inserts?: Stage[];
    cuts?: number[];
    offset?: number;
    space?: SpatialSettings;
    /** Present for world-frame lanes: position lanes plus the listener they are heard from. */
    world?: { position: PositionLanes; listener?: ListenerLanes };
    /** Receives each hit's recorded envelope values (see DrumEnvelopeRecord). */
    envelopes?: DrumEnvelopeRecord[];
  } = {},
): MemberReport {
  const chain = createInsertChain(processing.inserts ?? [], sr, seed, processing.offset ?? 0);
  let cutCursor = 0;
  const kind = lanes.indexOf(lane);
  if (kind < 0) throw new RangeError(`Unknown drum lane ${lane}; choose ${lanes.join(', ')}`);
  const report: MemberReport = {
    notes: events.length,
    slides: 0,
    retriggers: events.length,
    accents: 0,
    peak: 0,
    ignored: [],
  };
  const random = rng(seed),
    baseDecay = decays[kind];
  let age = 99,
    phase = 0,
    phase2 = 0,
    amp = 0,
    decay = baseDecay,
    tune = 1,
    tone = 0.5;
  let ctlPitch: number | null = null,
    ctlPitchDepth: number | null = null,
    ctlPitchDecay: number | null = null,
    ctlNoise = 0;
  let pitch: number | null = null,
    pitchDepth: number | null = null,
    pitchDecay: number | null = null,
    noiseMix = 0;
  let lfoHz = 0.3,
    lfoPitch = 0,
    lfoTone = 0,
    lfoAmp = 0,
    lfoCycles = 0;

  let low = 0,
    low2 = 0,
    last = 0,
    band = 0,
    eventCursor = 0,
    controlCursor = 0,
    hatCursor = 0;
  let level = 1,
    levelKnob = 1,
    levelDb = 1,
    pan = pans[kind],
    room = db(rooms[kind]),
    echo = 0;
  let panLock: number | undefined;
  let ctlTune = 0,
    ctlDecay = 0.5,
    ctlTone = 0.5;
  let leftGain = Math.cos((((panLock ?? pan) + 1) * Math.PI) / 4),
    rightGain = Math.sin((((panLock ?? pan) + 1) * Math.PI) / 4);
  const metalPhase = new Float64Array(6),
    metalFreq = [205.3, 304.4, 369.6, 522.7, 540, 800];
  const gain = db(trims[kind]) * 0.52;
  const routes = createSends(out.buses, { room, echo });
  let throws: Throw[] = [];
  let spatial: SpatialVoice | undefined;
  let spaceLock: Record<string, number> = {};
  const spaceControls: Record<string, number> = {};
  const world = processing.world,
    worldX = new LaneCursor(world?.position.x),
    worldY = new LaneCursor(world?.position.y),
    worldZ = new LaneCursor(world?.position.z),
    pose = new PoseCursor(world?.listener),
    relative = { azimuth: 0, elevation: 0, distance: 1 };
  const sink = processing.envelopes;
  let record: (Omit<DrumEnvelopeRecord, 'end'> & { attack: number }) | undefined,
    hitIndex = -1;
  // The current hit's envelope relative to its attack (chokes reduce amp after the attack).
  const current = () =>
    age > decay * 3
      ? 0
      : (Math.exp((-Math.log(100) * age) / Math.max(0.001, decay)) * amp) / record!.attack;
  const close = (at: number, value: number) => {
    if (!record) return;
    if (record.amplitude.at(-1)?.sample !== at)
      record.amplitude.push({ sample: at, value, curve: 'linear' });
    const { attack: _attack, ...done } = record;
    sink!.push({ ...done, end: at, amplitude: simplifyLane(done.amplitude, envelopeTolerance) });
    record = undefined;
  };
  for (let i = 0; i < out.left.length; i++) {
    while (cutCursor < (processing.cuts?.length ?? 0) && processing.cuts![cutCursor] <= i) {
      cutCursor++;
      chain.reset();
    }
    while (controlCursor < controls.length && controls[controlCursor].sample <= i) {
      const c = controls[controlCursor++],
        v = c.value;
      if (c.name.startsWith('space.')) {
        spaceControls[c.name] = v ?? (c.name === 'space.dist' ? 1 : 0);
        continue;
      }
      if (chain.control(c.name, v)) continue;
      if (
        setSend(
          routes,
          c.name === 'reverb' ? 'send.room' : c.name === 'delay' ? 'send.echo' : c.name,
          c.value,
        )
      )
        continue;
      switch (c.name) {
        case 'drum.pitch':
          ctlPitch = v;
          break;
        case 'drum.pitch.depth':
          ctlPitchDepth = v;
          break;
        case 'drum.pitch.decay':
          ctlPitchDecay = v;
          break;
        case 'noise':
          ctlNoise = v ?? 0;
          break;
        case 'drum.lfo.hz':
          lfoHz = v ?? 0.3;
          break;
        case 'drum.lfo.pitch':
          lfoPitch = v ?? 0;
          break;
        case 'drum.lfo.tone':
          lfoTone = v ?? 0;
          break;
        case 'drum.lfo.amp':
          lfoAmp = v ?? 0;
          break;
        case 'tune':
          ctlTune = v ?? 0;
          break;
        case 'decay':
          ctlDecay = v ?? 0.5;
          break;
        case 'tone':
          ctlTone = v ?? 0.5;
          break;
        case 'level.db':
          levelDb = v === null ? 1 : 10 ** (v / 20);
          break;
        case 'level':
          levelKnob = v === null ? 1 : v * v;
          break;
        case 'pan':
          pan = v ?? pans[kind];
          break;
        case 'reverb':
          room = v === null ? db(rooms[kind]) : v * v;
          break;
        case 'delay':
          echo = v === null ? 0 : v * v;
          break;
        default:
          if (!report.ignored.includes(c.name)) report.ignored.push(c.name);
      }
      level = levelKnob * levelDb;
      leftGain = Math.cos((((panLock ?? pan) + 1) * Math.PI) / 4);
      rightGain = Math.sin((((panLock ?? pan) + 1) * Math.PI) / 4);
    }
    while (eventCursor < events.length && events[eventCursor].sample <= i) {
      const e = events[eventCursor++],
        accent = Math.round(e.velocity * 127) >= 100;
      // A retrigger cuts the previous hit at the value it had reached.
      if (record) close(i, current());
      if (accent) report.accents++;
      spaceLock = e.locks;
      panLock = e.locks.pan;
      throws = noteThrows(
        routes,
        Object.fromEntries(
          Object.entries(e.locks)
            .filter(([key]) => key.startsWith('send.') && !key.endsWith('.pre'))
            .map(([key, v]) => [key.slice(5), v]),
        ),
      );
      level = levelKnob * levelDb;
      leftGain = Math.cos((((panLock ?? pan) + 1) * Math.PI) / 4);
      rightGain = Math.sin((((panLock ?? pan) + 1) * Math.PI) / 4);
      age = 0;
      phase = phase2 = 0;
      low = low2 = last = band = 0;
      decay = baseDecay * 0.25 * 16 ** (e.locks.decay ?? ctlDecay);
      tune = 2 ** ((e.locks.tune ?? ctlTune) + (e.locks['drum.generated.pitch'] ?? 0) / 1200);
      tone = clamp((e.locks.tone ?? ctlTone) * (accent ? 1.2 : 1), 0, 1);
      pitch = e.locks['drum.pitch'] ?? ctlPitch;
      pitchDepth = e.locks['drum.pitch.depth'] ?? ctlPitchDepth;
      pitchDecay = e.locks['drum.pitch.decay'] ?? ctlPitchDecay;
      noiseMix = e.locks.noise ?? ctlNoise;
      amp = (0.2 + 0.8 * e.velocity ** 1.5) * (accent ? db(3) : 1);
      hitIndex++;
      if (sink) record = { hit: hitIndex, on: i, attack: amp, amplitude: [] };
    }
    while (hatCursor < hats.length && hats[hatCursor] <= i) {
      if (lane === 'openhat' && age < 99) amp *= 0.001;
      hatCursor++;
    }
    if (record) {
      if (age > decay * 3) close(i, 0);
      else if ((i - record.on) % envelopeGrid === 0)
        record.amplitude.push({ sample: i, value: current(), curve: 'linear' });
    }
    if (i === 0) lfoCycles = (-(processing.offset ?? 0) * lfoHz) / sr;
    const lfo = Math.sin(Math.PI * 2 * lfoCycles);
    lfoCycles += lfoHz / sr;
    if (
      age > decay * 3 &&
      !processing.inserts?.length &&
      !processing.space?.distance &&
      processing.space?.output !== 'binaural' &&
      processing.space?.output !== 'ambisonic' &&
      !world &&
      !Object.keys(spaceControls).length &&
      !Object.keys(spaceLock).some((k) => k.startsWith('space.'))
    )
      continue;
    const noise = random() * 2 - 1;
    const t = age,
      envelope = Math.exp((-Math.log(100) * t) / Math.max(0.001, decay));

    const currentTone = clamp(tone + lfo * lfoTone, 0, 1);
    const pitchScale =
      (pitch === null ? 1 : hz(pitch) / basePitches[kind]) * 2 ** ((lfoPitch * lfo) / 12);
    const envScale =
      pitchDepth === null
        ? 1
        : 2 ** ((pitchDepth / 12) * Math.exp(-t / (pitchDecay ?? pitchDecays[kind])));
    let x = 0,
      f = 52;
    switch (lane) {
      case 'kick':
        f = 52 * 2 ** (2.5 * Math.exp(-t / (pitchDecay ?? 0.03)));
        x = Math.sin(phase) + noise * 0.32 * (1 + currentTone) * Math.exp(-t / 0.002);
        x = Math.tanh(x * (1 + currentTone * 0.5));
        break;
      case 'boom':
        f = 45 * 2 ** Math.exp(-t / (pitchDecay ?? 0.06));
        x = Math.tanh(Math.sin(phase) * (1 + currentTone));
        break;
      case 'snare':
        f = 185 * 2 ** (-0.5 * (1 - Math.exp(-t / (pitchDecay ?? 0.02))));
        x =
          (Math.sin(phase) + 0.55 * Math.sin(phase2)) * (1 - currentTone * 0.65) +
          (noise - low) * (currentTone + 0.25);
        break;
      case 'clap': {
        const burst =
          t < 0.034 ? Math.exp(-((t % 0.009) / 0.0025)) : 0.3 * Math.exp(-(t - 0.03) / 0.04);
        x = (noise - low) * burst * 2;
        f = 1000;
        break;
      }
      case 'rim':
        f = 455;
        x = Math.sin(phase) + 0.6 * Math.sin(phase2);
        break;
      case 'hat':
      case 'openhat':
      case 'ride':
      case 'crash': {
        let metal = 0;
        const factor = lane === 'ride' ? 1.45 : lane === 'crash' ? 1.2 : 1;
        for (let j = 0; j < 6; j++) {
          const dt = (metalFreq[j] * tune * pitchScale * envScale * factor) / sr;
          metal += oscillator(metalPhase[j], dt, 1, 0.5);
          metalPhase[j] = (metalPhase[j] + dt) % 1;
        }
        x = metal / 4;
        if (lane === 'crash') x = (x + noise) * 0.5;
        const lp = 1 - Math.exp((-2 * Math.PI * (5000 + currentTone * 5000)) / sr);
        low2 += lp * (x - low2);
        band += 0.55 * (low2 - band);
        x = low2 - band;
        if (lane === 'ride') x += 0.1 * Math.sin(phase) * Math.exp(-t / 0.03);
        f = 1200;
        break;
      }
      case 'shaker':
        x = (noise - low) * Math.min(1, t / 0.006);
        f = 6000;
        break;
      case 'tom-low':
        f = 95 * 2 ** (0.6 * Math.exp(-t / (pitchDecay ?? 0.05)));
        x = Math.sin(phase) + noise * 0.06 * currentTone;
        break;
      case 'tom-high':
        f = 165 * 2 ** (0.6 * Math.exp(-t / (pitchDecay ?? 0.05)));
        x = Math.sin(phase) + noise * 0.06 * currentTone;
        break;
      case 'conga':
        f = 330 * 2 ** ((0.1 + 0.4 * currentTone) * Math.exp(-t / (pitchDecay ?? 0.015)));
        x = Math.sin(phase);
        break;
      case 'cowbell':
        f = 540;
        x = 0.5 * ((Math.sin(phase) > 0 ? 1 : -1) + (Math.sin(phase2) > 0 ? 1 : -1));
        x *= t < 0.015 ? 1 : 0.5;
        break;
      case 'zap':
        f = 60 * (2500 / 60) ** Math.max(0, 1 - t / (pitchDecay ?? 0.04 + 0.21 * currentTone));
        x = Math.sin(phase);
        break;
      case 'noise': {
        const cutoff = 400 * ((4000 + 12000 * currentTone) / 400) ** Math.max(0, 1 - t / decay);
        low2 += (1 - Math.exp((-2 * Math.PI * cutoff) / sr)) * (noise - low2);
        x = low2;
        break;
      }
    }
    low += 0.15 * (noise - low);
    if (pitchDepth !== null && !['hat', 'openhat', 'ride', 'crash'].includes(lane))
      f = basePitches[kind] * envScale;
    x = x * (1 - noiseMix) + noise * noiseMix;
    phase += (2 * Math.PI * f * tune * pitchScale) / sr;
    phase2 +=
      (2 * Math.PI * (lane === 'rim' ? 1667 : lane === 'cowbell' ? 800 : 330) * tune * pitchScale) /
      sr;
    const preValue =
      age > decay * 3 ? 0 : x * envelope * amp * gain * (1 - lfoAmp * (1 - lfo) * 0.5);
    // World-frame hits are loud or quiet at the source: level is applied before propagation.
    const sourceLevel = world ? level : 1,
      listenerLevel = world ? 1 : level;
    if (routes.length)
      throwAudio(throws, i, preValue * leftGain, preValue * rightGain, listenerLevel);
    let preLeft = preValue * leftGain,
      preRight = preValue * rightGain;
    if (processing.inserts?.length) {
      chain.process(preLeft, preRight, i, f * tune);
      preLeft = chain.left;
      preRight = chain.right;
    }
    const space = processing.space;
    if (
      space &&
      (world ||
        space.output !== 'stereo' ||
        space.distance ||
        Object.keys(spaceControls).length ||
        Object.keys(spaceLock).some((k) => k.startsWith('space.')))
    ) {
      spatial ??= new SpatialVoice(sr);
      if (world)
        relativeToListener(
          spaceLock['space.x'] ?? worldX.at(i),
          spaceLock['space.y'] ?? worldY.at(i),
          spaceLock['space.z'] ?? worldZ.at(i),
          pose.at(i),
          relative,
        );
      spatial.process(
        (preLeft + preRight) * 0.5 * Math.SQRT2 * sourceLevel,
        world
          ? relative.azimuth
          : (spaceLock['space.az'] ?? spaceControls['space.az'] ?? (panLock ?? pan) * 90),
        world ? relative.elevation : (spaceLock['space.el'] ?? spaceControls['space.el'] ?? 0),
        world ? relative.distance : (spaceLock['space.dist'] ?? spaceControls['space.dist'] ?? 1),
        space,
      );
      preLeft = spatial.left;
      preRight = spatial.right;
      if (out.ambisonic)
        for (let ch = 0; ch < 4; ch++)
          out.ambisonic[ch][i] += spatial.mono * spatial.direction[ch] * listenerLevel;
      if (space.room && out.buses?.[space.room]) {
        out.buses[space.room].left[i] += preLeft * spatial.send * listenerLevel;
        out.buses[space.room].right[i] += preRight * spatial.send * listenerLevel;
      }
    }
    const left = preLeft * listenerLevel,
      right = preRight * listenerLevel;
    const value = (left + right) * 0.5;
    report.peak = Math.max(report.peak, Math.abs(left), Math.abs(right));
    out.left[i] += left;
    out.right[i] += right;
    if (routes.length) {
      sendAudio(routes, i, preLeft, preRight, left, right);
    } else {
      out.room[i] += value * room * 0.7;
      out.echo[i] += value * echo * 0.7;
    }
    age += 1 / sr;
  }
  if (record) close(out.left.length, current());
  return report;
}
