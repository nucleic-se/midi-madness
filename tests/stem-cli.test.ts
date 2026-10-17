import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
test('render CLI accepts --stems-by group and forwards it to the renderer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-stem-cli-'));
  try {
    const score = join(dir, 'song.mm');
    writeFileSync(
      score,
      'mm 1\nsong "CLI stems"\n  tempo 120\n  humanize off\nsection A = rest(1 bars)\nform = A\npart lead\n  sound init\n  range C4..C5\n  group melody\n  plays notes | C4 . . . |\n',
    );
    execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve('packages/cli/src/main.ts'),
        'render',
        score,
        '--bars',
        '1',
        '--tail',
        '0',
        '--stems-by',
        'group',
        '--quiet',
        '--out',
        join(dir, 'mix.wav'),
      ],
      { stdio: 'pipe' },
    );
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    assert.ok(report.groupStems.melody.file.endsWith('melody.wav'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
