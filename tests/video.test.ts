import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { loadScore } from '../packages/core/src/include.ts';
import { renderVideo } from '../packages/cli/src/commands/video.ts';

const available = ['ffmpeg', 'ffprobe'].every((tool) => spawnSync(tool, ['-version']).status === 0);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mm-video-'));
  const score = join(directory, 'song.mm');
  writeFileSync(
    score,
    'mm 1\nsong "Movie"\n  tempo 240\n  humanize off\nsection A = rest(2 bars)\nform = A\npart lead\n  include "lead.mmi"\npart kick\n  lane kick\n  plays hits | x . x . |\n',
  );
  writeFileSync(join(directory, 'lead.mmi'), 'sound warm-lead\nplays notes | C4 D4 E4 G4 |\n');
  return { directory, score };
}

test(
  'score CLI exports a moving H.264 movie with aligned audible AAC and matching sidecar',
  { skip: !available },
  () => {
    const { directory, score } = fixture();
    try {
      const movie = join(directory, 'clip.mp4');
      const run = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          'packages/cli/src/main.ts',
          'video',
          score,
          '--out',
          movie,
          '--from',
          'bar 2',
          '--bars',
          '1',
          '--tail',
          '0.1',
          '--width',
          '320',
          '--height',
          '180',
          '--fps',
          '12',
          '--json',
        ],
        { encoding: 'utf8' },
      );
      assert.equal(run.status, 0, run.stdout + run.stderr);
      const result = JSON.parse(run.stdout).result;
      const events = JSON.parse(readFileSync(result.performancePath, 'utf8'));
      assert.ok(events.audio.originSample > events.audio.scoreOffsetSample);
      assert.deepEqual(events.capture, { envelopes: 'none', parts: ['lead', 'kick'] });
      assert.ok(existsSync(result.audio));
      assert.equal(events.audio.frames / events.audio.sampleRate, result.duration);
      const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', movie], {
        encoding: 'utf8',
      });
      assert.equal(probe.status, 0, probe.stderr);
      const streams = JSON.parse(probe.stdout).streams;
      const video = streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
      const audio = streams.find((stream: { codec_type: string }) => stream.codec_type === 'audio');
      assert.equal(video.codec_name, 'h264');
      assert.equal(video.width, 320);
      assert.equal(video.height, 180);
      assert.equal(Number(video.nb_frames), Math.ceil(result.duration * 12));
      assert.equal(audio.codec_name, 'aac');
      assert.equal(audio.channels, 2);
      assert.ok(Math.abs(Number(audio.duration) - result.duration) < 0.005);
      assert.ok(Math.abs(Number(video.duration) - result.duration) <= 1 / 12 + 0.001);
      const decoded = spawnSync('ffmpeg', [
        '-v',
        'error',
        '-i',
        movie,
        '-map',
        '0:a:0',
        '-f',
        'f32le',
        '-ac',
        '1',
        'pipe:1',
      ]);
      assert.equal(decoded.status, 0, decoded.stderr.toString());
      let energy = 0;
      for (let i = 0; i < decoded.stdout.length; i += 4)
        energy += decoded.stdout.readFloatLE(i) ** 2;
      assert.ok(energy / (decoded.stdout.length / 4) > 1e-6, 'Movie audio must be audible');
      const hashes = spawnSync(
        'ffmpeg',
        ['-v', 'error', '-i', movie, '-map', '0:v:0', '-f', 'framemd5', 'pipe:1'],
        { encoding: 'utf8' },
      );
      assert.equal(hashes.status, 0, hashes.stderr);
      const frames = hashes.stdout
        .split('\n')
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => line.split(',').at(-1));
      assert.ok(new Set(frames).size > 1, 'Movie must contain animated frames');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('video validates settings and missing FFmpeg before writing audio', async () => {
  const { directory, score } = fixture();
  const path = process.env.PATH;
  try {
    const loaded = loadScore(score),
      out = join(directory, 'out.mp4');
    await assert.rejects(renderVideo(loaded, score, { out, width: 321 }), /dimensions/);
    await assert.rejects(renderVideo(loaded, score, { out, fps: 0 }), /fps/);
    await assert.rejects(renderVideo(loaded, score, { out: score }), /mp4/);
    process.env.PATH = directory;
    await assert.rejects(renderVideo(loaded, score, { out }), /requires FFmpeg/);
    assert.equal(existsSync(join(directory, 'out.assets')), false);
  } finally {
    process.env.PATH = path;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed encoding preserves an existing movie and removes incomplete output', async () => {
  const { directory, score } = fixture();
  const path = process.env.PATH;
  try {
    const fake = join(directory, 'ffmpeg');
    writeFileSync(
      fake,
      `#!${process.execPath}\nif (process.argv.includes('-version')) process.exit(0);\nprocess.stderr.write('test encoder failure');process.exit(17);\n`,
      { mode: 0o755 },
    );
    process.env.PATH = directory + delimiter + path;
    const out = join(directory, 'saved.mp4');
    writeFileSync(out, 'existing movie');
    await assert.rejects(
      renderVideo(loadScore(score), score, { out, tail: 0, width: 160, height: 120, fps: 1 }),
      /test encoder failure/,
    );
    assert.equal(readFileSync(out, 'utf8'), 'existing movie');
    assert.equal(
      readdirSync(directory).some((name) => name.startsWith('.video-')),
      false,
    );
    assert.ok(existsSync(join(directory, 'saved.assets', 'mix.wav')));
  } finally {
    process.env.PATH = path;
    rmSync(directory, { recursive: true, force: true });
  }
});
