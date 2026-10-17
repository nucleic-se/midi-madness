import type { EngineFrame } from '../engine.js';
import type { ParameterBinding } from '../bindings.js';

export interface MonumentSourceOptions<N, D> {
  id: string;
  collection: string;
  channels: readonly { id: string; tracks: readonly string[] }[];
  allTracks: readonly string[];
  percussionTracks: readonly string[];
  secondsPerUnit: number;
  track(note: N): string;
  start(note: N): number;
  velocity(note: N): number;
  /** MIDI semitones and bipolar pan, including any source-format paths. */
  pitch(note: N, frame: EngineFrame<D>): number;
  pan(note: N, frame: EngineFrame<D>): number;
}
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

/** Pure note-activity and onset bindings. Source format and track selection are explicit;
 * no private profile, file access, synth preset registry or Three.js import is involved.
 */
export function monumentBindings<N, D>(
  notes: readonly N[],
  options: MonumentSourceOptions<N, D>,
): ParameterBinding<D>[] {
  if (!Number.isFinite(options.secondsPerUnit) || options.secondsPerUnit <= 0)
    throw new Error('Monument source units must be positive and finite');
  const percussion = new Set(options.percussionTracks);
  const hits = notes
    .filter((note) => percussion.has(options.track(note)))
    .map((note) => ({ at: options.start(note), velocity: options.velocity(note) }))
    .sort((a, b) => a.at - b.at);
  if (
    hits.some(
      (hit) =>
        !Number.isFinite(hit.at) ||
        !Number.isFinite(hit.velocity) ||
        hit.velocity < 0 ||
        hit.velocity > 1,
    )
  )
    throw new Error('Monument hits need finite times and normalized velocity');
  const active = (frame: EngineFrame<D>, tracks: readonly string[]) =>
    (frame.active[options.collection] ?? []).filter((record) =>
      tracks.includes(options.track(record.datum as N)),
    );
  const energy = (tracks: readonly string[]) => (frame: EngineFrame<D>) =>
    1 -
    Math.exp(
      -active(frame, tracks).reduce(
        (sum, record) =>
          sum + options.velocity(record.datum as N) * (0.2 + 0.8 * (1 - record.progress)),
        0,
      ),
    );
  const average =
    (tracks: readonly string[], field: 'pitch' | 'pan') => (frame: EngineFrame<D>) => {
      const records = active(frame, tracks);
      if (!records.length) return field === 'pitch' ? 0.5 : 0;
      const value =
        records.reduce((sum, record) => sum + options[field](record.datum as N, frame), 0) /
        records.length;
      return field === 'pitch' ? clamp((value - 24) / 72) : clamp(value, -1, 1);
    };
  const hit = (frame: EngineFrame<D>) => {
    let low = 0,
      high = hits.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (hits[mid]!.at <= frame.time) low = mid + 1;
      else high = mid;
    }
    const latest = hits[low - 1];
    const age = latest ? (frame.time - latest.at) * options.secondsPerUnit : 8;
    return { age: Math.min(8, age), pulse: latest ? latest.velocity * Math.exp(-age * 5) : 0 };
  };
  const bindings: ParameterBinding<D>[] = [];
  for (const channel of options.channels) {
    for (const part of ['foundation', 'crown'])
      for (const [name, source] of [
        ['energy', energy(channel.tracks)],
        ['pitch', average(channel.tracks, 'pitch')],
        ['pan', average(channel.tracks, 'pan')],
      ] as const)
        bindings.push({ effect: options.id, parameter: `${part}.${channel.id}.${name}`, source });
  }
  bindings.push(
    { effect: options.id, parameter: 'foundation.pulse', source: energy(options.percussionTracks) },
    { effect: options.id, parameter: 'heart.hitAge', source: (frame) => hit(frame).age },
    { effect: options.id, parameter: 'heart.pulse', source: (frame) => hit(frame).pulse },
    {
      effect: options.id,
      parameter: 'heart.radius',
      source: energy(options.allTracks),
      map: (value) => 2 + (value ?? 0) * 0.5,
    },
    {
      effect: options.id,
      parameter: 'heart.intensity',
      source: (frame) => 1 + hit(frame).pulse * 1.3,
    },
  );
  return bindings;
}
