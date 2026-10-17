import type { AudioBuses } from './engine.ts';
export type EchoSettings = { time?: number; width?: number; feedback?: number };
/** Small draft room and dotted-eighth echo; no mastering or normalization. */
export function effects(out: AudioBuses, sr: number, bpm: number, config: EchoSettings = {}) {
  const times = [0.0297, 0.0371, 0.0411, 0.0437, 0.0531, 0.0617, 0.0713, 0.0797];
  const delays = times.map((t) => new Float32Array(Math.round(t * sr)));
  const positions = new Int32Array(8),
    damped = new Float64Array(8);
  const feedback = times.map((t) => 10 ** ((-3 * t) / 2.2));
  const echo = new Float32Array(Math.max(1, Math.round(sr * (config.time ?? (60 / bpm) * 0.75))));
  const echoR = new Float32Array(echo.length);
  const width = config.width ?? 0.6,
    echoFeedback = config.feedback ?? 0.35;
  const predelay = new Float32Array(Math.round(sr * 0.025));
  let echoPos = 0,
    prePos = 0,
    echoLP = 0,
    echoLPR = 0,
    peak = 0,
    beforePeak = 0;
  let lastAudible = 0;
  for (let i = 0; i < out.left.length; i++) {
    const input = predelay[prePos];
    predelay[prePos] = out.room[i];
    prePos = (prePos + 1) % predelay.length;
    let l = 0,
      r = 0,
      sum = 0;
    for (let j = 0; j < 8; j++) {
      const y = delays[j][positions[j]];
      damped[j] += 0.35 * (y - damped[j]);
      sum += damped[j];
      if (j & 1) r += y;
      else l += y;
    }
    // Householder feedback matrix preserves energy before damping/decay.
    for (let j = 0; j < 8; j++) {
      delays[j][positions[j]] = input * 0.3 + feedback[j] * (damped[j] - sum * 0.25);
      positions[j] = (positions[j] + 1) % delays[j].length;
    }
    echoLP += 0.4 * (echo[echoPos] - echoLP);
    echoLPR += 0.4 * (echoR[echoPos] - echoLPR);
    const delayed = echoLP,
      delayedR = echoLPR;
    echo[echoPos] =
      out.echo[i] * (0.5 + 0.5 * width) + echoFeedback * (delayed * (1 - width) + delayedR * width);
    echoR[echoPos] =
      out.echo[i] * (0.5 - 0.5 * width) + echoFeedback * (delayedR * (1 - width) + delayed * width);
    echoPos = (echoPos + 1) % echo.length;
    let left = out.left[i] + l * 0.25 + delayed;
    let right = out.right[i] + r * 0.25 + delayedR;
    beforePeak = Math.max(beforePeak, Math.abs(left), Math.abs(right));
    // Stereo-linked instantaneous safety ceiling. Intentionally a draft safeguard.
    const gain = Math.min(1, 0.95 / Math.max(0.000001, Math.abs(left), Math.abs(right)));
    left *= gain;
    right *= gain;
    out.left[i] = left;
    out.right[i] = right;
    const p = Math.max(Math.abs(left), Math.abs(right));
    peak = Math.max(peak, p);
    if (p > 0.0000316228) lastAudible = i;
  }
  return { peak, beforePeak, lastAudible };
}
