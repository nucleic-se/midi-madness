import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { LoadedScore } from '../../../core/src/include.ts';
import { renderSong, type RenderOptions } from '../../../render/src/render.ts';
import type { BackendPerformance } from '@midi-madness/graphics/performance-adapter.js';
import { createPianoRoll, type PianoRollOptions } from '@midi-madness/graphics/video.js';

export interface VideoOptions extends PianoRollOptions {
  out?: string;
  fps?: number;
  setup?: string;
  from?: string;
  bars?: string;
  tail?: number;
  progress?: (message: string) => void;
}

export function videoSettings(options: VideoOptions) {
  const width = options.width ?? 1280,
    height = options.height ?? 720;
  const fps = options.fps ?? 30;
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
  if (!Number.isInteger(fps) || fps < 1 || fps > 60)
    throw new RangeError('--fps must be an integer 1..60');
  if (options.out && extname(options.out).toLowerCase() !== '.mp4')
    throw new RangeError('Video --out must end in .mp4');
  return { width, height, fps };
}

/** Render a loaded disk score once, then encode absolute-time RGB frames with its matching WAV. */
export async function renderVideo(
  score: LoadedScore,
  filename: string,
  options: VideoOptions = {},
) {
  const { width, height, fps } = videoSettings(options);
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ffmpeg.error || ffmpeg.status !== 0)
    throw new Error(
      'Video export requires FFmpeg on PATH with libx264 and AAC support. Install FFmpeg and retry.',
    );
  const stem = basename(filename, extname(filename));
  const destination = resolve(options.out ?? join('renders', stem, 'video.mp4'));
  const assets = join(
    dirname(destination),
    basename(destination, extname(destination)) + '.assets',
  );
  const audioOptions: RenderOptions = {
    score,
    setup: options.setup,
    from: options.from,
    bars: options.bars,
    tail: options.tail,
    out: join(assets, 'mix.wav'),
    // The piano roll needs scheduled gates/hits, not densely sampled DSP envelopes.
    eventEnvelopes: 'none',
    progress: options.progress,
  };
  const rendered = renderSong(score.source, filename, audioOptions);
  if (!rendered.performancePath)
    throw new Error('Audio renderer did not supply performance events');
  const performance: BackendPerformance = JSON.parse(
    readFileSync(rendered.performancePath, 'utf8'),
  );
  if (rendered.report.channels !== 2)
    throw new RangeError(
      'Video export requires stereo or binaural audio; ambisonic movie encoding is not supported',
    );
  const visual = createPianoRoll(performance, {
    width,
    height,
    windowSeconds: options.windowSeconds,
  });
  const duration = visual.duration;
  const frames = Math.ceil(duration * fps);
  if (!Number.isSafeInteger(frames) || frames < 1)
    throw new RangeError('Video must contain at least one frame');
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = mkdtempSync(join(dirname(destination), '.video-'));
  const movie = join(temporary, 'movie.mp4');
  const encoder = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'rawvideo',
      '-pixel_format',
      'rgb24',
      '-video_size',
      `${width}x${height}`,
      '-framerate',
      String(fps),
      '-i',
      'pipe:0',
      '-i',
      rendered.destination,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      movie,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let detail = '',
    failure: Error | undefined;
  encoder.stderr.on('data', (chunk) => {
    detail = (detail + chunk.toString()).slice(-8192);
  });
  encoder.on('error', (error) => {
    failure = error;
  });
  encoder.stdin.on('error', (error) => {
    failure = error;
  });
  const completed = new Promise<number | null>((done) => encoder.once('close', done));
  try {
    for (let frame = 0; frame < frames; frame++) {
      if (failure) throw failure;
      const pixels = visual.frame(frame / fps);
      await new Promise<void>((done, reject) => {
        encoder.stdin.write(pixels, (error) => (error ? reject(error) : done()));
      });
      if (frame % (fps * 5) === 0) options.progress?.(`Video: ${frame + 1}/${frames} frames`);
    }
    encoder.stdin.end();
    const code = await completed;
    if (failure || code !== 0) throw failure ?? new Error(`FFmpeg exited with code ${code}`);
    renameSync(movie, destination);
    return {
      destination,
      audio: rendered.destination,
      performancePath: rendered.performancePath,
      duration,
      frames,
      fps,
      width,
      height,
      preset: 'piano-roll',
    };
  } catch (error) {
    encoder.stdin.destroy();
    encoder.kill();
    await completed;
    throw new Error(
      `Video encoding failed: ${detail.trim() || (error instanceof Error ? error.message : String(error))}`,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
