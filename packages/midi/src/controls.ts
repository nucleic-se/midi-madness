import type { RealizationResult } from '../../core/src/index.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import { diagnostic } from '../../core/src/diag.ts';
import type { Bound, Parameter } from './config.ts';
import { instance, sorted, tick, type Message, type Timeline } from './notes.ts';
const zero = new R(0),
  epsilon = new R(1, 1000000000);
export function destination(p: Parameter): string {
  return `${p.kind}/${p.address.join('/')}`;
}
export function quantize(p: Parameter, value: number): number {
  const v = Math.max(p.bipolar ? -1 : 0, Math.min(1, value)),
    centre = p.bits === 14 ? 8192 : 64;
  return p.bipolar
    ? v < 0
      ? centre + Math.round(v * (centre - p.min))
      : centre + Math.round(v * (p.max - centre))
    : Math.round(p.min + v * (p.max - p.min));
}
export function encode(bound: Bound, p: Parameter, value: number): number[][] {
  const n = quantize(p, value),
    cc = 0xb0 + bound.channel - 1;
  if (p.kind === 'pitchbend') return [[0xe0 + bound.channel - 1, n & 127, (n >> 7) & 127]];
  if (p.kind === 'cc')
    return p.address.length === 2
      ? [
          [cc, p.address[0], (n >> 7) & 127],
          [cc, p.address[1], n & 127],
        ]
      : [[cc, p.address[0], n]];
  if (p.kind === 'nrpn')
    return [
      [cc, 99, p.address[0]],
      [cc, 98, p.address[1]],
      [cc, 6, p.bits === 14 ? (n >> 7) & 127 : n],
      ...(p.bits === 14 ? [[cc, 38, n & 127]] : []),
    ];
  return [];
}
export function selection(messages: Message[]): Message[] {
  const selected = new Map<string, string>();
  return messages.map((m) => {
    if (m.data.some((d) => (d[0] & 240) === 192)) selected.delete(m.instance);
    if (!m.nrpn) return m;
    const key = m.nrpn.join('/'),
      payload = m.data.filter((d) => ![98, 99].includes(d[1]));
    const data =
      selected.get(m.instance) === key
        ? payload
        : [
            [0xb0 + (m.data[0][0] & 15), 99, m.nrpn[0]],
            [0xb0 + (m.data[0][0] & 15), 98, m.nrpn[1]],
            ...payload,
          ];
    selected.set(m.instance, key);
    return { ...m, data };
  });
}
type Writer = {
  bound: Bound;
  name: string;
  p: Parameter;
  order: number;
  baseline?: number;
  priority: number;
};
export function compileControls(realized: RealizationResult, timeline: Timeline): void {
  if (timeline.rig.implicit || !realized.automation) return;
  const groups = new Map<string, Writer[]>(),
    auto = realized.automation;
  for (const [order, part] of timeline.song.parts.entries()) {
    const bound = timeline.rig.parts.find((b) => b.part === part.name);
    if (!bound) continue;
    const used = new Set([
      ...Object.keys(part.controls),
      ...part.events.flatMap((e) => Object.keys(e.locks)),
      ...Object.keys(bound.baselines),
    ]);
    for (const name of used) {
      const p = bound.instrument.params[name];
      if (!p) {
        timeline.diagnostics.push(
          diagnostic(
            'I001',
            `Instrument ${bound.instrument.id} does not support ${name}`,
            bound.span,
            { severity: 'warning', path: part.name },
          ),
        );
        continue;
      }
      const key = `${instance(bound)}/${destination(p)}`,
        writers = groups.get(key) ?? [];
      writers.push({
        bound,
        name,
        p,
        order,
        baseline: bound.baselines[name],
        priority: bound.startupKeys?.includes(name) ? 1 : 0,
      });
      groups.set(key, writers);
    }
  }
  for (const [key, writers] of groups) {
    let rate = Math.min(...writers.map((w) => w.p.rate));
    const boundaries: R[] = [new R(-timeline.offset, 3840), zero, timeline.song.extent];
    for (const w of writers) boundaries.push(...auto.boundaries(w.bound.part, w.name));
    const edges = [
        ...new Map(
          boundaries.filter((t) => t.compare(zero) >= 0).map((t) => [t.toString(), t]),
        ).values(),
      ].sort((a, b) => a.compare(b)),
      bar = new R(timeline.song.meter[0], timeline.song.meter[1]);
    if (
      edges.length > 1 &&
      edges.slice(1).every((edge, i) => edge.sub(edges[i]).compare(bar) > 0)
    ) {
      let slope = 0;
      for (const w of writers)
        for (let i = 1; i < edges.length; i++) {
          const duration = edges[i].sub(edges[i - 1]),
            seconds =
              ((Number(duration.numerator) / Number(duration.denominator)) * 240) /
              (Number(timeline.song.tempo.numerator) / Number(timeline.song.tempo.denominator));
          let previous = auto.at(w.bound.part, w.name, edges[i - 1]);
          for (let q = 1; q <= 4; q++) {
            const value = auto.at(
              w.bound.part,
              w.name,
              edges[i - 1].add(duration.mul(new R(q, 4))).sub(epsilon),
            );
            if (previous !== undefined && value !== undefined)
              slope = Math.max(slope, (Math.abs(value - previous) * 4) / seconds);
            previous = value;
          }
        }
      rate = Math.min(rate, Math.max(1, Math.ceil(slope * 127 * 2)));
    }
    const step = new R(1)
      .div(R.parse(String(rate)))
      .mul(timeline.song.tempo)
      .div(new R(240));
    const locks = writers.flatMap((w) =>
      timeline.notes
        .filter((n) => n.event.part === w.bound.part && n.event.locks[w.name] !== undefined)
        .map((n) => ({
          writer: w,
          start: new R(n.start, 3840),
          end: new R(n.end, 3840),
          value: n.event.locks[w.name],
          id: n.event.id,
        })),
    );
    for (const lock of locks) boundaries.push(lock.start, lock.end);
    const samples: R[] = [...boundaries];
    for (
      let t = zero, guard = 0;
      t.compare(timeline.song.extent) <= 0 && guard < 1000000;
      t = t.add(step), guard++
    )
      samples.push(t);
    const times = samples
        .sort((a, b) => a.compare(b))
        .filter((t, i, a) => !i || !t.equals(a[i - 1])),
      isBoundary = new Set(boundaries.map((t) => t.toString()));
    let last: number | undefined,
      lastMessage: Message | undefined,
      hadLock = false;
    function valueAt(time: R): { writer: Writer; value: number; lock?: boolean } | undefined {
      const active = locks
        .filter((l) => time.compare(l.start) >= 0 && time.compare(l.end) < 0)
        .sort(
          (a, b) =>
            b.start.compare(a.start) || a.writer.order - b.writer.order || a.id.localeCompare(b.id),
        );
      if (active.length) {
        hadLock = true;
        if (
          active.length > 1 &&
          !timeline.diagnostics.some((d) => d.code === 'P007' && d.path === key)
        )
          timeline.diagnostics.push(
            diagnostic(
              'P007',
              `Parts ${[...new Set(active.map((l) => l.writer.bound.part))].join(' and ')} share channel ${active[0].writer.bound.channel}: overlapping parameter locks`,
              active[0].writer.p.span,
              { severity: 'warning', path: key },
            ),
          );
        return { writer: active[0].writer, value: active[0].value, lock: true };
      }
      const expressions = writers
        .flatMap((w) => {
          const value = auto.at(w.bound.part, w.name, time),
            start = auto.regionStart(w.bound.part, w.name, time);
          return value === undefined ? [] : [{ writer: w, value, start: start ?? zero }];
        })
        .sort((a, b) => b.start.compare(a.start) || a.writer.order - b.writer.order);
      if (expressions.length) {
        if (
          expressions.length > 1 &&
          !timeline.diagnostics.some((d) => d.code === 'P007' && d.path === key)
        )
          timeline.diagnostics.push(
            diagnostic(
              'P007',
              `Parts ${[...new Set(expressions.map((e) => e.writer.bound.part))].join(' and ')} share channel ${expressions[0].writer.bound.channel}: overlapping expressions (play gates do not gate controllers)`,
              expressions[0].writer.p.span,
              { severity: 'warning', path: key },
            ),
          );
        return expressions[0];
      }
      const defaults = writers
        .filter((w) => w.baseline !== undefined)
        .sort((a, b) => b.priority - a.priority || a.order - b.order);
      if (defaults.length) return { writer: defaults[0], value: defaults[0].baseline! };
      if (hadLock && !timeline.diagnostics.some((d) => d.code === 'I004' && d.path === key))
        timeline.diagnostics.push(
          diagnostic(
            'I004',
            'Lock ended without a known expression/default fallback; retaining last value',
            writers[0].p.span,
            { severity: 'warning', path: key },
          ),
        );
      return;
    }
    function emit(time: R, sample: { writer: Writer; value: number; lock?: boolean } | undefined) {
      if (!sample) return;
      const encoded = quantize(sample.writer.p, sample.value);
      if (encoded === last) {
        if (isBoundary.has(time.toString()) && lastMessage) {
          lastMessage.required = true;
          lastMessage.priority = 2;
        }
        return;
      }
      last = encoded;
      const { writer: w, value } = sample;
      lastMessage = {
        tick: tick(time) + timeline.offset,
        priority: isBoundary.has(time.toString()) || sample.lock ? 2 : 4,
        order: w.order,
        instance: instance(w.bound),
        data: encode(w.bound, w.p, value),
        source: w.bound.part,
        parameter: w.name,
        nrpn: w.p.kind === 'nrpn' ? w.p.address : undefined,
        controlDestination: key,
        lock: sample.lock,
        required: isBoundary.has(time.toString()) || !!sample.lock,
      };
      timeline.messages.push(lastMessage);
    }
    for (const time of times) {
      if (time.compare(zero) > 0 && isBoundary.has(time.toString()))
        emit(time, valueAt(time.sub(epsilon)));
      emit(time, valueAt(time));
    }
  }
  timeline.messages = sorted(timeline.messages);
}
export function chase(realized: RealizationResult, timeline: Timeline, time: R): Message[] {
  const messages: Message[] = [],
    seen = new Set<string>();
  for (const [order, bound] of timeline.rig.parts.entries())
    for (const p of Object.values(bound.instrument.params)) {
      const key = `${instance(bound)}/${destination(p)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const previous = [...timeline.messages]
        .reverse()
        .find(
          (m) =>
            m.tick <= tick(time) + timeline.offset &&
            m.instance === instance(bound) &&
            m.parameter &&
            m.controlDestination === key,
        );
      if (previous) {
        const writer = timeline.rig.parts.find((b) => b.part === previous.source),
          param = writer?.instrument.params[previous.parameter!],
          value =
            !previous.lock && writer && param
              ? (realized.automation?.at(writer.part, param.name, time) ??
                writer.baselines[param.name])
              : undefined;
        messages.push(
          value !== undefined && writer && param
            ? { ...previous, tick: 0n, data: encode(writer, param, value) }
            : { ...previous, tick: 0n },
        );
      } else {
        const value = realized.automation?.at(bound.part, p.name, time) ?? bound.baselines[p.name];
        if (value !== undefined)
          messages.push({
            tick: 0n,
            priority: 2,
            order,
            instance: instance(bound),
            data: encode(bound, p, value),
            parameter: p.name,
            nrpn: p.kind === 'nrpn' ? p.address : undefined,
          });
      }
    }
  return messages;
}
