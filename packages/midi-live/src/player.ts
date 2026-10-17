import type { RealizationResult } from '../../core/src/index.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import { planWire } from '../../midi/src/port-plan.ts';
import { chase, selection } from '../../midi/src/controls.ts';
import { tick, sorted, type Message, type Timeline } from '../../midi/src/notes.ts';
import type { MidiOutput } from './native.ts';
export type Clock = { now(): number; wait(deadline: number, signal?: AbortSignal): Promise<void> };
export const clock: Clock = {
  now: () => performance.now(),
  async wait(deadline, signal) {
    while (!signal?.aborted) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return;
      if (remaining < 0.3) {
        while (performance.now() < deadline && !signal?.aborted) {}
        return;
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, Math.max(0, remaining > 2 ? remaining - 1 : 0));
        signal?.addEventListener('abort', finish, { once: true });
      });
    }
  },
};
export type PlayOptions = {
  from?: R;
  to?: R;
  loop?: boolean;
  clock?: boolean;
  signal?: AbortSignal;
  timer?: Clock;
  position?: (text: string) => void;
};
type Job = {
  tick: bigint;
  priority: number;
  data?: number[][];
  position?: string;
  nrpn?: number[];
  instance?: string;
  expires?: bigint;
};
export function panic(output: MidiOutput, channels: number[]): number {
  let sent = 0;
  for (const ch of channels) {
    output.send([0xb0 + ch - 1, 123, 0]);
    output.send([0xb0 + ch - 1, 120, 0]);
    sent += 2;
  }
  for (const ch of channels)
    for (let note = 0; note < 128; note++) {
      output.send([0x80 + ch - 1, note, 0]);
      sent++;
    }
  return sent;
}
export function rangeMessages(
  realized: RealizationResult,
  t: Timeline,
  from: R,
  to: R,
  clock = t.rig.parts[0]?.port.clock ?? false,
): Message[] {
  const begin = tick(from) + t.offset,
    end = tick(to) + t.offset,
    notes = t.notes.filter(
      (n) => n.event.nominalOnset.compare(from) >= 0 && n.event.nominalOnset.compare(to) < 0,
    ),
    ids = new Set(notes.map((n) => n.event.id)),
    messages: Message[] = [];
  for (const n of notes) {
    const start = n.start + t.offset < begin ? begin : n.start + t.offset,
      stop = n.end + t.offset > end ? end : n.end + t.offset;
    if (stop <= start) continue;
    const ch = n.bound.channel - 1,
      data = [[0x90 + ch, n.pitch, n.velocity]];
    if (n.legatoOff && ids.has(n.legatoOff.event.id)) data.push([0x80 + ch, n.legatoOff.pitch, 0]);
    messages.push({
      tick: start - begin,
      priority: 3,
      order: n.order,
      instance: `${n.bound.port.id}/${n.bound.channel}`,
      data,
      source: n.event.id,
    });
    const pair = notes.some((next) => next.legatoOff === n);
    if (!pair)
      messages.push({
        tick: stop - begin,
        priority: 0,
        order: n.order,
        instance: `${n.bound.port.id}/${n.bound.channel}`,
        data: [[0x80 + ch, n.pitch, 0]],
        source: n.event.id,
      });
  }
  for (const m of t.messages)
    if (!m.startup && m.parameter && m.tick > begin && m.tick <= end)
      messages.push({ ...m, tick: m.tick - begin });
  messages.push(...chase(realized, t, from));
  return selection(
    planWire(sorted(messages), t.rig.parts[0].port, t.song.tempo, 0n, tick(to.sub(from)), clock),
  );
}
export async function play(
  realized: RealizationResult,
  t: Timeline,
  output: MidiOutput,
  options: PlayOptions = {},
) {
  const timer = options.timer ?? clock,
    channels = [...new Set(t.rig.parts.map((b) => b.channel))],
    active = new Map<string, [number, number]>(),
    lateness: number[] = [],
    from = options.from ?? new R(0),
    to = options.to ?? t.song.extent,
    range = !!options.from || !!options.to || !!options.loop;
  const useClock = options.clock ?? t.rig.parts[0]?.port.clock ?? true,
    secondsPerTick = (60 * Number(t.song.tempo.denominator)) / Number(t.song.tempo.numerator) / 960;
  if (from.compare(to) >= 0 || from.compare(new R(0)) < 0 || to.compare(t.song.extent) > 0)
    throw new RangeError('Playback range must be inside the song and nonempty');
  const position = from.mul(new R(16));
  if (useClock && (position.denominator !== 1n || position.numerator > 16383n))
    throw new RangeError('Range position cannot be represented by MIDI SPP; use --clock off');
  let sent = 0,
    iterations = 0,
    stopped = false,
    skippedAttacks = 0;
  const notesById = new Map(t.notes.map((n) => [n.event.id, n]));
  const wallStart = timer.now();
  function send(data: number[][]) {
    for (const packet of data) {
      output.send(packet);
      sent++;
      const kind = packet[0] & 240,
        key = `${packet[0] & 15}/${packet[1]}`;
      if (kind === 144 && packet[2] > 0) active.set(key, [packet[0] & 15, packet[1]]);
      else if (kind === 128 || kind === 144) active.delete(key);
    }
  }
  function clearNotes() {
    for (const [ch, note] of active.values()) send([[0x80 + ch, note, 0]]);
    active.clear();
    for (const ch of channels) send([[0xb0 + ch - 1, 123, 0]]);
  }
  try {
    const initial = t.messages.filter((m) => m.startup),
      intro = range ? t.offset : 0n;
    if (range)
      for (const m of initial) {
        await timer.wait(wallStart + Number(m.tick) * secondsPerTick * 1000, options.signal);
        if (options.signal?.aborted) {
          stopped = true;
          break;
        }
        send(m.data);
      }
    while (!options.signal?.aborted) {
      const begin = range ? intro + tick(to.sub(from)) * BigInt(iterations) : 0n,
        first = range
          ? intro
          : t.messages
              .filter((m) => !m.startup)
              .reduce((min, m) => (m.tick < min ? m.tick : min), t.offset),
        stop = range ? begin + tick(to.sub(from)) : t.end;
      const body = range
          ? rangeMessages(realized, t, from, to, useClock).map((m) => ({
              ...m,
              tick: m.tick + begin,
            }))
          : t.messages,
        jobs: Job[] = body.map((m) => ({
          tick: m.tick,
          priority: m.priority,
          data: m.data,
          nrpn: m.nrpn,
          instance: m.instance,
          expires:
            m.priority === 3 && m.source && notesById.has(m.source)
              ? range
                ? m.tick + notesById.get(m.source)!.end - notesById.get(m.source)!.start < stop
                  ? m.tick + notesById.get(m.source)!.end - notesById.get(m.source)!.start
                  : stop
                : notesById.get(m.source)!.end + t.offset
              : undefined,
        }));
      if (useClock) {
        const spp = Number(position.numerator);
        jobs.push({
          tick: range ? begin : first,
          priority: -2,
          data: [[0xf2, spp & 127, (spp >> 7) & 127], [from.numerator === 0n ? 0xfa : 0xfb]],
        });
        for (let at = range ? begin : t.offset; at < stop; at += 40n)
          jobs.push({ tick: at, priority: -1, data: [[0xf8]] });
      }
      for (const b of t.song.bars)
        if (b.onset.compare(from) >= 0 && b.onset.compare(to) < 0)
          jobs.push({
            tick: range ? begin + tick(b.onset.sub(from)) : tick(b.onset) + t.offset,
            priority: 4,
            position: `${b.path} bar ${b.number}`,
          });
      jobs.sort((a, b) => (a.tick < b.tick ? -1 : a.tick > b.tick ? 1 : a.priority - b.priority));
      const selectedNrpn = new Map<string, string>();
      for (const job of jobs) {
        const due = wallStart + Number(job.tick) * secondsPerTick * 1000;
        await timer.wait(due, options.signal);
        if (options.signal?.aborted) {
          stopped = true;
          break;
        }
        const late = timer.now() - due;
        if (late > 100)
          throw new Error(`MIDI scheduler stalled ${late.toFixed(1)}ms; playback stopped`);
        if (job.position) {
          options.position?.(job.position);
          continue;
        }
        if (job.data) {
          // An obsolete clock pulse cannot restore elapsed musical time.
          if (job.data[0]?.[0] === 0xf8 && late >= 40 * secondsPerTick * 1000) continue;
          if (
            job.expires !== undefined &&
            timer.now() >= wallStart + Number(job.expires) * secondsPerTick * 1000
          ) {
            skippedAttacks++;
            send(job.data.filter((packet) => (packet[0] & 240) === 128));
            continue;
          }
          lateness.push(Math.max(0, late));
          if (job.nrpn) {
            const key = job.nrpn.join('/'),
              data = job.data.filter((d) => ![98, 99].includes(d[1]));
            if (selectedNrpn.get(job.instance!) !== key)
              data.unshift(
                [0xb0 + (job.data[0][0] & 15), 99, job.nrpn[0]],
                [0xb0 + (job.data[0][0] & 15), 98, job.nrpn[1]],
              );
            selectedNrpn.set(job.instance!, key);
            send(data);
          } else send(job.data);
        }
      }
      if (stopped) break;
      await timer.wait(wallStart + Number(stop) * secondsPerTick * 1000, options.signal);
      if (options.loop) {
        if (useClock) send([[0xfc]]);
        clearNotes();
      }
      iterations++;
      if (!options.loop) break;
    }
    if (options.signal?.aborted) stopped = true;
  } finally {
    try {
      if (useClock) send([[0xfc]]);
      clearNotes();
      // Note-offs and All Notes Off can leave voices held by a sustain pedal.
      for (const ch of channels) send([[0xb0 + ch - 1, 120, 0]]);
    } finally {
      output.close();
    }
  }
  lateness.sort((a, b) => a - b);
  return {
    sent,
    iterations,
    stopped,
    skippedAttacks,
    medianMs: lateness[Math.floor(lateness.length / 2)] ?? 0,
    p99Ms: lateness[Math.min(lateness.length - 1, Math.floor(lateness.length * 0.99))] ?? 0,
  };
}
