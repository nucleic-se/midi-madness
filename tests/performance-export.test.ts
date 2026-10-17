import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSong } from '../packages/render/src/render.ts';

test('audio renders save scheduled synth/drum controls and WAV sample coordinates even without reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-performance-'));
  try {
    const source = `mm 1
song "Shared performance"
  tempo 120
  humanize off
section A = rest(1 bar)
form = A
part keys
  plays notes | C4 . . . |
  pan = 0.3
part kick
  lane kick
  plays hits | x . . . |
part hat
  lane hat
  plays hits | . x . . |
  pan = -0.7
`;
    const result = renderSong(source, 'performance.mm', {
      out: join(dir, 'mix.wav'),
      tail: 0,
      noAnalysis: true,
    });
    const performance = JSON.parse(readFileSync(result.performancePath!, 'utf8'));
    const wav = readFileSync(result.destination);
    assert.equal(performance.format, 'midi-madness-performance');
    assert.equal(performance.version, 1);
    assert.equal(performance.audio.file, 'mix.wav');
    assert.equal(performance.audio.sampleRate, wav.readUInt32LE(24));
    assert.equal(performance.audio.frames, wav.readUInt32LE(40) / 6);
    assert.equal(performance.audio.originSample, 0);
    const keys = performance.tracks.find((t: any) => t.name === 'keys');
    assert.ok(keys.events.some((e: any) => e.type === 'on' && e.pitch === 60));
    assert.ok(keys.events.some((e: any) => e.type === 'off'));
    assert.ok(
      keys.events.some((e: any) => e.type === 'set' && e.name === 'pan' && e.value === 0.3),
    );
    const kick = performance.tracks.find((t: any) => t.name === 'kick');
    assert.equal(kick.lane, 'kick');
    assert.equal(kick.initialControls.pan, 0);
    assert.equal(kick.hits[0].sample, keys.events.find((e: any) => e.type === 'on').sample);
    const hat = performance.tracks.find((t: any) => t.name === 'hat');
    // Backend defaults remain separate from the scheduled override, for null resets.
    assert.equal(hat.initialControls.pan, 0.2);
    assert.ok(hat.controls.some((e: any) => e.name === 'pan' && e.value === -0.7));
    assert.ok(performance.score.parts[0].events.length > 0);
    // Replacement sidecars obey render selection instead of leaving full-mix tracks behind.
    renderSong(source, 'performance.mm', {
      out: result.destination,
      solo: 'keys',
      tail: 0,
      noAnalysis: true,
    });
    const solo = JSON.parse(readFileSync(result.performancePath!, 'utf8'));
    assert.deepEqual(
      solo.tracks.map((t: any) => t.name),
      ['keys'],
    );
    const excerpt = renderSong(source.replace('form = A', 'form = A A'), 'performance.mm', {
      out: join(dir, 'excerpt.wav'),
      from: '2',
      bars: '1',
      tail: 0,
      noAnalysis: true,
    });
    const cut = JSON.parse(readFileSync(excerpt.performancePath!, 'utf8'));
    assert.ok(cut.audio.originSample > 0);
    assert.ok(
      cut.tracks[0].events.some((e: any) => e.type === 'on' && e.sample === cut.audio.originSample),
    );
    assert.equal(cut.audio.frames, readFileSync(excerpt.destination).readUInt32LE(40) / 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
