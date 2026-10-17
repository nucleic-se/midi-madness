import { Rational as R } from '@midi-madness/foundation/time';
import { diagnostic } from '../../core/src/diag.ts';
import type { Bound, Parameter } from './config.ts';
import { destination, encode, selection } from './controls.ts';
import { instance, sorted, tick, type Message, type Timeline } from './notes.ts';
export function initialize(t: Timeline): void {
  if (t.rig.implicit) return;
  const instances = [...new Map(t.rig.parts.map((b) => [instance(b), b])).values()],
    ports = new Set(instances.map((b) => b.port.id));
  if (ports.size > 1) {
    t.diagnostics.push(
      diagnostic(
        'R003',
        'First MIDI version supports one logical output per song',
        t.rig.setup.span,
      ),
    );
    return;
  }
  const secondsToTicks = (seconds: R) => seconds.mul(t.song.tempo).mul(new R(16));
  let cursor = new R(0),
    ready = new R(0);
  const messages: Message[] = [];
  for (const [order, b] of instances.entries())
    if (b.program) {
      const data: number[][] = [],
        ch = b.channel - 1;
      for (const [i, n] of b.program.bank.entries())
        data.push([0xb0 + ch, b.instrument.program!.controllers[i], n]);
      data.push([0xc0 + ch, b.program.pc]);
      const at = cursor;
      cursor = cursor.add(
        secondsToTicks(
          new R(data.reduce((n, p) => n + p.length, 0)).div(R.parse(String(b.port.rate))),
        ),
      );
      const loaded = cursor.add(secondsToTicks(b.instrument.lead.div(new R(1000))));
      if (loaded.compare(ready) > 0) ready = loaded;
      messages.push({
        tick: at.floor(),
        priority: 1,
        order,
        instance: instance(b),
        data,
        startup: true,
      });
    }
  if (cursor.compare(ready) < 0) cursor = ready;
  const defaults = new Map<
    string,
    { b: Bound; p: Parameter; value: number; priority: number; order: number }
  >();
  for (const [order, b] of t.rig.parts.entries())
    for (const [name, value] of Object.entries(b.baselines)) {
      const p = b.instrument.params[name],
        key = `${instance(b)}/${destination(p)}`,
        priority = b.startupKeys?.includes(name) ? 1 : 0,
        prior = defaults.get(key);
      if (prior && prior.priority === priority && prior.value !== value) {
        t.diagnostics.push(
          diagnostic('R004', 'Conflicting startup aliases target the same controller', p.span),
        );
        continue;
      }
      if (!prior || priority > prior.priority) defaults.set(key, { b, p, value, priority, order });
    }
  for (const { b, p, value, order } of defaults.values()) {
    const data = encode(b, p, value);
    messages.push({
      tick: cursor.floor() + 1n,
      priority: 2,
      order,
      instance: instance(b),
      data,
      parameter: p.name,
      controlDestination: `${instance(b)}/${destination(p)}`,
      nrpn: p.kind === 'nrpn' ? p.address : undefined,
      source: b.part,
      startup: true,
    });
    cursor = cursor.add(
      secondsToTicks(
        new R(data.reduce((n, p) => n + p.length, 0)).div(R.parse(String(b.port.rate))),
      ),
    );
  }
  const shift = cursor.numerator === 0n ? 0n : cursor.floor() + 1n;
  t.messages = t.messages.map((m) => ({ ...m, tick: m.tick + shift }));
  t.offset += shift;
  t.end += shift;
  const combined = sorted([...messages, ...t.messages]),
    values = new Map<string, string>();
  t.messages = selection(
    combined.filter((m) => {
      if (!m.controlDestination) return true;
      const value = JSON.stringify(m.data),
        old = values.get(m.controlDestination);
      values.set(m.controlDestination, value);
      return value !== old;
    }),
  );
}
export function checkLoad(t: Timeline, clock = false): void {
  if (t.rig.implicit) return;
  for (const port of Object.values(t.rig.setup.ports)) {
    const entries = t.messages
      .filter((m) => !m.startup && m.instance.startsWith(port.id + '/'))
      .map((m) => ({ m, bytes: m.data.reduce((n, d) => n + d.length, 0) }));
    let worst = 0,
      busiest:
        { start: bigint; bytes: number; budget: number; parameters: Set<string> } | undefined;
    for (const duration of [100, 1000]) {
      const width =
          ((Number(t.song.tempo.numerator) / Number(t.song.tempo.denominator)) * 16 * duration) /
          1000,
        budget = (port.rate * duration) / 1000;
      let end = 0,
        bytes = 0;
      for (let start = 0; start < entries.length; start++) {
        while (
          end < entries.length &&
          Number(entries[end].m.tick - entries[start].m.tick) < width
        ) {
          bytes += entries[end].bytes;
          end++;
        }
        const total =
            bytes +
            (clock && port.clock
              ? Math.ceil(
                  ((((Number(t.song.tempo.numerator) / Number(t.song.tempo.denominator)) * 24) /
                    60) *
                    duration) /
                    1000,
                )
              : 0),
          ratio = total / budget;
        if (ratio > worst) {
          worst = ratio;
          busiest = {
            start: entries[start].m.tick,
            bytes: total,
            budget,
            parameters: new Set(
              entries.slice(start, end).flatMap((e) => (e.m.parameter ? [e.m.parameter] : [])),
            ),
          };
        }
        bytes -= entries[start].bytes;
      }
    }
    if (worst > 1 && busiest) {
      t.diagnostics.push(
        diagnostic(
          'D005',
          `Required MIDI traffic ${(worst * 100).toFixed(0)}% exceeds capacity: ${[...busiest.parameters].join(', ') || 'note density'}`,
          port.span,
          {
            severity: 'error',
            measured: {
              port: port.name,
              startTick: String(busiest.start),
              bytes: busiest.bytes,
              budget: busiest.budget,
              parameters: [...busiest.parameters],
            },
            causes: [
              'Interior controller samples have already yielded. Reduce note density or required controller boundaries, or configure the actual faster port rate.',
            ],
          },
        ),
      );
    }
  }
}
