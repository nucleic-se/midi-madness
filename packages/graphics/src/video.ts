import { adaptPerformance, type BackendPerformance } from './performance-adapter.js';

export interface PianoRollOptions {
  width?: number;
  height?: number;
  /** Visible media seconds. The playhead sits one quarter across the image. */
  windowSeconds?: number;
}

const palette = [
  [83, 218, 226],
  [181, 133, 255],
  [255, 180, 94],
  [124, 224, 145],
  [255, 119, 158],
  [124, 167, 255],
];
// Small embedded bitmap font keeps offline rendering independent of fonts and browsers.
const glyphs: Record<string, string> = Object.fromEntries(
  Object.entries({
    A: '010101111101101',
    B: '110101110101110',
    C: '011100100100011',
    D: '110101101101110',
    E: '111100110100111',
    F: '111100110100100',
    G: '011100101101011',
    H: '101101111101101',
    I: '111010010010111',
    J: '001001001101010',
    K: '101101110101101',
    L: '100100100100111',
    M: '101111111101101',
    N: '110101101101101',
    O: '010101101101010',
    P: '110101110100100',
    Q: '010101101111011',
    R: '110101110101101',
    S: '011100010001110',
    T: '111010010010010',
    U: '101101101101111',
    V: '101101101101010',
    W: '101101111111101',
    X: '101101010101101',
    Y: '101101010010010',
    Z: '111001010100111',
    0: '111101101101111',
    1: '010110010010111',
    2: '110001010100111',
    3: '110001010001110',
    4: '101101111001001',
    5: '111100110001110',
    6: '011100111101111',
    7: '111001010010010',
    8: '111101111101111',
    9: '111101111001110',
    '-': '000000111000000',
    _: '000000000000111',
    '.': '000000000000010',
    ':': '000010000010000',
    ' ': '000000000000000',
    '?': '110001010000010',
  }),
);

/** Browser-free RGB24 preset driven by the version-1 performance sidecar.
 * Notes show scheduled pitch/gate, hits use a 120ms marker; neither represents DSP level.
 * Every frame is a pure absolute-time evaluation, including backwards seeks.
 */
export function createPianoRoll(document: BackendPerformance, options: PianoRollOptions = {}) {
  const width = options.width ?? 1280;
  const height = options.height ?? 720;
  const windowSeconds = options.windowSeconds ?? 8;
  if (
    !Number.isInteger(width) ||
    width < 160 ||
    width > 3840 ||
    width % 2 ||
    !Number.isInteger(height) ||
    height < 120 ||
    height > 2160 ||
    height % 2
  )
    throw new RangeError(
      'Video dimensions must be even integers: width 160..3840, height 120..2160',
    );
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0 || windowSeconds > 120)
    throw new RangeError('Video window must be greater than 0 and at most 120 seconds');
  const performance = adaptPerformance(document);
  const lanes = document.tracks.map((track, index) => {
    const notes = performance.attacks
      .filter((a) => a.track === track.name)
      .map((a) => ({
        start: a.start,
        end: a.kind === 'hit' ? a.start + 0.12 : a.gateEnd,
        pitch: 'pitch' in a.source ? a.source.pitch : 60,
        velocity: 'velocity' in a.source ? a.source.velocity : 1,
      }));
    let low = 60,
      high = 60,
      longest = 0.12;
    for (const note of notes) {
      low = Math.min(low, note.pitch);
      high = Math.max(high, note.pitch);
      longest = Math.max(longest, note.end - note.start);
    }
    return {
      name: track.name,
      notes,
      low: low - 3,
      high: high + 3,
      longest,
      color: palette[index % palette.length],
    };
  });
  const margin = Math.min(120, Math.floor(width * 0.2));
  const plotWidth = width - margin - 12;
  const playhead = margin + plotWidth / 4;
  const top = 26,
    bottom = height - 18;
  const laneHeight = (bottom - top) / Math.max(1, lanes.length);
  const background = new Uint8Array(width * height * 3);
  for (let i = 0; i < background.length; i += 3) background.set([10, 14, 24], i);
  return {
    width,
    height,
    duration: performance.clock.duration,
    frame(time: number): Uint8Array {
      if (!Number.isFinite(time)) throw new RangeError('Frame time must be finite');
      const pixels = background.slice();
      function rect(x: number, y: number, w: number, h: number, color: readonly number[]) {
        const x0 = Math.max(0, Math.floor(x)),
          x1 = Math.min(width, Math.ceil(x + w));
        const y0 = Math.max(0, Math.floor(y)),
          y1 = Math.min(height, Math.ceil(y + h));
        if (x1 <= x0 || y1 <= y0) return;
        const row = new Uint8Array((x1 - x0) * 3);
        for (let i = 0; i < row.length; i += 3) row.set(color, i);
        for (let iy = y0; iy < y1; iy++) pixels.set(row, (iy * width + x0) * 3);
      }
      function text(value: string, x: number, y: number, color: readonly number[], scale = 1) {
        for (const letter of value.toUpperCase()) {
          const glyph = glyphs[letter] ?? glyphs['?'];
          for (let i = 0; i < 15; i++)
            if (glyph[i] === '1')
              rect(x + (i % 3) * scale, y + Math.floor(i / 3) * scale, scale, scale, color);
          x += 4 * scale;
        }
      }
      text('MIDI MADNESS', 12, 8, [190, 206, 230], 2);
      const leftTime = time - windowSeconds / 4;
      const xAt = (t: number) => margin + ((t - leftTime) / windowSeconds) * plotWidth;
      for (let second = Math.ceil(leftTime); second <= leftTime + windowSeconds; second++) {
        const x = xAt(second);
        rect(x, top, 1, bottom - top, [26, 34, 49]);
        text(String(second), x + 3, height - 12, [110, 130, 158]);
      }
      lanes.forEach((lane, index) => {
        const y = top + index * laneHeight;
        rect(margin, y + laneHeight - 1, plotWidth, 1, [39, 45, 64]);
        const size = Math.max(1, Math.min(2, Math.floor(laneHeight / 10)));
        text(
          lane.name.slice(0, Math.floor((margin - 16) / (4 * size))),
          8,
          y + Math.max(0, (laneHeight - size * 5) / 2),
          lane.color,
          size,
        );
        // Binary search excludes old attacks while retaining long held notes.
        let lo = 0,
          hi = lane.notes.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (lane.notes[mid].start < leftTime - lane.longest) lo = mid + 1;
          else hi = mid;
        }
        for (let i = lo; i < lane.notes.length; i++) {
          const note = lane.notes[i];
          if (note.start > leftTime + windowSeconds) break;
          if (note.end < leftTime) continue;
          const x0 = Math.max(margin, xAt(note.start));
          const x1 = Math.min(width - 12, xAt(note.end));
          const noteHeight = Math.max(1, Math.min(8, laneHeight / 6));
          const ny =
            y +
            2 +
            ((lane.high - note.pitch) / (lane.high - lane.low)) *
              Math.max(0, laneHeight - noteHeight - 4);
          const active = note.start <= time && time < note.end;
          const brightness = active ? 1 : 0.35 + 0.35 * Math.max(0, Math.min(1, note.velocity));
          rect(
            x0,
            ny,
            Math.max(2, x1 - x0),
            noteHeight,
            lane.color.map((c) => Math.round(c * brightness)),
          );
        }
      });
      rect(playhead, top, 2, bottom - top, [238, 244, 255]);
      rect(
        margin,
        height - 3,
        plotWidth * Math.max(0, Math.min(1, time / performance.clock.duration)),
        3,
        [83, 218, 226],
      );
      return pixels;
    },
  };
}
