import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSong } from '../packages/render/src/render.ts';
function energy(wav: Buffer, start: number, end: number) {
  let l = 0,
    r = 0;
  for (let i = Math.floor(start * 48000); i < Math.floor(end * 48000); i++) {
    const offset = 44 + i * 6;
    if (offset + 6 > wav.length) break;
    l += (wav.readIntLE(offset, 3) / 8388607) ** 2;
    r += (wav.readIntLE(offset + 3, 3) / 8388607) ** 2;
  }
  return { l, r, balance: (r - l) / (r + l), power: l + r };
}
test('spatial data automation keeps signed azimuth degrees and distances above one metre', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mm-spatial-data-'));
  try {
    const file = join(directory, 'song.mm');
    writeFileSync(
      join(directory, 'lanes.json'),
      JSON.stringify({ az: [-70, 70], distance: [2, 4] }),
    );
    const source =
      'mm 1\nsong "Spatial data bounds"\n  tempo 240\n  humanize off\n  dynamics flat\n  space stereo\n  space distance inverse, air off\nsection A = rest(2 bars)\nform = A\npart lead\n  sound init\n  range C3..C6\n  osc1.wave = 0\n  attack = 0\n  sustain = 1\n  release = 0\n  reverb = 0\n  delay = 0\n  space.az = data "lanes.json" key az per 1 bar smooth\n  space.dist = data "lanes.json" key distance per 1 bar smooth\n  plays notes (across 2 bars: C4)\n';
    writeFileSync(file, source);
    const output = join(directory, 'mix.wav');
    renderSong(source, file, { out: output, tail: 0, noAnalysis: true });
    const wav = readFileSync(output),
      left = energy(wav, 0.08, 0.2),
      right = energy(wav, 1.08, 1.2);
    assert.ok(left.balance < -0.7, `left position collapsed: ${left.balance}`);
    assert.ok(right.balance > 0.7, `right position collapsed: ${right.balance}`);
    assert.ok(
      right.power / left.power < 0.5,
      `distance 2..4m was clamped: ${right.power / left.power}`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
