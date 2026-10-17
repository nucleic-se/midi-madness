import { openSync, writeSync, closeSync } from 'node:fs';
export function writeWav(
  path: string,
  left: Float32Array,
  right: Float32Array,
  sr: number,
  from = 0,
  to = left.length,
  float = false,
) {
  const frames = to - from,
    stride = float ? 8 : 6,
    bytes = frames * stride;
  if (bytes > 0xffffffff - 36) throw new RangeError('Render exceeds WAV 4GB limit');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(bytes + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(float ? 3 : 1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * stride, 28);
  header.writeUInt16LE(stride, 32);
  header.writeUInt16LE(float ? 32 : 24, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  const fd = openSync(path, 'w'),
    chunk = Buffer.alloc(4096 * stride);
  try {
    writeSync(fd, header);
    for (let i = from; i < to; i += 4096) {
      const count = Math.min(4096, to - i);
      for (let j = 0; j < count; j++) {
        if (float) {
          chunk.writeFloatLE(left[i + j], j * stride);
          chunk.writeFloatLE(right[i + j], j * stride + 4);
          continue;
        }
        chunk.writeIntLE(Math.round(Math.max(-1, Math.min(1, left[i + j])) * 8388607), j * 6, 3);
        chunk.writeIntLE(
          Math.round(Math.max(-1, Math.min(1, right[i + j])) * 8388607),
          j * 6 + 3,
          3,
        );
      }
      writeSync(fd, chunk, 0, count * stride);
    }
  } finally {
    closeSync(fd);
  }
}

/** First-order ACN/SN3D ambisonics: four interleaved IEEE float channels. */
export function writeAmbisonicWav(
  path: string,
  channels: Float32Array[],
  sr: number,
  from = 0,
  to = channels[0].length,
) {
  if (channels.length !== 4) throw new RangeError('First-order ambisonics needs W,Y,Z,X channels');
  const bytes = (to - from) * 16;
  if (bytes > 0xffffffff - 36) throw new RangeError('Render exceeds WAV 4GB limit');
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(bytes + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(4, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * 16, 28);
  header.writeUInt16LE(16, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  const fd = openSync(path, 'w'),
    chunk = Buffer.alloc(4096 * 16);
  try {
    writeSync(fd, header);
    for (let i = from; i < to; i += 4096) {
      const count = Math.min(4096, to - i);
      for (let j = 0; j < count; j++)
        for (let c = 0; c < 4; c++) chunk.writeFloatLE(channels[c][i + j], j * 16 + c * 4);
      writeSync(fd, chunk, 0, count * 16);
    }
  } finally {
    closeSync(fd);
  }
}
