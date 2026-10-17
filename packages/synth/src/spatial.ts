export type SpatialSettings = {
  output: 'stereo' | 'binaural' | 'ambisonic';
  distance: boolean;
  air: boolean;
  room?: string;
};
/** Farthest distance rendered for gain, air and propagation. Listener-relative scores are
 * limited to 100 m by their domain; world-space sources can be farther away. */
export const maxDistance = 250;
/** Analytic head model: ITD, head shadow and direction-dependent pinna coloration. */
export class SpatialVoice {
  private buffer: Float32Array;
  private cursor = 0;
  private airState = 0;
  private shadow = 0;
  pending = 0;
  left = 0;
  right = 0;
  mono = 0;
  direction = [1, 0, 0, 1]; // ACN/SN3D: W,Y,Z,X
  send = 0;
  constructor(privateRate: number) {
    this.sr = privateRate;
    this.buffer = new Float32Array(Math.ceil(privateRate * (maxDistance / 343 + 0.012)) + 64);
  }
  private sr: number;
  process(
    input: number,
    azimuth: number,
    elevation: number,
    distance: number,
    settings: SpatialSettings,
  ) {
    // Keep the voice alive until its propagation delay has emitted the last sound.
    if (Math.abs(input) > 1e-6)
      this.pending = Math.ceil(this.sr * Math.max(0.305, distance / 343 + 0.01));
    else this.pending = Math.max(0, this.pending - 1);
    const az = (azimuth * Math.PI) / 180,
      el = (elevation * Math.PI) / 180;
    const dist = Math.max(0.1, Math.min(maxDistance, distance));
    const side = Math.sin(az) * Math.cos(el),
      front = Math.cos(az) * Math.cos(el);
    const cutoff = settings.air ? Math.max(500, 18000 * Math.exp(-dist * 0.025)) : 20000;
    this.airState += (1 - Math.exp((-2 * Math.PI * cutoff) / this.sr)) * (input - this.airState);
    this.buffer[this.cursor] = settings.air ? this.airState : input;
    const tap = (delay: number) => {
      const at = (this.cursor - delay + this.buffer.length) % this.buffer.length;
      const j = Math.floor(at),
        f = at - j;
      return this.buffer[j] * (1 - f) + this.buffer[(j + 1) % this.buffer.length] * f;
    };
    // A moving propagation tap naturally produces Doppler, independently per voice.
    const propagation = settings.distance ? (dist / 343) * this.sr : 0;
    const gain = settings.distance ? 1 / Math.max(1, dist) : 1;
    this.mono = tap(propagation) * gain;
    this.direction = [1, -side, Math.sin(el), front];
    this.send = settings.distance ? (1 - Math.exp(-dist / 8)) * 0.35 : 0;
    if (settings.output === 'binaural') {
      const delay = Math.abs(side) * 0.00065 * this.sr;
      const near = this.mono;
      const far = tap(propagation + delay) * gain;
      this.shadow += (1 - Math.exp((-2 * Math.PI * 3000) / this.sr)) * (far - this.shadow);
      const shadowed = (far * 0.35 + this.shadow * 0.65) * (1 - 0.35 * Math.abs(side));
      const pinnaDelay = this.sr / Math.max(4000, 8000 + elevation * 30);
      const coloration =
        (tap(propagation + pinnaDelay) * gain - this.mono) * (0.12 + 0.25 * Math.max(0, -front));
      this.left = (side >= 0 ? shadowed : near) + coloration;
      this.right = (side >= 0 ? near : shadowed) + coloration;
    } else {
      const pan = side;
      this.left = this.mono * Math.cos(((pan + 1) * Math.PI) / 4);
      this.right = this.mono * Math.sin(((pan + 1) * Math.PI) / 4);
    }
    this.cursor = (this.cursor + 1) % this.buffer.length;
  }
}
