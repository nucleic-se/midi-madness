#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadScore } from '../packages/core/src/include.ts';

const args = process.argv.slice(2);
const force = args.includes('--force');
const paths = args.filter((arg) => !arg.startsWith('--'));
if (paths.length > 1 || args.some((arg) => arg.startsWith('--') && arg !== '--force')) {
  console.error('Usage: node scripts/render-mp3.mjs [renders-directory] [--force]');
  process.exit(2);
}
const root = paths.length
  ? resolve(paths[0])
  : fileURLToPath(new URL('../renders/', import.meta.url));
const version = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
if (version.error || version.status !== 0) {
  console.error('ffmpeg is required and must be available on PATH.');
  process.exit(1);
}
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`Render directory does not exist: ${root}`);
  process.exit(1);
}

function* mixes(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* mixes(path);
    else if (entry.isFile() && entry.name === 'mix.wav') yield path;
  }
}

let converted = 0;
let skipped = 0;
let failed = 0;
for (const input of mixes(root)) {
  const directory = dirname(input);
  const name = basename(directory);
  const output = join(directory, `${name}.mp3`);
  const reportPath = join(directory, 'report.json');
  let score;
  let expectedHash;
  try {
    if (existsSync(reportPath)) {
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      if (report.source && report.scoreHash) {
        score = report.source;
        expectedHash = report.scoreHash;
        if (loadScore(score).hash !== expectedHash)
          throw new Error('Score dependencies changed since rendering; render again first');
      }
    }
  } catch (error) {
    failed++;
    console.error(`Failed ${relative(root, input)}: ${error.message}`);
    continue;
  }
  if (!force && existsSync(output) && statSync(output).mtimeMs >= statSync(input).mtimeMs) {
    skipped++;
    continue;
  }
  // Replace the destination only after a successful conversion.
  const temporary = join(directory, `.${name}.${process.pid}.tmp.mp3`);
  try {
    const result = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-i',
        input,
        '-codec:a',
        'libmp3lame',
        '-q:a',
        '2',
        temporary,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    if (result.error || result.status !== 0)
      throw result.error ?? new Error(`ffmpeg exited with ${result.status ?? result.signal}`);
    if (score && loadScore(score).hash !== expectedHash)
      throw new Error('Score dependencies changed during encoding');
    renameSync(temporary, output);
    converted++;
    console.log(`Created ${relative(root, output)}`);
  } catch (error) {
    failed++;
    console.error(`Failed ${relative(root, input)}: ${error.message}`);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
console.log(`${converted} converted, ${skipped} up to date, ${failed} failed.`);
if (failed) process.exitCode = 1;
