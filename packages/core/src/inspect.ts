import { keyAt } from './structure.ts';
import type { installHarmony } from './harmony.ts';
import type { Event, SongIR, Structure } from './ir.ts';
import { Rational as R } from '@midi-madness/foundation/time';
const zero = new R(0);
export function noteName(pitch: number): string {
  return (
    ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][((pitch % 12) + 12) % 12] +
    String(Math.floor(pitch / 12) - 1)
  );
}
export function timeAt(song: SongIR, input: string, numericBar = false): R {
  const bar = input.match(/^bar\s+(\d+)$/);
  if (bar || (numericBar && /^\d+$/.test(input))) {
    const b = song.bars[Number(bar?.[1] ?? input) - 1];
    if (!b) throw new RangeError('Bar is outside the form');
    return b.onset;
  }
  const clock = input.match(/^(\d+):([\d.]+)$/);
  if (clock)
    return new R(Number(clock[1]) * 60).add(R.parse(clock[2])).mul(song.tempo).div(new R(240));
  return R.parse(input);
}
/** One-based quarter-note beats, matching the foundation time coordinate contract. */
export function positionAt(song: SongIR, time: R) {
  const bar = song.bars.find(
    (b) => time.compare(b.onset) >= 0 && time.compare(b.onset.add(b.span)) < 0,
  );
  return {
    bar: bar?.number,
    sectionBar: bar?.sectionBar,
    beat: bar ? time.sub(bar.onset).mul(new R(4)).add(new R(1)) : undefined,
  };
}
export function harmonyRoll(
  structure: Structure,
  harmony: ReturnType<typeof installHarmony>,
  first = 1,
  last = 8,
) {
  return structure.bars
    .filter((b) => b.number >= first && b.number <= last)
    .map((bar) => {
      const end = bar.onset.add(bar.span);
      const boundaries = [
        bar.onset,
        ...harmony.layers.flatMap((l) => [
          l.start,
          l.start.add(l.extent),
          ...l.chords.flatMap((c) => [c.onset, c.onset.add(c.span)]),
        ]),
        ...structure.sections.map((s) => s.onset),
      ].filter((t) => t.compare(bar.onset) >= 0 && t.compare(end) < 0);
      const times = [...new Map(boundaries.map((t) => [t.toString(), t])).values()].sort((a, b) =>
        a.compare(b),
      );
      const changes = times
        .map((time) => {
          const key = keyAt(structure, time);
          const declared = harmony.layers.some(
            (l) => time.compare(l.start) >= 0 && time.compare(l.start.add(l.extent)) < 0,
          );
          return {
            time,
            beat: time.sub(bar.onset).mul(new R(4)).add(new R(1)),
            key: `${key.name} ${key.mode}`,
            chord: declared ? harmony.chordAt(time).symbol : null,
          };
        })
        .filter((c, i, all) => i === 0 || c.key !== all[i - 1].key || c.chord !== all[i - 1].chord);
      return { bar: bar.number, changes };
    });
}
export function at(song: SongIR, time: R) {
  const position = positionAt(song, time),
    section = song.sections.find(
      (s) => time.compare(s.onset) >= 0 && time.compare(s.onset.add(s.extent)) < 0,
    );
  return {
    time,
    seconds: time.mul(new R(240)).div(song.tempo),
    ...position,
    path: section?.path,
    section: section?.name,
    sounding: song.parts
      .map((p) => ({
        part: p.name,
        events: p.events.filter(
          (e) => e.nominalOnset.compare(time) <= 0 && e.nominalOnset.add(e.gate).compare(time) > 0,
        ),
      }))
      .filter((p) => p.events.length),
  };
}
export function metrics(song: SongIR) {
  return song.sections.map((section) => ({
    name: section.name,
    path: section.path,
    onset: section.onset,
    extent: section.extent,
    parts: song.parts.map((part) => {
      const events = part.events.filter(
          (e) =>
            e.nominalOnset.compare(section.onset) >= 0 &&
            e.nominalOnset.compare(section.onset.add(section.extent)) < 0,
        ),
        onsets = new Set(events.map((e) => e.nominalOnset.toString())).size,
        pitches = events.flatMap((e) => (e.pitch === null ? [] : [e.pitch]));
      return {
        name: part.name,
        events: events.length,
        onsets,
        range: pitches.length ? [Math.min(...pitches), Math.max(...pitches)] : null,
        onsetsPerBar:
          onsets /
          (Number(section.extent.numerator) /
            Number(section.extent.denominator) /
            (song.meter[0] / song.meter[1])),
      };
    }),
  }));
}
export function roll(song: SongIR, partName?: string, first = 1, last = 8): string {
  const bars = song.bars.filter((b) => b.number >= first && b.number <= last),
    lines: string[] = [];
  for (const part of song.parts.filter((p) => !partName || p.name === partName)) {
    lines.push(`${part.name} (${part.kind}${part.lane ? `, ${part.lane}` : ''})`);
    for (const bar of bars) {
      const events = part.events.filter(
          (e) =>
            e.nominalOnset.compare(bar.onset.add(bar.span)) < 0 &&
            e.nominalOnset.add(e.gate).compare(bar.onset) > 0,
        ),
        pitches = [...new Set(events.map((e) => e.pitch))].sort((a, b) => (b ?? -1) - (a ?? -1)),
        slots = Number(bar.span.mul(new R(16)).floor());
      lines.push(`  bar ${bar.number}  ${bar.section}#${bar.sectionBar}  ${bar.path}`);
      for (const pitch of pitches) {
        let row = '';
        for (let i = 0; i < slots; i++) {
          const t = bar.onset.add(new R(i, 16)),
            end = t.add(new R(1, 16));
          row += events.some(
            (e) =>
              e.pitch === pitch &&
              e.nominalOnset.compare(t) >= 0 &&
              e.nominalOnset.compare(end) < 0,
          )
            ? 'x'
            : events.some(
                  (e) =>
                    e.pitch === pitch &&
                    e.nominalOnset.compare(t) < 0 &&
                    e.nominalOnset.add(e.gate).compare(t) > 0,
                )
              ? '-'
              : '.';
        }
        lines.push(
          `    ${(pitch === null ? (part.lane ?? 'hit') : noteName(pitch)).padStart(5)} |${row}|`,
        );
      }
      if (!pitches.length) lines.push('    rest');
    }
  }
  if (partName && !song.parts.some((p) => p.name === partName))
    throw new RangeError(`Unknown part ${partName}`);
  return lines.join('\n');
}
export function eventMeaning(event: Event) {
  return {
    onset: event.nominalOnset,
    performed: event.performedOnset,
    writtenSpan: event.writtenSpan,
    gate: event.gate,
    pitch: event.pitch,
    velocity: event.velocity,
    locks: event.locks,
  };
}
export function musicalDiff(before: SongIR, after: SongIR) {
  const parts = [
    ...new Set([...before.parts.map((p) => p.name), ...after.parts.map((p) => p.name)]),
  ].sort();
  return {
    extent: { before: before.extent, after: after.extent },
    parts: parts
      .map((name) => {
        const a = before.parts.find((p) => p.name === name),
          b = after.parts.find((p) => p.name === name),
          old = a?.events ?? [],
          next = b?.events ?? [],
          moved: { before: R; after: R }[] = [],
          changed: {
            before?: ReturnType<typeof eventMeaning>;
            after?: ReturnType<typeof eventMeaning>;
          }[] = [];
        for (let i = 0; i < Math.max(old.length, next.length); i++) {
          const previous = old[i] ? eventMeaning(old[i]) : undefined,
            current = next[i] ? eventMeaning(next[i]) : undefined;
          if (JSON.stringify(previous) !== JSON.stringify(current)) {
            const content = (e: ReturnType<typeof eventMeaning>) => ({
              writtenSpan: e.writtenSpan,
              gate: e.gate,
              pitch: e.pitch,
              velocity: e.velocity,
              locks: e.locks,
            });
            if (
              previous &&
              current &&
              JSON.stringify(content(previous)) === JSON.stringify(content(current)) &&
              !previous.onset.equals(current.onset)
            )
              moved.push({ before: previous.onset, after: current.onset });
            else changed.push({ before: previous, after: current });
          }
        }
        return {
          name,
          changed,
          moved,
          controlsChanged:
            JSON.stringify(controlMeaning(a?.controls)) !==
            JSON.stringify(controlMeaning(b?.controls)),
        };
      })
      .filter((p) => p.changed.length || p.moved.length || p.controlsChanged),
  };
}

export function controlMeaning(controls: import('./ir.ts').PartIR['controls'] | undefined) {
  return Object.fromEntries(
    Object.entries(controls ?? {}).map(([name, points]) => [
      name,
      points.map((p) => ({ time: p.time, value: p.value })),
    ]),
  );
}
