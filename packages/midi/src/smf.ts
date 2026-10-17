import type { Timeline } from './notes.ts';
import { tick } from './notes.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import { diagnostic } from '../../core/src/diag.ts';
const text = (value: string) => [...new TextEncoder().encode(value)];
const u16 = (n: number) => [(n >> 8) & 255, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function variable(value: bigint): number[] {
  if (value < 0n || value > 0x0fffffffn) throw new RangeError('MIDI delta exceeds four-byte range');
  const bytes = [Number(value & 127n)];
  while ((value >>= 7n) > 0n) bytes.unshift(Number(value & 127n) | 128);
  return bytes;
}
type Entry = { tick: bigint; bytes: number[] };
function meta(type: number, bytes: number[]): number[] {
  return [255, type, ...variable(BigInt(bytes.length)), ...bytes];
}
function track(entries: Entry[], end: bigint): number[] {
  const body: number[] = [];
  let previous = 0n;
  for (const entry of entries.sort((a, b) => (a.tick < b.tick ? -1 : a.tick > b.tick ? 1 : 0))) {
    body.push(...variable(entry.tick - previous), ...entry.bytes);
    previous = entry.tick;
  }
  body.push(...variable((end > previous ? end : previous) - previous), 255, 47, 0);
  return [...text('MTrk'), ...u32(body.length), ...body];
}
export function writeMidi(timeline: Timeline): Uint8Array {
  const { song, rig, offset, end } = timeline,
    tempo = Math.round((60000000 * Number(song.tempo.denominator)) / Number(song.tempo.numerator));
  if (tempo < 1 || tempo > 0xffffff) throw new RangeError('Tempo is outside MIDI tempo range');
  const conductor: Entry[] = [
    { tick: 0n, bytes: meta(3, text(song.title)) },
    { tick: 0n, bytes: meta(81, [(tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255]) },
    { tick: offset, bytes: meta(6, text('mm:start')) },
  ];
  const signature = (time: bigint, n: number, d: number) =>
    conductor.push({ tick: time, bytes: meta(88, [n, Math.log2(d), 24, 8]) });
  const bar = new R(...song.meter);
  for (const section of song.sections) {
    signature(tick(section.onset) + offset, ...song.meter);
    conductor.push({ tick: tick(section.onset) + offset, bytes: meta(6, text(section.path)) });
    const remainder = section.extent.mod(bar);
    if (remainder.compare(new R(0)) > 0) {
      const at = tick(section.onset.add(bar.mul(new R(section.extent.div(bar).floor())))) + offset;
      let denominator = song.meter[1];
      while (denominator <= 64 && remainder.mul(new R(denominator)).denominator !== 1n)
        denominator *= 2;
      if (denominator <= 64) {
        const numerator = Number(remainder.mul(new R(denominator)).numerator);
        if (numerator <= 255) signature(at, numerator, denominator);
      } else
        timeline.diagnostics.push(
          diagnostic('D004', 'Partial bar cannot be encoded as MIDI meter', section.source, {
            severity: 'warning',
            path: section.path,
            measured: { span: remainder },
          }),
        );
    }
  }
  const groups = new Map<string, Entry[]>();
  for (const bound of rig.parts) {
    const key = `${bound.port.id}/${bound.channel}`;
    if (!groups.has(key))
      groups.set(key, [
        {
          tick: 0n,
          bytes: meta(
            3,
            text(
              `${rig.parts
                .filter((b) => `${b.port.id}/${b.channel}` === key)
                .map((b) => b.part)
                .join(', ')} [ch ${bound.channel}]`,
            ),
          ),
        },
        { tick: 0n, bytes: meta(32, [bound.channel - 1]) },
      ]);
  }
  for (const message of timeline.messages) {
    const entries = groups.get(message.instance);
    if (!entries) continue;
    for (const bytes of message.data) entries.push({ tick: message.tick, bytes });
  }
  const tracks = [
    track(conductor, end),
    ...[...groups.values()].map((entries) => track(entries, end)),
  ];
  return Uint8Array.from([
    ...text('MThd'),
    ...u32(6),
    ...u16(1),
    ...u16(tracks.length),
    ...u16(960),
    ...tracks.flat(),
  ]);
}
