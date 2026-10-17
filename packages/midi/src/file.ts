/** Standard MIDI File primitives, independent of hardware rigs. */
export type FileEvent = { tick: number; data: number[]; order?: number };
export function variable(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff)
    throw new RangeError('MIDI delta exceeds four-byte range');
  const bytes = [value & 127];
  while ((value = Math.floor(value / 128)) > 0) bytes.unshift((value & 127) | 128);
  return bytes;
}
export const meta = (type: number, value: number[] | string) => {
  const bytes = typeof value === 'string' ? [...Buffer.from(value, 'utf8')] : value;
  return [255, type, ...variable(bytes.length), ...bytes];
};
export function midiFile(tracks: FileEvent[][], end: number, ppq: number): Buffer {
  const header = Buffer.alloc(14);
  header.write('MThd');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(tracks.length === 1 ? 0 : 1, 8);
  header.writeUInt16BE(tracks.length, 10);
  header.writeUInt16BE(ppq, 12);
  const buffers = [header];
  for (const entries of tracks) {
    const body: number[] = [];
    let previous = 0;
    for (const entry of [...entries].sort(
      (a, b) => a.tick - b.tick || (a.order ?? 0) - (b.order ?? 0),
    )) {
      if (entry.tick > end) throw new RangeError('MIDI event exceeds declared duration');
      body.push(...variable(entry.tick - previous), ...entry.data);
      previous = entry.tick;
    }
    body.push(...variable(end - previous), 255, 47, 0);
    const chunk = Buffer.alloc(8);
    chunk.write('MTrk');
    chunk.writeUInt32BE(body.length, 4);
    buffers.push(chunk, Buffer.from(body));
  }
  return Buffer.concat(buffers);
}
