import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderSong, type RenderOptions } from '../packages/render/src/render.ts';
import { mediaClock } from '@midi-madness/foundation/time';
import { performanceClock } from '../packages/graphics/src/performance.ts';

const source = `mm 1
song "Preview controls"
  tempo 240
  humanize off
  dynamics flat
section A = rest(8 bars)
section B = rest(8 bars)
form = A B
listener
  x = per song 1 bar smooth: 0, 1, 2, 3
fx
  bus repeat = delay time 1/4, feedback 0.4
bus repeat
  return = 0.3
part lead
  sound init
  cutoff = per song 1/2 smooth: 0.2, 0.8
  space.x = per song 1 bar smooth: 0, 1, 2, 3
  space.z = -3
  send.repeat = 0.2
  when in B:
    level = 0.4
  plays notes | C4 E4 . . |
part kick
  lane kick
  plays hits | x . x . |
`;

function fixture(
  run: (
    render: (
      name: string,
      options?: RenderOptions,
      text?: string,
    ) => {
      result: ReturnType<typeof renderSong>;
      data: any;
      wav: Buffer;
      frames: number;
    },
    dir: string,
  ) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-preview-'));
  try {
    run((name, options = {}, text = source) => {
      let frames = 0;
      const result = renderSong(text, join(dir, 'song.mm'), {
        out: join(dir, name, 'mix.wav'),
        tail: 0,
        noAnalysis: true,
        ...options,
        captureAudio: (audio) => {
          frames = audio.left.length;
        },
      });
      return {
        result,
        data: JSON.parse(readFileSync(result.performancePath!, 'utf8')),
        wav: readFileSync(result.destination),
        frames,
      };
    }, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('preview processes only warm-up plus excerpt and retains score, bus and world timing', () =>
  fixture((render) => {
    const { result, data, frames } = render('preview', { from: '13', bars: '2', preview: true });
    assert.equal(frames, 4 * 48000);
    assert.equal(data.audio.originSample, 2 * 48000);
    assert.equal(data.audio.scoreOffsetSample, -10 * 48000);
    assert.equal(data.audio.frames, 2 * 48000);
    assert.equal(data.preview.skippedSamples, 10 * 48000);
    assert.equal(data.preview.processingFrom, '10/1');
    assert.equal(data.preview.actualWarmupSeconds, 2);
    assert.equal(mediaClock(data.audio, 240).scoreBeatsAtSeconds(0), 48);
    assert.equal(result.report.fullRender, false);
    assert.deepEqual(result.report.preview, data.preview);
    assert.match(result.text, /Approximate preview/);
    assert.ok(data.preview.limitations.some((s: string) => /throughout/.test(s)));
    for (const track of data.tracks) {
      for (const event of [
        ...(track.events ?? []),
        ...(track.hits ?? []),
        ...(track.controls ?? []),
      ])
        assert.ok(event.sample >= 0);
      for (const record of track.envelopes) assert.ok(record.on >= 0);
    }
    const lead = data.tracks.find((p: any) => p.name === 'lead');
    assert.deepEqual(lead.space.position.x[0], { sample: 0, value: 2, curve: 'linear' });
    assert.equal(data.world.listener.x[0].value, 2);
    assert.equal(lead.events.find((e: any) => e.type === 'set' && e.name === 'level').value, 0.4);
    assert.equal(data.busControls.repeat[0].sample, 0);
    assert.equal(data.busControls.repeat[0].value, 0.3);
    assert.equal(performanceClock(data.audio).seconds(0), -2);
  }));

test('a preview whose warm-up reaches the song start has identical audio to the exact excerpt', () =>
  fixture((render) => {
    const exact = render('exact', { from: '2', bars: '2' });
    const preview = render('preview', { from: '2', bars: '2', preview: true, warmupBars: 5 });
    assert.deepEqual(preview.wav, exact.wav);
    assert.deepEqual(preview.data.tracks, exact.data.tracks);
    assert.equal(exact.data.preview, undefined);
    assert.equal(preview.data.preview.skippedSamples, 0);
    assert.equal(preview.data.preview.actualWarmupSeconds, 1);
  }));

test('held notes before warm-up are intentionally absent and preview DSP randomness is repeatable', () =>
  fixture((render) => {
    const held = `mm 1\nsong "Held"\n  tempo 240\n  humanize off\nsection A = rest(4 bars)\nform = A\npart lead\n  sound init\n  sustain = 1\n  plays notes | C4{length 4/1} . . . | . . . . | . . . . | . . . . |\n`;
    const exact = render('held-exact', { from: '4', bars: '1' }, held);
    const preview = render(
      'held-preview',
      { from: '4', bars: '1', preview: true, warmupBars: 1 },
      held,
    );
    assert.ok(exact.result.report.peak > 0.001);
    assert.equal(preview.result.report.peak, 0);
    assert.equal(preview.data.tracks[0].events.filter((e: any) => e.type === 'on').length, 0);
    assert.match(preview.data.preview.limitations[0], /held notes/);
    const options = { from: '13', bars: '1', preview: true, warmupBars: 1 };
    const a = render('random-a', options),
      b = render('random-b', options);
    assert.deepEqual(a.wav, b.wav);
  }));

test('preview part stems, envelopes and reduced event exports share the local backend clock', () =>
  fixture((render) => {
    const { result, data } = render('stems', {
      from: '13',
      bars: '1',
      preview: true,
      warmupBars: 0,
      stemsBy: 'part',
      eventEnvelopes: 'none',
      eventParts: ['kick'],
    });
    assert.equal(data.audio.originSample, 0);
    assert.equal(data.audio.frames, 48000);
    assert.deepEqual(
      data.tracks.map((p: any) => p.name),
      ['kick'],
    );
    assert.equal(data.tracks[0].envelopes, undefined);
    for (const stem of [...result.report.partStems!.members, ...result.report.busStems!.members]) {
      const bytes = readFileSync(stem.file);
      assert.equal(bytes.readUInt32LE(40) / bytes.readUInt16LE(32), data.audio.frames);
    }
  }));

test('preview supports binaural and ambisonic output without changing score coordinates', () =>
  fixture((render) => {
    for (const mode of ['binaural', 'ambisonic 1']) {
      const { data, wav } = render(
        mode,
        { from: '13', bars: '1', preview: true, warmupBars: 0 },
        source.replace('  humanize off', `  humanize off\n  space ${mode}`),
      );
      assert.equal(wav.readUInt16LE(22), mode === 'binaural' ? 2 : 4);
      assert.equal(mediaClock(data.audio, 240).scoreBeatsAtSeconds(0), 48);
    }
  }));

test('preview shifts effect cuts and grouped stems consistently at fractional sample tempos', () =>
  fixture((render) => {
    const text = source
      .replace('tempo 240', 'tempo 129.92936\n  meter 6/8')
      .replace('form = A B', 'form = A B\nsilence before B for 1 beat and cut fx');
    const { result, data } = render(
      'fractional',
      { from: '10', bars: '1', preview: true, warmupBars: 2, stemsBy: 'group' },
      text,
    );
    const sr = data.audio.sampleRate,
      secondsPerWhole = 240 / 129.92936;
    const cut =
      Math.round(8 * 0.75 * secondsPerWhole * sr) - Math.round(0.25 * secondsPerWhole * sr);
    assert.deepEqual(result.report.fxCuts, [(cut - data.preview.skippedSamples) / sr]);
    assert.ok(Math.abs(mediaClock(data.audio, 129.92936).scoreBeatsAtSeconds(0) - 27) < 0.0001);
    for (const stem of Object.values(result.report.groupStems!)) {
      const bytes = readFileSync(stem.file);
      assert.equal(bytes.readUInt32LE(40) / bytes.readUInt16LE(32), data.audio.frames);
    }
  }));

test('invalid preview settings fail before replacing output', () =>
  fixture((render, dir) => {
    const original = render('existing');
    for (const options of [
      { preview: true },
      { preview: true, from: '3' },
      { warmupBars: 1 },
      { preview: true, from: '3', bars: '1', warmupBars: -1 },
      { preview: true, from: '3', bars: '1', warmupBars: 0.5 },
    ]) {
      assert.throws(
        () =>
          renderSong(source, join(dir, 'song.mm'), {
            out: original.result.destination,
            ...options,
          }),
        /preview|Preview|warmup/,
      );
      assert.deepEqual(readFileSync(original.result.destination), original.wav);
    }
  }));

test('CLI labels previews, defaults to a separate directory and validates warm-up flags', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-preview-cli-'));
  try {
    const file = join(dir, 'song.mm'),
      cli = resolve('packages/cli/src/main.ts');
    writeFileSync(file, source);
    const invoke = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ['--experimental-strip-types', cli, 'render', file, ...args, '--json'],
        { cwd: dir, encoding: 'utf8' },
      );
    const success = invoke(
      '--preview',
      '--from',
      '13',
      '--bars',
      '1',
      '--warmup-bars',
      '0',
      '--tail',
      '0',
      '--no-analysis',
    );
    assert.equal(success.status, 0, success.stderr + success.stdout);
    const data = JSON.parse(success.stdout);
    assert.equal(data.result.report.preview.approximate, true);
    assert.equal(existsSync(join(dir, 'renders/song/preview/mix.wav')), true);
    assert.equal(existsSync(join(dir, 'renders/song/mix.wav')), false);
    for (const args of [
      ['--preview'],
      ['--warmup-bars', '2'],
      ['--preview', '--from', '13', '--bars', '1', '--warmup-bars', '0.5'],
    ]) {
      const failed = invoke(...args);
      assert.equal(failed.status, 2, failed.stderr + failed.stdout);
      assert.equal(JSON.parse(failed.stdout).result.failure, 'usage');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
