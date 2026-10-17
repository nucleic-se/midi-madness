import type { Rig } from './config.ts';
import { peakLoad } from './port-plan.ts';
import { tick, type Timeline } from './notes.ts';
export function sharedChannels(rig: Rig) {
  const groups = new Map<string, { port: string; channel: number; parts: string[] }>();
  for (const b of rig.parts) {
    const key = `${b.port.id}/${b.channel}`,
      group = groups.get(key) ?? { port: b.port.name, channel: b.channel, parts: [] };
    group.parts.push(b.part);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((g) => g.parts.length > 1)
    .map((group) => {
      const bindings = rig.parts.filter(
        (b) => b.port.name === group.port && b.channel === group.channel,
      );
      const kit = bindings.every(
        (b) =>
          b.instrument.voices === 'drums' &&
          b.instrument.laneMode === 'note-map' &&
          b.note !== undefined &&
          b.instrument.id === bindings[0].instrument.id,
      );
      return {
        ...group,
        ...(kit
          ? {
              kind: 'drum-kit' as const,
              instrument: bindings[0].instrument.id,
              laneCount: new Set(bindings.map((b) => b.note)).size,
            }
          : {}),
      };
    });
}
export function articulation(t: Timeline) {
  const handovers = new Set(
    t.messages
      .filter((m) => m.priority === 3 && m.data.some((p) => (p[0] & 240) === 128))
      .map((m) => m.source),
  );
  return t.rig.parts
    .filter((b) => b.instrument.voices === 'mono')
    .map((b) => {
      const notes = t.notes.filter((n) => n.event.part === b.part),
        slides = notes.filter((n) => n.legatoOff && handovers.has(n.event.id));
      return {
        part: b.part,
        channel: b.channel,
        notes: notes.length,
        slides: slides.length,
        unwrittenSlides: slides.filter(
          (n) =>
            n
              .legatoOff!.event.nominalOnset.add(n.legatoOff!.event.gate)
              .compare(n.event.nominalOnset) <= 0,
        ).length,
      };
    });
}
export function portMetrics(t: Timeline) {
  const ticksPerSecond = (Number(t.song.tempo.numerator) / Number(t.song.tempo.denominator)) * 16;
  return Object.values(t.rig.setup.ports).map((port) => ({
    port: port.name,
    rate: port.rate,
    clock: port.clock,
    sections: t.song.sections.map((section, index) => {
      const from = tick(section.onset) + t.offset,
        to = tick(section.onset.add(section.extent)) + t.offset,
        messages = t.messages.filter(
          (m) =>
            !m.startup &&
            m.instance.startsWith(port.id + '/') &&
            (index === 0 || m.tick >= from) &&
            (index === t.song.sections.length - 1 || m.tick < to),
        ),
        seconds = Number(to - from) / ticksPerSecond,
        clocks = port.clock
          ? Number(
              ((index === t.song.sections.length - 1 ? t.end : to) - t.offset + 39n) / 40n -
                (from - t.offset + 39n) / 40n,
            )
          : 0,
        bytes = messages.reduce((n, m) => n + m.data.reduce((n, p) => n + p.length, 0), clocks),
        peak = peakLoad(messages, port, t.song.tempo, port.clock);
      const peakRatio = Math.max(
        peak.ratio,
        port.clock ? Math.ceil(ticksPerSecond / 400) / (port.rate / 10) : 0,
      );
      return {
        path: section.path,
        seconds,
        bytes,
        averagePercent: seconds ? (bytes / seconds / port.rate) * 100 : 0,
        peakPercent: peakRatio * 100,
        headroomPercent: (1 - peakRatio) * 100,
      };
    }),
  }));
}
