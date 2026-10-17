import {
  ControlLane,
  interpolate,
  type Curve,
  type ControlPoint,
} from '@midi-madness/foundation/curves';
/** Headless, seconds-based contract between performance adapters and visual instruments.
 * No score parser, audio transport, synth implementation, DOM, or Three.js dependency.
 */
export type Position3 = readonly [number, number, number];
export interface ParameterPath {
  parameter: string;
  /** Applied after interpolation, preserving native nonlinear curves during unit conversion. */
  scale?: number;
  offset?: number;
  from: number;
  to: number;
  start: number;
  duration: number;
  curve?: Curve;
}
export interface VoiceState {
  id: string;
  track: string;
  time: number;
  age: number;
  held: boolean;
  pitch: number;
  velocity: number;
  parameters: Readonly<Record<string, number>>;
  position: Position3;
  listenerPosition: Position3;
  distance: number;
  azimuth: number;
  elevation: number;
  /** Source envelope values, before propagation. Null means unavailable, never an invented decay. */
  amplitude: number | null;
  filterEnvelope: number | null;
}
export interface EnvelopeState {
  amplitude: number;
  filterEnvelope: number;
}
export interface VoiceDefinition {
  id: string;
  track: string;
  /** Listener-frame sources remain head-locked for older exports. */
  frame?: 'world' | 'listener';
  start: number;
  /** Gate closes here. A release tail may continue until end. */
  gateEnd: number;
  end: number;
  pitch: number;
  velocity: number;
  /** World-space x/y/z in metres; pitch in MIDI semitones; other units belong to the adapter. */
  parameters?: Record<string, number>;
  paths?: ParameterPath[];
  /** Resolved, authoritative envelope timelines or an evaluator supplied by the audio integration. */
  envelopes?: (
    time: number,
    voice: Readonly<Omit<VoiceState, 'amplitude' | 'filterEnvelope'>>,
  ) => EnvelopeState;
}
export interface ListenerState {
  position: Position3;
  yaw: number;
  pitch: number;
}
export interface PerformanceDefinition {
  voices: readonly VoiceDefinition[];
  tracks?: Record<
    string,
    { defaults?: Record<string, number>; controls?: Record<string, readonly ControlPoint[]> }
  >;
  /** World-space position; orientation in degrees. Forward is -Z, right +X, up +Y. */
  listener?: Partial<Record<'x' | 'y' | 'z' | 'yaw' | 'pitch', readonly ControlPoint[]>>;
}
export interface PerformanceFrame {
  time: number;
  listener: ListenerState;
  voices: readonly VoiceState[];
}

function finite(value: number, label: string) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
}
/** World to listener-local coordinates. Positive yaw turns clockwise toward +X; pitch looks up. */
export function relativePosition(position: Position3, listener: ListenerState): Position3 {
  const x = position[0] - listener.position[0],
    y = position[1] - listener.position[1],
    z = position[2] - listener.position[2];
  const yaw = (listener.yaw * Math.PI) / 180,
    pitch = (listener.pitch * Math.PI) / 180;
  const right = x * Math.cos(yaw) + z * Math.sin(yaw),
    forward = x * Math.sin(yaw) - z * Math.cos(yaw);
  return [
    right,
    y * Math.cos(pitch) - forward * Math.sin(pitch),
    -(forward * Math.cos(pitch) + y * Math.sin(pitch)),
  ];
}
/** Listener-local point to world space; inverse of relativePosition. */
export function worldPosition(local: Position3, listener: ListenerState): Position3 {
  const yaw = (listener.yaw * Math.PI) / 180,
    pitch = (listener.pitch * Math.PI) / 180;
  const forward = -local[2] * Math.cos(pitch) - local[1] * Math.sin(pitch);
  const up = local[1] * Math.cos(pitch) - local[2] * Math.sin(pitch);
  return [
    listener.position[0] + local[0] * Math.cos(yaw) + forward * Math.sin(yaw),
    listener.position[1] + up,
    listener.position[2] + local[0] * Math.sin(yaw) - forward * Math.cos(yaw),
  ];
}
/** Direct path only. This is a timing aid, not a simulation of bus returns or the audio delay line. */
export const propagationSeconds = (distance: number, speed = 343) => {
  finite(distance, 'Distance');
  finite(speed, 'Speed');
  if (distance < 0 || speed <= 0)
    throw new Error('Distance must be nonnegative and speed positive');
  return distance / speed;
};

export class PerformanceEngine {
  private readonly voices: VoiceDefinition[];
  private readonly tracks = new Map<
    string,
    { defaults: Record<string, number>; lanes: Record<string, ControlLane> }
  >();
  private readonly listenerLanes: Partial<Record<'x' | 'y' | 'z' | 'yaw' | 'pitch', ControlLane>> =
    {};
  constructor(definition: PerformanceDefinition) {
    const ids = new Set<string>();
    this.voices = definition.voices
      .map((v) => {
        if (ids.has(v.id)) throw new Error(`Duplicate voice ID ${v.id}`);
        ids.add(v.id);
        for (const [key, value] of Object.entries({
          start: v.start,
          gateEnd: v.gateEnd,
          end: v.end,
          pitch: v.pitch,
          velocity: v.velocity,
          ...v.parameters,
        }))
          finite(value, key);
        if (v.gateEnd < v.start || v.end < v.gateEnd)
          throw new Error(`Invalid voice interval ${v.id}`);
        const paths = (v.paths ?? [])
          .map((p) => {
            for (const n of [p.start, p.duration, p.from, p.to, p.scale ?? 1, p.offset ?? 0])
              finite(n, 'Path value');
            if (p.duration < 0) throw new Error('Negative path duration');
            interpolate(p.from, p.to, 0, p.curve);
            return { ...p };
          })
          .sort((a, b) => a.start - b.start);
        for (let i = 0; i < paths.length; i++)
          for (let j = i + 1; j < paths.length; j++)
            if (
              paths[i].parameter === paths[j].parameter &&
              paths[j].start < paths[i].start + paths[i].duration
            )
              throw new Error('Overlapping paths for one parameter');
        return { ...v, parameters: { ...v.parameters }, paths };
      })
      .sort((a, b) => a.start - b.start);
    for (const [name, track] of Object.entries(definition.tracks ?? {})) {
      for (const value of Object.values(track.defaults ?? {})) finite(value, 'Track default');
      this.tracks.set(name, {
        defaults: { ...track.defaults },
        lanes: Object.fromEntries(
          Object.entries(track.controls ?? {}).map(([key, points]) => [
            key,
            new ControlLane(points),
          ]),
        ),
      });
    }
    for (const [key, points] of Object.entries(definition.listener ?? {}))
      this.listenerLanes[key as keyof typeof this.listenerLanes] = new ControlLane(points!);
  }
  listener(time: number): ListenerState {
    finite(time, 'Time');
    const at = (key: keyof typeof this.listenerLanes) =>
      this.listenerLanes[key]?.value(time, 0) ?? 0;
    return { position: [at('x'), at('y'), at('z')], yaw: at('yaw'), pitch: at('pitch') };
  }
  frame(time: number): PerformanceFrame {
    const listener = this.listener(time);
    const voices: VoiceState[] = [];
    for (const voice of this.voices) {
      if (voice.start > time) break;
      if (time >= voice.end) continue;
      const track = this.tracks.get(voice.track),
        parameters = { ...track?.defaults };
      for (const [name, lane] of Object.entries(track?.lanes ?? {}))
        parameters[name] = lane.value(time, parameters[name] ?? 0);
      Object.assign(parameters, voice.parameters);
      parameters.pitch = voice.parameters?.pitch ?? voice.pitch;
      for (const path of voice.paths ?? []) {
        const age = time - voice.start - path.start;
        if (age >= 0)
          parameters[path.parameter] =
            interpolate(
              path.from,
              path.to,
              path.duration === 0 ? 1 : age / path.duration,
              path.curve,
            ) *
              (path.scale ?? 1) +
            (path.offset ?? 0);
      }
      let position: Position3 = [parameters.x ?? 0, parameters.y ?? 0, parameters.z ?? 0];
      let local: Position3;
      if (voice.frame === 'listener') {
        const az = ((parameters['space.az'] ?? (parameters.pan ?? 0) * 90) * Math.PI) / 180;
        const el = ((parameters['space.el'] ?? 0) * Math.PI) / 180;
        const dist = parameters['space.dist'] ?? 1;
        local = [
          Math.sin(az) * Math.cos(el) * dist,
          Math.sin(el) * dist,
          -Math.cos(az) * Math.cos(el) * dist,
        ];
        position = worldPosition(local, listener);
      } else local = relativePosition(position, listener);
      const distance = Math.hypot(...local);
      const state = {
        id: voice.id,
        track: voice.track,
        time,
        age: time - voice.start,
        held: time < voice.gateEnd,
        pitch: parameters.pitch,
        velocity: voice.velocity,
        parameters,
        position,
        listenerPosition: local,
        distance,
        azimuth: distance === 0 ? 0 : (Math.atan2(local[0], -local[2]) * 180) / Math.PI,
        elevation:
          distance === 0
            ? 0
            : (Math.asin(Math.max(-1, Math.min(1, local[1] / distance))) * 180) / Math.PI,
      };
      const envelope = voice.envelopes?.(time, state);
      if (envelope) for (const value of Object.values(envelope)) finite(value, 'Envelope output');
      voices.push({
        ...state,
        amplitude: envelope?.amplitude ?? null,
        filterEnvelope: envelope?.filterEnvelope ?? null,
      });
    }
    return { time, listener, voices };
  }
  /** Historical states include the exact endpoints and do not mutate playback state.
   * Caller chooses a sampling rate appropriate to the fastest motion being drawn.
   */
  sample(from: number, to: number, rate: number, maxSamples = 65536): readonly PerformanceFrame[] {
    finite(from, 'Start');
    finite(to, 'End');
    finite(rate, 'Rate');
    if (to < from || rate <= 0 || !Number.isInteger(maxSamples) || maxSamples < 1)
      throw new Error('Invalid sampling window');
    const intervals = Math.ceil((to - from) * rate),
      count = intervals + 1;
    if (count > maxSamples) throw new Error(`Sampling window exceeds ${maxSamples} samples`);
    return Array.from({ length: count }, (_, i) =>
      this.frame(intervals === 0 ? from : from + ((to - from) * i) / intervals),
    );
  }
}

export interface AudioClock {
  sampleRate: number;
  originSample: number;
  frames: number;
}
/** Backend samples stay authoritative; excerpts may start after or before score zero. */
export function performanceClock(audio: AudioClock) {
  finite(audio.sampleRate, 'Sample rate');
  finite(audio.originSample, 'Origin');
  finite(audio.frames, 'Frame count');
  if (audio.sampleRate <= 0 || !Number.isInteger(audio.frames) || audio.frames < 0)
    throw new Error('Invalid audio clock');
  return {
    duration: audio.frames / audio.sampleRate,
    seconds(sample: number) {
      finite(sample, 'Sample');
      return (sample - audio.originSample) / audio.sampleRate;
    },
    sample(seconds: number) {
      finite(seconds, 'Seconds');
      return seconds * audio.sampleRate + audio.originSample;
    },
  };
}
/** Consume envelope values exported/replayed by the synth integration, including release/retrigger.
 * Interpolation must be declared by its producer. This does not infer envelopes from note gates.
 */
export function envelopeTimeline(
  amplitude: readonly ControlPoint[],
  filter: readonly ControlPoint[],
): VoiceDefinition['envelopes'] {
  const amp = new ControlLane(amplitude),
    env = new ControlLane(filter);
  return (time) => ({ amplitude: amp.value(time, 0), filterEnvelope: env.value(time, 0) });
}
