import type { Stereo } from './buses.ts';

export function createLevelMeter() {
  let energy = 0,
    peak = 0,
    frames = 0;
  return {
    observe(left: number, right: number) {
      energy += left * left + right * right;
      peak = Math.max(peak, Math.abs(left), Math.abs(right));
      frames++;
    },
    report() {
      return {
        frames,
        meanSquare: energy / Math.max(1, 2 * frames),
        rmsDb: 10 * Math.log10(Math.max(1e-20, energy / Math.max(1, 2 * frames))),
        peakDb: 20 * Math.log10(Math.max(1e-10, peak)),
      };
    },
  };
}
export function measureStereo(audio: Stereo, from = 0, to = audio.left.length) {
  const meter = createLevelMeter();
  for (let i = Math.max(0, from); i < Math.min(to, audio.left.length); i++)
    meter.observe(audio.left[i], audio.right[i]);
  return meter.report();
}
export function stageGain(
  id: string,
  type: string,
  input: ReturnType<typeof measureStereo>,
  output: ReturnType<typeof measureStereo>,
) {
  return {
    id,
    type,
    input,
    output,
    gainDb:
      input.meanSquare > 0 && output.meanSquare > 0
        ? 10 * Math.log10(output.meanSquare / input.meanSquare)
        : null,
  };
}
export type StageGain = ReturnType<typeof stageGain>;
