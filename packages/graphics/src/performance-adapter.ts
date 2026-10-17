import { readCurve, type Curve, type ControlPoint } from '@midi-madness/foundation/curves';
/** Adapter for the renderer's version-1 performance sidecar. Pure data, no synth imports. */
import {
  PerformanceEngine,
  performanceClock,
  type AudioClock,
  type PerformanceDefinition,
  type VoiceDefinition,
} from './performance.js';

export interface BackendPoint {
  sample: number;
  value: number;
  curve: 'linear' | 'step';
}
export interface BackendPath {
  name: string;
  from: number;
  to: number;
  samples: number;
  curve: Curve | 'step';
}
export type BackendEvent =
  | { sample: number; type: 'set'; name: string; value: number | null }
  | { sample: number; type: 'off'; id: string }
  | {
      sample: number;
      type: 'on';
      id: string;
      pitch: number;
      velocity: number;
      locks?: Record<string, number>;
      paths?: BackendPath[];
      pan?: number;
      panOffset?: number;
    };
export interface BackendHit {
  sample: number;
  velocity: number;
  locks?: Record<string, number>;
}
export interface BackendTrack {
  name: string;
  lane?: string;
  mix?: { pan: number };
  initialControls?: { pan: number };
  space?:
    | { frame: 'world'; position: Partial<Record<'x' | 'y' | 'z', BackendPoint[]>> }
    | { frame: 'listener' };
  resolved?: unknown;
  events?: BackendEvent[];
  hits?: BackendHit[];
  controls?: { sample: number; name: string; value: number | null }[];
}
export interface BackendPerformance {
  format: 'midi-madness-performance';
  version: 1;
  audio: AudioClock;
  world?: {
    version: 1;
    units: 'm';
    axes: string;
    listener: Partial<Record<'x' | 'y' | 'z' | 'yaw' | 'pitch', BackendPoint[]>>;
  };
  tracks: BackendTrack[];
}
export interface ScheduledAttack {
  /** Globally unique attack identity; backend note IDs are scoped to their track. */
  id: string;
  track: string;
  start: number;
  gateEnd: number;
  kind: 'note' | 'hit';
  source: BackendEvent | BackendHit;
  model: unknown;
}
export interface AdapterOptions {
  /** Audio integration can resolve allocation, release tails and exact source envelopes.
   * Default is scheduled note gates only; percussion remains in the attack stream.
   */
  resolveVoice?: (
    voice: VoiceDefinition,
    attack: ScheduledAttack,
    track: BackendTrack,
  ) => VoiceDefinition | null;
}
const parameter = (name: string) => (/^space\.[xyz]$/.test(name) ? name.slice(6) : name);

export function adaptPerformance(document: BackendPerformance, options: AdapterOptions = {}) {
  if (document.format !== 'midi-madness-performance' || document.version !== 1)
    throw new Error('Unsupported performance document');
  if (document.world && (document.world.version !== 1 || document.world.units !== 'm'))
    throw new Error('Unsupported world contract');
  const clock = performanceClock(document.audio);
  const convert = (points: readonly BackendPoint[]): ControlPoint[] =>
    points.map((p) => ({
      time: clock.seconds(p.sample),
      value: p.value,
      curve: readCurve(p.curve, true),
    }));
  const definition: PerformanceDefinition = { voices: [], tracks: {}, listener: {} };
  for (const [axis, points] of Object.entries(document.world?.listener ?? {}))
    definition.listener![axis as keyof NonNullable<PerformanceDefinition['listener']>] = convert(
      points!,
    );
  const voices: VoiceDefinition[] = [],
    attacks: ScheduledAttack[] = [];
  const names = new Set<string>();
  for (const track of document.tracks) {
    if (names.has(track.name)) throw new Error(`Duplicate track ${track.name}`);
    names.add(track.name);
    const controls: Record<string, ControlPoint[]> = {};
    // Same-sample sets retain the final backend value, in exported order.
    for (const event of [
      ...(track.events ?? []).filter((e) => e.type === 'set'),
      ...(track.controls ?? []),
    ].sort((a, b) => a.sample - b.sample)) {
      if (!('name' in event)) continue;
      const name = parameter(event.name),
        point: ControlPoint = {
          time: clock.seconds(event.sample),
          value: event.value,
          curve: 'hold',
        };
      const lane = (controls[name] ??= []);
      if (lane.at(-1)?.time === point.time) lane[lane.length - 1] = point;
      else lane.push(point);
    }
    if (track.space?.frame === 'world')
      for (const [axis, points] of Object.entries(track.space.position))
        controls[axis] = convert(points!);
    definition.tracks![track.name] = {
      defaults: { pan: track.initialControls?.pan ?? track.mix?.pan ?? 0 },
      controls,
    };
    const events = [...(track.events ?? [])].sort((a, b) => a.sample - b.sample);
    const pending = new Map<
      string,
      { event: Extract<BackendEvent, { type: 'on' }>; index: number; end?: number }
    >();
    const notes: { event: Extract<BackendEvent, { type: 'on' }>; index: number; end?: number }[] =
      [];
    events.forEach((event, index) => {
      if (event.type === 'on') {
        const previous = pending.get(event.id);
        if (previous) previous.end = event.sample;
        const note = { event, index };
        notes.push(note);
        pending.set(event.id, note);
      } else if (event.type === 'off') {
        const note = pending.get(event.id);
        if (note) {
          note.end = event.sample;
          pending.delete(event.id);
        }
      }
    });
    const append = (voice: VoiceDefinition, attack: ScheduledAttack) => {
      attacks.push(attack);
      const resolved = options.resolveVoice
        ? options.resolveVoice(voice, attack, track)
        : attack.kind === 'note'
          ? voice
          : null;
      if (resolved) voices.push(resolved);
    };
    for (const note of notes) {
      const event = note.event,
        start = clock.seconds(event.sample),
        gateEnd = Math.max(
          start,
          note.end === undefined ? clock.duration : clock.seconds(note.end),
        );
      const id = JSON.stringify([track.name, event.id, note.index]);
      const parameters = Object.fromEntries(
        Object.entries(event.locks ?? {}).map(([key, value]) => [parameter(key), value]),
      );
      if (event.pan !== undefined) parameters.pan = event.pan;
      if (event.panOffset !== undefined)
        parameters.pan = (parameters.pan ?? track.mix?.pan ?? 0) + event.panOffset;
      const voice: VoiceDefinition = {
        id,
        track: track.name,
        frame: track.space?.frame ?? 'listener',
        start,
        gateEnd,
        end: gateEnd,
        pitch: event.pitch,
        velocity: event.velocity,
        parameters,
        paths: (event.paths ?? []).map((path) => ({
          parameter: parameter(path.name),
          start: 0,
          duration: path.samples / document.audio.sampleRate,
          from: path.from,
          to: path.to,
          scale: path.name === 'pitch' ? 0.01 : 1,
          offset: path.name === 'pitch' ? event.pitch : 0,
          curve: readCurve(path.curve, true),
        })),
      };
      append(voice, {
        id,
        track: track.name,
        start,
        gateEnd,
        kind: 'note',
        source: event,
        model: track.resolved,
      });
    }
    (track.hits ?? []).forEach((hit, index) => {
      const start = clock.seconds(hit.sample),
        id = JSON.stringify([track.name, 'hit', index]);
      append(
        {
          id,
          track: track.name,
          frame: track.space?.frame ?? 'listener',
          start,
          gateEnd: start,
          end: start,
          pitch: hit.locks?.['drum.pitch'] ?? 0,
          velocity: hit.velocity,
          parameters: Object.fromEntries(
            Object.entries(hit.locks ?? {}).map(([key, value]) => [parameter(key), value]),
          ),
        },
        {
          id,
          track: track.name,
          start,
          gateEnd: start,
          kind: 'hit',
          source: hit,
          model: track.resolved,
        },
      );
    });
  }
  definition.voices = voices;
  const engine = new PerformanceEngine(definition);
  attacks.sort((a, b) => a.start - b.start);
  return {
    engine,
    definition,
    clock,
    attacks: attacks as readonly ScheduledAttack[],
    /** Half-open emission-time window; appropriate for triggers, including percussion. */
    attacksBetween(from: number, to: number) {
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from)
        throw new Error('Invalid attack window');
      let lo = 0,
        hi = attacks.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (attacks[mid].start < from) lo = mid + 1;
        else hi = mid;
      }
      const result: ScheduledAttack[] = [];
      for (let i = lo; i < attacks.length && attacks[i].start < to; i++) result.push(attacks[i]);
      return result;
    },
  };
}
