import type { Event, SongIR } from '../../core/src/ir.ts';
import { diagnostic, type Diagnostic } from '../../core/src/diag.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import type { Bound, Rig } from './config.ts';
export type Adaptation = { event: string; reason: string; before?: unknown; after?: unknown };
export type Note = {
  event: Event;
  bound: Bound;
  order: number;
  pitch: number;
  velocity: number;
  start: bigint;
  end: bigint;
  legatoOff?: Note;
  pairedOff?: boolean;
};
export type Message = {
  tick: bigint;
  priority: number;
  order: number;
  instance: string;
  data: number[][];
  source?: string;
  parameter?: string;
  nrpn?: number[];
  controlDestination?: string;
  lock?: boolean;
  startup?: boolean;
  required?: boolean;
};
export type Timeline = {
  song: SongIR;
  rig: Rig;
  messages: Message[];
  notes: Note[];
  diagnostics: Diagnostic[];
  adaptations: Adaptation[];
  offset: bigint;
  end: bigint;
};
export function tick(time: R): bigint {
  const scaled = time.mul(new R(3840)),
    base = scaled.floor();
  return base + (scaled.sub(new R(base)).compare(new R(1, 2)) >= 0 ? 1n : 0n);
}
export function instance(b: Bound): string {
  return `${b.port.id}/${b.channel}`;
}
export function sorted(messages: Message[]): Message[] {
  return messages.sort((a, b) =>
    a.tick < b.tick
      ? -1
      : a.tick > b.tick
        ? 1
        : a.priority - b.priority ||
          a.order - b.order ||
          a.instance.localeCompare(b.instance) ||
          (a.data[0]?.[1] ?? 0) - (b.data[0]?.[1] ?? 0),
  );
}
export function compileNotes(song: SongIR, rig: Rig): Timeline {
  const diagnostics = [...rig.diagnostics],
    adaptations: Adaptation[] = [],
    all: Note[] = [];
  for (const [order, part] of song.parts.entries()) {
    const bound = rig.parts.find((b) => b.part === part.name);
    if (!bound) continue;
    for (const event of part.events) {
      if (event.velocity <= 0 || event.gate.compare(new R(0)) <= 0) {
        adaptations.push({ event: event.id, reason: 'silent attack' });
        continue;
      }
      let pitch = event.pitch ?? bound.note;
      if (pitch === undefined) {
        diagnostics.push(
          diagnostic('R003', 'Drum note has no mapping', bound.span, { path: event.path }),
        );
        continue;
      }
      if (event.pitch !== null && bound.instrument.transpose) {
        const before = pitch;
        pitch += bound.instrument.transpose;
        adaptations.push({ event: event.id, reason: 'device transpose', before, after: pitch });
      }
      if (
        event.pitch !== null &&
        (pitch < bound.instrument.range[0] || pitch > bound.instrument.range[1])
      ) {
        const options: number[] = [];
        for (let p = 0; p <= 127; p++)
          if (
            (p - pitch) % 12 === 0 &&
            p >= bound.instrument.range[0] &&
            p <= bound.instrument.range[1]
          )
            options.push(p);
        const written = pitch;
        pitch = options.sort((a, b) => Math.abs(a - written) - Math.abs(b - written) || a - b)[0];
        if (pitch === undefined) {
          diagnostics.push(
            diagnostic('R003', 'No octave fits the instrument range', bound.span, {
              path: event.path,
            }),
          );
          continue;
        }
        adaptations.push({
          event: event.id,
          reason: 'device range',
          before: written,
          after: pitch,
        });
        if (!diagnostics.some((d) => d.code === 'P004' && d.path === `${part.name}/${event.path}`))
          diagnostics.push(
            diagnostic(
              'P004',
              'Notes folded to instrument register',
              (event.provenance.source as { span: import('../../core/src/diag.ts').Span }).span,
              {
                causes: [
                  `Binding ${bound.span.file ?? 'setup'}:${bound.span.line}, channel ${bound.channel}`,
                ],
                severity: 'warning',
                path: `${part.name}/${event.path}`,
                measured: { written, folded: pitch, range: bound.instrument.range },
              },
            ),
          );
      }
      const latency = bound.instrument.latency.mul(song.tempo).div(new R(240000)),
        start = tick(event.performedOnset.sub(latency));
      let end = tick(event.performedOnset.add(event.gate).sub(latency));
      if (end <= start) {
        end = start + 1n;
        adaptations.push({ event: event.id, reason: 'positive gate extended to one tick' });
      }
      all.push({
        event,
        bound,
        order,
        pitch,
        velocity: Math.max(1, Math.min(127, Math.round(1 + event.velocity * 126))),
        start,
        end,
      });
    }
  }
  all.sort((a, b) =>
    a.start < b.start
      ? -1
      : a.start > b.start
        ? 1
        : a.order - b.order || a.pitch - b.pitch || a.event.id.localeCompare(b.event.id),
  );
  const merged: Note[] = [];
  for (const n of all) {
    const prior = merged.find(
      (p) => instance(p.bound) === instance(n.bound) && p.start === n.start && p.pitch === n.pitch,
    );
    if (prior) {
      prior.velocity = Math.max(prior.velocity, n.velocity);
      if (n.end > prior.end) prior.end = n.end;
      adaptations.push({
        event: n.event.id,
        reason: 'equal-onset duplicate merged',
        after: prior.event.id,
      });
      diagnostics.push(
        diagnostic(
          'D003',
          'Equal-onset same-pitch attacks merged',
          (n.event.provenance.source as { span: import('../../core/src/diag.ts').Span }).span,
          {
            causes: [
              `Binding ${n.bound.span.file ?? 'setup'}:${n.bound.span.line}, channel ${n.bound.channel}`,
            ],
            severity: 'warning',
            path: `${n.event.part}/${n.event.path}`,
          },
        ),
      );
    } else merged.push(n);
  }
  const active = new Map<string, Note[]>();
  const stacks = new Map<string, Note[]>();
  for (const n of merged) {
    if (n.bound.instrument.voices !== 'mono') continue;
    const key = `${n.event.part}/${n.event.nominalOnset}`;
    const notes = stacks.get(key) ?? [];
    notes.push(n);
    stacks.set(key, notes);
  }
  for (const notes of stacks.values()) {
    const pitches = new Set(notes.map((n) => n.pitch)),
      first = notes[0];
    if (pitches.size < 2) continue;
    diagnostics.push(
      diagnostic(
        'D002',
        `${first.event.part}: ${pitches.size}-note stack on mono instrument (ch ${first.bound.channel}); only one note can sound`,
        (first.event.provenance.source as { span: import('../../core/src/diag.ts').Span }).span,
        {
          severity: 'warning',
          path: `${first.event.part}/${first.event.path}`,
          measured: { notes: pitches.size, channel: first.bound.channel },
          causes: [`Binding ${first.bound.span.file ?? 'setup'}:${first.bound.span.line}`],
        },
      ),
    );
  }
  // Device articulation follows the written gates, independent of humanize jitter.
  for (const prior of merged) {
    const next = merged.find(
      (n) =>
        instance(n.bound) === instance(prior.bound) &&
        n.event.nominalOnset.compare(prior.event.nominalOnset) > 0 &&
        (prior.bound.instrument.voices === 'mono' || n.pitch === prior.pitch),
    );
    if (!next) continue;
    const overlap =
      prior.event.nominalOnset.add(prior.event.gate).compare(next.event.nominalOnset) > 0;
    if (!overlap && prior.end > next.start) prior.end = next.start;
    else if (
      overlap &&
      prior.bound.instrument.voices === 'mono' &&
      prior.bound.instrument.legato &&
      prior.pitch !== next.pitch &&
      prior.end <= next.start
    )
      prior.end = next.start + 1n;
  }
  for (const n of merged) {
    const key = instance(n.bound),
      live = (active.get(key) ?? []).filter((p) => p.end > n.start);
    for (const prior of live.filter((p) => p.pitch === n.pitch)) {
      adaptations.push({
        event: prior.event.id,
        reason: 'same-pitch overlap shortened',
        before: String(prior.end),
        after: String(n.start),
      });
      prior.end = n.start;
      diagnostics.push(
        diagnostic(
          'D003',
          'Same-pitch overlap shortened',
          (n.event.provenance.source as { span: import('../../core/src/diag.ts').Span }).span,
          {
            causes: [
              `Binding ${n.bound.span.file ?? 'setup'}:${n.bound.span.line}, channel ${n.bound.channel}`,
            ],
            severity: 'warning',
            path: `${n.event.part}/${n.event.path}`,
          },
        ),
      );
    }
    const others = live.filter((p) => p.end > n.start),
      cap = n.bound.instrument.voices === 'mono' ? 1 : n.bound.instrument.cap;
    if (cap && others.length >= cap) {
      const victims = others.slice(0, others.length - cap + 1);
      for (const previous of victims) {
        previous.end = n.start;
        if (
          n.bound.instrument.voices === 'mono' &&
          n.bound.instrument.legato &&
          previous.pitch !== n.pitch
        ) {
          n.legatoOff = previous;
          previous.pairedOff = true;
        }
        adaptations.push({
          event: previous.event.id,
          reason: 'voice handover/steal',
          after: n.event.id,
        });
        if (
          previous.event.part !== n.event.part ||
          !previous.event.nominalOnset.equals(n.event.nominalOnset)
        )
          diagnostics.push(
            diagnostic(
              'D002',
              'Instrument voice policy shortened a note',
              (n.event.provenance.source as { span: import('../../core/src/diag.ts').Span }).span,
              {
                causes: [
                  `Binding ${n.bound.span.file ?? 'setup'}:${n.bound.span.line}, channel ${n.bound.channel}`,
                ],
                severity: 'warning',
                path: `${n.event.part}/${n.event.path}`,
              },
            ),
          );
      }
    }
    active.set(key, [...others.filter((p) => p.end > n.start), n]);
  }
  const notes = merged.filter((n) => n.end > n.start),
    minimum = notes.reduce((m, n) => (n.start < m ? n.start : m), 0n),
    offset = -minimum,
    messages: Message[] = [];
  for (const n of notes) {
    const channel = n.bound.channel - 1,
      on = [[0x90 + channel, n.pitch, n.velocity]];
    if (n.legatoOff && n.legatoOff.end > n.legatoOff.start)
      on.push([0x80 + channel, n.legatoOff.pitch, 0]);
    messages.push({
      tick: n.start + offset,
      priority: 3,
      order: n.order,
      instance: instance(n.bound),
      data: on,
      source: n.event.id,
    });
    if (!n.pairedOff)
      messages.push({
        tick: n.end + offset,
        priority: 0,
        order: n.order,
        instance: instance(n.bound),
        data: [[0x80 + channel, n.pitch, 0]],
        source: n.event.id,
      });
  }
  const grouped: Diagnostic[] = [];
  for (const d of diagnostics) {
    const prior = grouped.find(
      (p) =>
        p.code === d.code &&
        p.path === d.path &&
        p.message === d.message &&
        p.severity === d.severity,
    );
    if (prior && ['D002', 'D003'].includes(d.code))
      prior.measured = { ...prior.measured, count: Number(prior.measured?.count ?? 1) + 1 };
    else grouped.push(d);
  }
  const end = notes.reduce(
    (m, n) => (n.end + offset > m ? n.end + offset : m),
    tick(song.extent) + offset,
  );
  return { song, rig, messages: sorted(messages), notes, diagnostics, adaptations, offset, end };
}
