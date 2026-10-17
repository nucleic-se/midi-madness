import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { realize, musicalDiff } from '../packages/core/src/index.ts';
import { accept, accepted } from '../packages/cli/src/commands/snapshot.ts';
test('F13: dirty acceptance saves exact source and diff shows only later edit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mm-accepted-'));
  try {
    const file = join(directory, 'song.mm'),
      base =
        'mm 1\nsong "Snapshot"\n  humanize off\n  dynamics flat\nsection A = | C4 |\nform = A\npart lead\n  plays melody\n';
    writeFileSync(file, base);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['add', 'song.mm'], { cwd: directory });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-qm',
        'baseline',
      ],
      { cwd: directory },
    );
    const first = base.replace('C4', 'D4');
    writeFileSync(file, first);
    const metadata = accept(file, first, realize(first).song!);
    assert.equal(metadata.dirty, true);
    assert.ok(metadata.gitRevision);
    assert.equal(accepted(file).source, first);
    const second = first.replace('D4', 'E4');
    writeFileSync(file, second);
    const diff = musicalDiff(realize(accepted(file).source).song!, realize(second).song!);
    assert.equal(diff.parts[0].changed[0].before!.pitch, 62);
    assert.equal(diff.parts[0].changed[0].after!.pitch, 64);
    const cli = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        'packages/cli/src/main.ts',
        'diff',
        file,
        '--since',
        'accepted',
        '--json',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).result.parts[0].changed.length, 1);
    assert.equal(readFileSync(`${file}.accepted/source.mm`, 'utf8'), first);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
