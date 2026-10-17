import { Rational as R } from '../../core/src/index.ts';

export const previewLimitations = [
  'Notes and drum hits starting before the warm-up boundary are omitted, including held notes and release tails.',
  'Voices, effects and DSP random/modulation history start fresh at the warm-up boundary. Feedback, spatial delays, phase, noise and voice allocation may differ throughout the excerpt; the score seed does not guarantee identical audio.',
  'The whole score is still compiled and generated before windowed audio processing. Complex scores can retain substantial setup and event-export costs.',
];

export type PreviewInfo = {
  approximate: true;
  requestedWarmupBars: number;
  actualWarmupSeconds: number;
  processingFrom: string;
  /** Add this to local backend samples to obtain the exact-mode backend coordinate. */
  skippedSamples: number;
  limitations: string[];
};

/** Only opt-in previews move the DSP origin. Exact renders retain their existing clock. */
export function previewWindow(
  from: R,
  meter: readonly [number, number],
  warmupBars: number,
  originalOffset: number,
  position: (time: R) => number,
  sampleRate: number,
): PreviewInfo {
  const candidate = from.sub(new R(...meter).mul(new R(warmupBars)));
  const start = candidate.numerator > 0n ? candidate : new R(0);
  const skippedSamples = start.numerator > 0n ? originalOffset + position(start) : 0;
  return {
    approximate: true,
    requestedWarmupBars: warmupBars,
    actualWarmupSeconds: (originalOffset + position(from) - skippedSamples) / sampleRate,
    processingFrom: start.toString(),
    skippedSamples,
    limitations: [...previewLimitations],
  };
}
