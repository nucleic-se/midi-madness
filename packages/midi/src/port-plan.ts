import { diagnostic } from '../../core/src/diag.ts';
import type { Rational } from '@midi-madness/foundation/time';
import type { Port } from './config.ts';
import { selection } from './controls.ts';
import { sorted, type Message, type Timeline } from './notes.ts';
const bytes = (m: Message) => m.data.reduce((n, p) => n + p.length, 0);
const interior = (m: Message) => !!m.parameter && !m.startup && !m.required && !m.lock;
const ticksPerSecond = (tempo: Rational) =>
  (Number(tempo.numerator) / Number(tempo.denominator)) * 16;
export function peakLoad(messages: Message[], port: Port, tempo: Rational, clock: boolean) {
  let worst = { ratio: 0, start: 0, end: 0, bytes: 0, budget: 0 };
  for (const seconds of [0.1, 1]) {
    const width = ticksPerSecond(tempo) * seconds,
      budget = port.rate * seconds;
    let end = 0,
      total = 0;
    for (let start = 0; start < messages.length; start++) {
      while (end < messages.length && Number(messages[end].tick - messages[start].tick) < width)
        total += bytes(messages[end++]);
      const load = total + (clock ? Math.ceil((ticksPerSecond(tempo) / 40) * seconds) : 0);
      if (load / budget > worst.ratio)
        worst = { ratio: load / budget, start, end, bytes: load, budget };
      total -= bytes(messages[start]);
    }
  }
  return worst;
}
/** Give movable samples only the wire gaps left by clock, notes and required values. */
export function planWire(
  messages: Message[],
  port: Port,
  tempo: Rational,
  begin: bigint,
  end: bigint,
  clock: boolean,
): Message[] {
  const scale = ticksPerSecond(tempo) / port.rate;
  const wireCost = (m: Message) =>
    (bytes(m) + (m.nrpn && !m.data.some((p) => p[1] === 99) ? 6 : 0)) * scale;
  const noteStarts = new Set(
    messages.filter((m) => m.priority === 3).map((m) => `${m.instance}/${m.tick}`),
  );
  const rank = (m: Message) =>
    m.startup
      ? 0
      : m.priority === 0
        ? 1
        : m.priority === 3
          ? 3
          : noteStarts.has(`${m.instance}/${m.tick}`)
            ? 2
            : 4;
  const required = messages.filter((m) => !interior(m)).map((m) => ({ ...m }));
  const reservations: { at: number; cost: number; m?: Message; rank: number }[] = required.map(
    (m) => ({ at: Number(m.tick), cost: wireCost(m), m, rank: rank(m) }),
  );
  if (clock)
    for (let at = begin; at < end; at += 40n)
      reservations.push({ at: Number(at), cost: scale, rank: -1 });
  reservations.sort(
    (a, b) => a.at - b.at || a.rank - b.rank || (a.m?.order ?? 0) - (b.m?.order ?? 0),
  );
  const slots: { start: number; end: number }[] = [],
    boundaries = new Map<string, number[]>();
  let cursor = 0;
  for (const r of reservations) {
    const start = r.m ? Math.ceil(Math.max(r.at, cursor)) : Math.max(r.at, cursor);
    // Reserve clock bandwidth alongside the indivisible MIDI groups.
    if (r.m) r.m.tick = BigInt(Math.ceil(start));
    cursor = start + r.cost;
    slots.push({ start, end: cursor });
    if (r.m?.controlDestination) {
      const times = boundaries.get(r.m.controlDestination) ?? [];
      times.push(Number(r.m.tick));
      boundaries.set(r.m.controlDestination, times);
    }
  }
  const optional = messages.filter(interior).map((m) => ({ ...m }));
  let slot = 0,
    free = 0;
  const kept: Message[] = [];
  for (const m of optional) {
    const original = Number(m.tick),
      cost = wireCost(m);
    let at = Math.ceil(Math.max(original, free));
    while (slot < slots.length) {
      if (slots[slot].end <= at) {
        slot++;
        continue;
      }
      if (at + cost <= slots[slot].start) break;
      at = Math.ceil(slots[slot++].end);
    }
    const nextBoundary = boundaries.get(m.controlDestination!)?.find((t) => t >= original);
    if (
      at - original > ticksPerSecond(tempo) * 0.005 ||
      (nextBoundary !== undefined && at >= nextBoundary)
    )
      continue;
    m.tick = BigInt(Math.ceil(at));
    kept.push(m);
    free = at + cost;
  }
  return sorted([...required, ...kept]);
}
export function planPort(t: Timeline, clock: boolean): void {
  if (t.rig.implicit) return;
  for (const port of Object.values(t.rig.setup.ports)) {
    let messages = t.messages.filter((m) => m.instance.startsWith(port.id + '/'));
    const original = new Map<string, number>();
    for (const m of messages.filter(interior))
      original.set(m.controlDestination!, (original.get(m.controlDestination!) ?? 0) + 1);
    // Recompute NRPN selection after each thinning pass: an atomic selection is never dropped separately.
    for (let pass = 0; pass < 128; pass++) {
      messages = selection(sorted(messages));
      const musical = messages.filter((m) => !m.startup),
        peak = peakLoad(musical, port, t.song.tempo, clock && port.clock);
      if (peak.ratio <= 0.95) break;
      const busy = new Map<string, number>();
      for (const m of musical.slice(peak.start, peak.end).filter(interior))
        busy.set(m.controlDestination!, (busy.get(m.controlDestination!) ?? 0) + bytes(m));
      const key = [...busy].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
      if (!key) break;
      let coarse: number | undefined,
        droppedLSB = false;
      const thresholded = messages.filter((m) => {
        if (m.controlDestination !== key) return true;
        const bound = t.rig.parts.find((b) => b.part === m.source),
          param = bound?.instrument.params[m.parameter!];
        if (param?.bits !== 14) return true;
        const value =
          param.kind === 'pitchbend'
            ? m.data[0][2]
            : m.data.find((p) => p[1] === (param.kind === 'nrpn' ? 6 : param.address[0]))?.[2];
        if (interior(m) && value === coarse) {
          droppedLSB = true;
          return false;
        }
        coarse = value;
        return true;
      });
      if (droppedLSB) {
        messages = thresholded;
        continue;
      }
      let ordinal = 0;
      messages = messages.filter(
        (m) => !interior(m) || m.controlDestination !== key || ++ordinal % 2 === 0,
      );
    }
    messages = planWire(
      selection(sorted(messages)),
      port,
      t.song.tempo,
      t.offset,
      t.end,
      clock && port.clock,
    );
    messages = selection(messages);
    for (const [key, count] of original) {
      const kept = messages.filter((m) => interior(m) && m.controlDestination === key).length;
      if (kept < count) {
        t.adaptations.push({
          event: key,
          reason: 'controller thinning',
          before: count,
          after: kept,
        });
        t.diagnostics.push(
          diagnostic('D006', `Controller samples thinned on ${key}`, port.span, {
            severity: 'info',
            path: key,
            measured: {
              stream: key,
              samplesKept: kept,
              samplesDropped: count - kept,
              windowMs: 100,
              port: port.name,
            },
          }),
        );
      }
    }
    t.messages = [...t.messages.filter((m) => !m.instance.startsWith(port.id + '/')), ...messages];
  }
  t.messages = sorted(t.messages);
  const bySource = new Map<string, Message[]>();
  for (const m of t.messages)
    if (m.source) {
      const list = bySource.get(m.source) ?? [];
      list.push(m);
      bySource.set(m.source, list);
    }
  for (const n of t.notes) {
    const messages = bySource.get(n.event.id),
      on = messages?.find((m) => m.priority === 3),
      off = messages?.find((m) => m.priority === 0);
    if (on) n.start = on.tick - t.offset;
    if (off) n.end = off.tick - t.offset;
    if (n.legatoOff) n.legatoOff.end = n.start;
  }
  t.end = t.messages.reduce((end, m) => (m.tick > end ? m.tick : end), t.end);
}
