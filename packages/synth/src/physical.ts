const tau = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Fractional all-pass waveguide; the loop's phase includes its damping filter. */
export class PluckedString {
  buffer: Float32Array;
  pos = 0;
  low = 0;
  band = 0;
  previousInput = 0;
  previousOutput = 0;
  delay = 2;
  coefficient = 0;
  dampingCoefficient = 1;
  g = 0;
  k = 1;
  feedback = 0.99;
  frequency = -1;
  damping = -1;
  decay = -1;
  sr: number;
  constructor(sr: number) {
    this.sr = sr;
    this.buffer = new Float32Array(Math.ceil(sr / 20) + 4);
  }
  tune(frequency: number, damping: number, decay: number) {
    frequency = clamp(frequency, 20, this.sr / 8);
    if (frequency === this.frequency && damping === this.damping && decay === this.decay) return;
    this.frequency = frequency;
    this.damping = damping;
    this.decay = decay;
    const omega = (tau * frequency) / this.sr;
    this.dampingCoefficient = damping;
    this.g = Math.tan(omega / 2);
    this.k = 0.1 + 2.4 * (1 - damping);
    const period = this.sr / frequency;
    this.delay = Math.max(2, Math.floor(period));
    const phase = omega * (period - this.delay);
    const ratio = Math.tan(phase / 2) / Math.tan(omega / 2);
    this.coefficient = (1 - ratio) / (1 + ratio);
    // The damper has unity peak gain and zero phase at the fundamental.
    this.feedback = 10 ** (-3 / (frequency * Math.max(0.05, decay)));
  }
  trigger(
    frequency: number,
    damping: number,
    decay: number,
    brightness: number,
    pick: number,
    random: () => number,
  ) {
    this.tune(frequency, damping, decay);
    this.buffer.fill(0);
    this.pos = 0;
    this.low = this.band = this.previousInput = this.previousOutput = 0;
    const n = this.delay,
      pickDelay = Math.max(1, Math.round(n * clamp(pick, 0.02, 0.98)));
    const coef = 1 - Math.exp((-tau * (300 * 40 ** brightness)) / this.sr);
    let filtered = 0,
      mean = 0;
    for (let i = 0; i < n; i++) {
      filtered += coef * (random() * 2 - 1 - filtered);
      this.buffer[i] = filtered;
    }
    // Descend so the pick comb reads the original excitation, not modified samples.
    for (let i = n - 1; i >= 0; i--) {
      this.buffer[i] -= i >= pickDelay ? this.buffer[i - pickDelay] : 0;
      mean += this.buffer[i];
    }
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      this.buffer[i] -= mean;
      energy += this.buffer[i] ** 2;
    }
    const gain = 0.28 / Math.max(0.001, Math.sqrt(energy / n));
    for (let i = 0; i < n; i++) this.buffer[i] *= gain;
    this.buffer.copyWithin(this.buffer.length - n, 0, n);
    this.buffer.fill(0, 0, this.buffer.length - n);
  }
  next() {
    const at = (this.pos - this.delay + this.buffer.length) % this.buffer.length;
    const x = this.buffer[at];
    const fractional =
      this.coefficient * x + this.previousInput - this.coefficient * this.previousOutput;
    this.previousInput = x;
    this.previousOutput = fractional;
    const a = 1 / (1 + this.g * (this.g + this.k));
    const v1 = a * (this.band + this.g * (fractional - this.low)),
      v2 = this.low + this.g * v1;
    this.band = 2 * v1 - this.band;
    this.low = 2 * v2 - this.low;
    const damped =
      fractional * (1 - this.dampingCoefficient) + this.k * v1 * this.dampingCoefficient;
    this.buffer[this.pos] = damped * this.feedback;
    if (++this.pos === this.buffer.length) this.pos = 0;
    return fractional;
  }
}

// A, E, I, O, U. Third formant is quieter; interpolation is in log frequency.
const vowels = [
  [800, 1150, 2900],
  [400, 1700, 2600],
  [300, 2200, 3000],
  [450, 800, 2830],
  [325, 700, 2530],
];
export class VowelFilter {
  low = new Float64Array(3);
  band = new Float64Array(3);
  g = new Float64Array(3);
  k = new Float64Array(3);
  vowel = -1;
  shift = -99;
  resonance = -1;
  sr: number;
  constructor(sr: number) {
    this.sr = sr;
  }
  reset() {
    this.low.fill(0);
    this.band.fill(0);
  }
  tune(vowel: number, shift: number, resonance: number) {
    vowel = clamp(vowel, 0, 1);
    if (vowel === this.vowel && shift === this.shift && resonance === this.resonance) return;
    this.vowel = vowel;
    this.shift = shift;
    this.resonance = resonance;
    const position = vowel * 4,
      i = Math.min(3, Math.floor(position)),
      f = position - i;
    for (let j = 0; j < 3; j++) {
      const frequency = Math.min(
        this.sr * 0.4,
        vowels[i][j] * (vowels[i + 1][j] / vowels[i][j]) ** f * 2 ** (shift / 12),
      );
      const bandwidth = [100, 130, 180][j] * (1.4 - resonance);
      this.g[j] = Math.tan((Math.PI * frequency) / this.sr);
      this.k[j] = bandwidth / frequency;
    }
  }
  next(x: number) {
    let sum = 0;
    for (let j = 0; j < 3; j++) {
      const g = this.g[j],
        k = this.k[j],
        a = 1 / (1 + g * (g + k));
      const v1 = a * (this.band[j] + g * (x - this.low[j])),
        v2 = this.low[j] + g * v1;
      this.band[j] = 2 * v1 - this.band[j];
      this.low[j] = 2 * v2 - this.low[j];
      sum += k * v1 * [1, 0.7, 0.25][j];
    }
    return sum * 4;
  }
}
