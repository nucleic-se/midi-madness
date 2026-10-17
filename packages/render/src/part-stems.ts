import { mkdirSync, openSync, closeSync, readSync, writeSync, ftruncateSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeWav } from './wav.ts';
import type { Stereo } from '../../synth/src/buses.ts';

/** Half-overlapping sine-windowed 2048-point spectra, averaged across both channels. */
export const bandEdgesHz = [0, 80, 250, 1000, 4000, 12000, 24000] as const;
const size = 2048;
function powers(input: Float64Array) {
  const re = input.slice(),
    im = new Float64Array(size);
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let length = 2; length <= size; length *= 2) {
    const angle = (-2 * Math.PI) / length;
    for (let start = 0; start < size; start += length) {
      for (let j = 0; j < length / 2; j++) {
        const a = start + j,
          b = a + length / 2;
        const c = Math.cos(angle * j),
          s = Math.sin(angle * j);
        const r = re[b] * c - im[b] * s,
          v = re[b] * s + im[b] * c;
        re[b] = re[a] - r;
        im[b] = im[a] - v;
        re[a] += r;
        im[a] += v;
      }
    }
  }
  return re.map((r, i) => r * r + im[i] * im[i]);
}

/** Measure the exact cropped float stem, bounded to one FFT block in memory. */
export function measurePartStem(file: string, frames: number, sampleRate: number) {
  const fd = openSync(file, 'r');
  const data = Buffer.alloc(size * 8),
    sums = new Float64Array(6);
  let energy = 0,
    peak = 0,
    windowEnergy = 0;
  try {
    for (let offset = -size / 2; offset < frames; offset += size / 2) {
      const start = Math.max(0, offset);
      const count = Math.min(offset + size, frames) - start;
      const bytes = readSync(fd, data, 0, count * 8, 44 + start * 8);
      if (bytes !== count * 8) throw new Error(`Incomplete part stem: ${file}`);
      const channels = [new Float64Array(size), new Float64Array(size)];
      for (let j = 0; j < count; j++) {
        const i = start + j - offset;
        // Adjacent half-overlapping windows have squared weights summing to one.
        // Padding both ends keeps even boundary impulses fully represented.
        const w = Math.sin((Math.PI * (i + 0.5)) / size);
        windowEnergy += w * w;
        for (let ch = 0; ch < 2; ch++) {
          const value = data.readFloatLE(j * 8 + ch * 4);
          if (i < size / 2) {
            energy += value * value;
            peak = Math.max(peak, Math.abs(value));
          }
          channels[ch][i] = value * w;
        }
      }
      for (const channel of channels) {
        const bins = powers(channel);
        for (let k = 0; k <= size / 2; k++) {
          const hz = (k * sampleRate) / size;
          const band = bandEdgesHz.findIndex((edge, i) => i > 0 && (hz < edge || i === 6)) - 1;
          sums[band] += bins[k] * (k === 0 || k === size / 2 ? 1 : 2);
        }
      }
    }
  } finally {
    closeSync(fd);
  }
  const bandEnergy = [...sums].map((v) => (windowEnergy ? v / (2 * size * windowEnergy) : 0));
  const total = bandEnergy.reduce((a, b) => a + b, 0);
  return {
    frames,
    rmsDb: 10 * Math.log10(Math.max(1e-20, energy / Math.max(1, frames * 2))),
    peakDb: 20 * Math.log10(Math.max(1e-10, peak)),
    bands: bandEnergy.map((meanSquare, i) => ({
      fromHz: bandEdgesHz[i],
      toHz: bandEdgesHz[i + 1],
      meanSquare,
      fraction: total ? meanSquare / total : 0,
    })),
  };
}

export function createPartStems(
  destination: string,
  sampleRate: number,
  from: number,
  kind: 'part' | 'bus' = 'part',
  prefix = '',
) {
  const directory = join(dirname(destination), kind === 'part' ? 'parts' : 'bus-returns');
  mkdirSync(directory, { recursive: true });
  const files: { name: string; file: string }[] = [];
  return {
    member(name: string, audio: Stereo) {
      const file = join(directory, `${prefix}${encodeURIComponent(name)}.wav`);
      writeWav(file, audio.left, audio.right, sampleRate, from, audio.left.length, true);
      files.push({ name, file });
    },
    finish(to: number) {
      const frames = to - from;
      const members = files.map(({ name, file }) => {
        // The final mix determines tail length; trim without retaining all part buffers.
        const fd = openSync(file, 'r+');
        try {
          const header = Buffer.alloc(4);
          header.writeUInt32LE(frames * 8 + 36);
          writeSync(fd, header, 0, 4, 4);
          header.writeUInt32LE(frames * 8);
          writeSync(fd, header, 0, 4, 40);
          ftruncateSync(fd, 44 + frames * 8);
        } finally {
          closeSync(fd);
        }
        return { name, file, ...measurePartStem(file, frames, sampleRate) };
      });
      const overlaps = bandEdgesHz
        .slice(0, -1)
        .map((fromHz, i) => ({
          fromHz,
          toHz: bandEdgesHz[i + 1],
          parts: members
            .filter((m) => m.rmsDb > -80 && m.bands[i].fraction >= 0.15)
            .map((m) => m.name),
        }))
        .filter((b) => b.parts.length > 1);
      return {
        version: 1,
        tap:
          kind === 'part'
            ? 'post-part-inserts-and-gain, pre-shared-returns-and-master'
            : 'complete-bus-return-after-effects-gain-and-ducking, pre-master',
        measurement:
          'Unweighted stereo RMS/peak dBFS (silence floor -200); not LUFS. Six-band mean square uses 50%-overlapping sine-windowed 2048-point FFTs; band boundaries have finite frequency resolution.',
        overlapMeaning:
          'At least 15% of each listed part spectrum lies in this band and its overall RMS exceeds -80 dBFS. Whole-excerpt spectral overlap does not imply simultaneous masking or a mix defect.',
        sampleRate,
        frames,
        members,
        overlaps,
      };
    },
  };
}
