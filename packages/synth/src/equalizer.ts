/** RBJ bell/shelf biquads: https://www.w3.org/TR/audio-eq-cookbook/ */
export function createEqualizer(sr: number) {
  const state = new Float64Array(8);
  let previousFrequency = NaN,
    previousGain = NaN,
    previousType = NaN,
    previousQ = NaN,
    previousSlope = NaN,
    coefficients = [1, 0, 0, 0, 0];
  return {
    left: 0,
    right: 0,
    reset() {
      state.fill(0);
    },
    process(
      left: number,
      right: number,
      frequency: number,
      gainDb: number,
      type: number,
      q: number,
      slope: number,
    ) {
      // Expressions can have domain warnings; keep the recursive filter stable
      // even when an automated value exceeds its declared interval.
      frequency = Math.max(20, Math.min(sr * 0.45, frequency));
      gainDb = Math.max(-24, Math.min(24, gainDb));
      q = Math.max(0.1, Math.min(18, q));
      slope = Math.max(0.1, Math.min(1, slope));
      type = Math.max(0, Math.min(2, Math.round(type)));
      if (
        frequency !== previousFrequency ||
        gainDb !== previousGain ||
        type !== previousType ||
        q !== previousQ ||
        slope !== previousSlope
      ) {
        previousFrequency = frequency;
        previousGain = gainDb;
        previousType = type;
        previousQ = q;
        previousSlope = slope;
        const w = (2 * Math.PI * Math.min(frequency, sr * 0.45)) / sr;
        const c = Math.cos(w),
          a = 10 ** (gainDb / 40);
        const alpha =
          (Math.sin(w) / 2) * (type === 0 ? 1 / q : Math.sqrt((a + 1 / a) * (1 / slope - 1) + 2));
        const beta = 2 * Math.sqrt(a) * alpha;
        let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
        if (type === 0) {
          b0 = 1 + alpha * a;
          b1 = -2 * c;
          b2 = 1 - alpha * a;
          a0 = 1 + alpha / a;
          a1 = -2 * c;
          a2 = 1 - alpha / a;
        } else if (type === 1) {
          b0 = a * (a + 1 - (a - 1) * c + beta);
          b1 = 2 * a * (a - 1 - (a + 1) * c);
          b2 = a * (a + 1 - (a - 1) * c - beta);
          a0 = a + 1 + (a - 1) * c + beta;
          a1 = -2 * (a - 1 + (a + 1) * c);
          a2 = a + 1 + (a - 1) * c - beta;
        } else {
          b0 = a * (a + 1 + (a - 1) * c + beta);
          b1 = -2 * a * (a - 1 + (a + 1) * c);
          b2 = a * (a + 1 + (a - 1) * c - beta);
          a0 = a + 1 - (a - 1) * c + beta;
          a1 = 2 * (a - 1 - (a + 1) * c);
          a2 = a + 1 - (a - 1) * c - beta;
        }
        coefficients = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
      }
      const [b0, b1, b2, a1, a2] = coefficients;
      const channel = (x: number, offset: number) => {
        const y =
          b0 * x +
          b1 * state[offset] +
          b2 * state[offset + 1] -
          a1 * state[offset + 2] -
          a2 * state[offset + 3];
        state[offset + 1] = state[offset];
        state[offset] = x;
        state[offset + 3] = state[offset + 2];
        state[offset + 2] = y;
        // Preserve exact unity while still tracking state for subsequent automation.
        return gainDb === 0 ? x : y;
      };
      this.left = channel(left, 0);
      this.right = channel(right, 4);
    },
  };
}
