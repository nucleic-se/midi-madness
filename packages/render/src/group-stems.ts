import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeWav } from './wav.ts';
import { levels } from './analysis.ts';
import type { Stereo } from '../../synth/src/buses.ts';

/** Share the final master correction between stems, preserving their exact sum. */
export function writeGroupStems(
  destination: string,
  mix: Stereo,
  groups: Map<string, Stereo>,
  sr: number,
  from: number,
  to: number,
) {
  const entries = [...groups];
  const energies = entries.map(([, audio]) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += audio.left[i] ** 2 + audio.right[i] ** 2;
    return sum;
  });
  const total = energies.reduce((a, b) => a + b, 0);
  for (let i = from; i < to; i++) {
    let left = 0,
      right = 0,
      magnitude = 0;
    for (const [, audio] of entries) {
      left += audio.left[i];
      right += audio.right[i];
      magnitude += Math.abs(audio.left[i]) + Math.abs(audio.right[i]);
    }
    const dl = mix.left[i] - left,
      dr = mix.right[i] - right;
    for (let g = 0; g < entries.length; g++) {
      const audio = entries[g][1];
      const weight =
        magnitude > 1e-12
          ? (Math.abs(audio.left[i]) + Math.abs(audio.right[i])) / magnitude
          : total
            ? energies[g] / total
            : 1 / entries.length;
      audio.left[i] += dl * weight;
      audio.right[i] += dr * weight;
    }
  }
  const directory = join(dirname(destination), 'stems');
  mkdirSync(directory, { recursive: true });
  return Object.fromEntries(
    entries.map(([name, audio]) => {
      const path = join(directory, `${encodeURIComponent(name)}.wav`);
      writeWav(path, audio.left, audio.right, sr, from, to, true);
      return [name, { file: path, ...levels(audio, [{ name, from, to }])[0] }];
    }),
  );
}
