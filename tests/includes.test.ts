import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { loadScore, IncludeError, realize, musicalDiff } from '../packages/core/src/index.ts';
import { loadDataLanes } from '../packages/core/src/data.ts';
import { accept, accepted, revisionSource } from '../packages/cli/src/commands/snapshot.ts';
import { renderSong } from '../packages/render/src/render.ts';

function fixture(
  run: (directory: string, write: (path: string, source: string) => string) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), 'mm-includes-'));
  const write = (path: string, source: string) => {
    const file = join(directory, path);
    writeFileSync(file, source);
    return file;
  };
  mkdirSync(join(directory, 'gen'));
  try {
    run(directory, write);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function cli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'packages/cli/src/main.ts', ...args],
    { encoding: 'utf8' },
  );
}
const song = 'mm 1\nsong "Includes"\n  humanize off\nsection A = | C4 |\nform = A\n';

test('includes expand in place, nest relative to their file, and add indentation', () =>
  fixture((directory, write) => {
    write('gen/notes.mmi', 'plays melody\n');
    write('gen/body.mmi', 'restart never\ninclude "notes.mmi" // nested\n');
    const file = write('song.mm', song + 'part lead\n  include "gen/body.mmi" // body\n');
    const loaded = loadScore(file);
    assert.equal(loaded.source, song + 'part lead\n  restart never\n  plays melody\n');
    assert.equal(realize(loaded.source).summary.errors, 0);
    assert.deepEqual(loaded.lineMap.at(-1), {
      file: join(directory, 'gen/notes.mmi'),
      line: 1,
      indent: 2,
      from: [
        { file: join(directory, 'gen/body.mmi'), line: 2 },
        { file, line: 7 },
      ],
    });
    assert.equal(loaded.files.length, 3);
    // Repeated inclusion is legal; the dependency list stays unique.
    write('song.mm', 'mm 1\ninclude "gen/notes.mmi"\ninclude "gen/notes.mmi"\n');
    assert.equal(loadScore(file).files.length, 2);
    assert.equal(loadScore(file).source, 'mm 1\nplays melody\nplays melody\n');
  }));

test('cycles, missing includes, malformed includes and fragment headers are located errors', () =>
  fixture((directory, write) => {
    const file = write('song.mm', 'mm 1\ninclude "gen/a.mmi"\n');
    write('gen/a.mmi', 'include "b.mmi"\n');
    write('gen/b.mmi', 'include "a.mmi"\n');
    assert.throws(() => loadScore(file), /Include cycle: gen\/a.mmi -> gen\/b.mmi -> gen\/a.mmi/);
    for (const content of [
      'mm 1\n',
      '  song "bad"\n',
      'include "missing.mmi"\n',
      'include "b.mmi" trailing\n',
    ]) {
      write('gen/a.mmi', content);
      assert.throws(
        () => loadScore(file),
        (error: unknown) => {
          assert.ok(error instanceof IncludeError);
          assert.equal(error.file, join(directory, 'gen/a.mmi'));
          assert.equal(error.line, 1);
          assert.deepEqual(error.from, [{ file, line: 2 }]);
          return true;
        },
      );
    }
    write('gen/a.mmi', 'include "alias.mmi"\n');
    symlinkSync(join(directory, 'gen/a.mmi'), join(directory, 'gen/alias.mmi'));
    assert.throws(() => loadScore(file), /Include cycle/);
    const result = cli('check', file, '--json');
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).diagnostics[0].file, join(directory, 'gen/a.mmi'));
  }));

test('dependency hashes preserve standalone bytes and detect included/data edits', () =>
  fixture((directory, write) => {
    const raw = Buffer.from('mm 1\r\n// untouched\r\n');
    const file = write('song.mm', raw.toString());
    assert.equal(loadScore(file).source, raw.toString());
    assert.equal(loadScore(file).hash, createHash('sha256').update(raw).digest('hex'));
    write('gen/lane.json', '{"v":[0.2,0.4]}');
    write('gen/body.mmi', 'cutoff = data "lane.json" key v // data "ignored.json"\nplays melody\n');
    write('song.mm', song + 'part lead\n  include "gen/body.mmi"\n');
    const loaded = loadScore(file);
    assert.equal(loaded.files.length, 3);
    assert.match(loaded.source, new RegExp(JSON.stringify(join(directory, 'gen/lane.json'))));
    assert.match(
      loadDataLanes(loaded.source, file).source,
      /cutoff =per 1 bar smooth: 0.2, 0.4|cutoff = per 1 bar smooth: 0.2, 0.4/,
    );
    write('gen/lane.json', '{"v":[0.3,0.4]}');
    assert.notEqual(loadScore(file).hash, loaded.hash);
    const dataHash = loadScore(file).hash;
    write('gen/body.mmi', 'plays melody\n');
    assert.notEqual(loadScore(file).hash, dataHash);
  }));

test('CLI diagnostics retain original line, column, fixes and include chain', () =>
  fixture((directory, write) => {
    write('gen/body.mmi', '// body\nlength 0.2\n');
    const file = write('song.mm', 'mm 1\npart lead\n  include "gen/body.mmi"\n');
    const result = cli('check', file, '--json');
    assert.equal(result.status, 1, result.stderr);
    const d = JSON.parse(result.stdout).diagnostics[0];
    assert.equal(d.file, join(directory, 'gen/body.mmi'));
    assert.equal(d.span.line, 2);
    assert.equal(d.span.col, 8);
    assert.deepEqual(d.includedFrom, [{ file, line: 3 }]);
    assert.equal(d.fixes[0].edits[0].span.line, 2);
    assert.match(cli('check', file).stdout, /included from .*song.mm:3/);
  }));

test('expand output checks and realizes identically even when saved elsewhere', () =>
  fixture((directory, write) => {
    write('gen/body.mmi', 'cutoff = data "lane.json" key v\nplays melody\n');
    write('gen/lane.json', '{"v":[0.2,0.4]}');
    const file = write('song.mm', song + 'part lead\n  include "gen/body.mmi"\n');
    const expanded = cli('expand', file);
    assert.equal(expanded.status, 0, expanded.stderr);
    assert.doesNotMatch(expanded.stdout, /include "/);
    const other = write('gen/expanded.mm', expanded.stdout);
    const originalCheck = JSON.parse(cli('check', file, '--json').stdout);
    const expandedCheck = JSON.parse(cli('check', other, '--json').stdout);
    assert.deepEqual(originalCheck.summary, expandedCheck.summary);
    assert.deepEqual(originalCheck.result.parts, expandedCheck.result.parts);
    assert.equal(originalCheck.result.dependencies.length, 3);
    assert.deepEqual(
      musicalDiff(realize(loadScore(file).source).song!, realize(loadScore(other).source).song!)
        .parts,
      [],
    );
  }));

test('accepted versions freeze includes and external lanes with their dependency list', () =>
  fixture((directory, write) => {
    write('gen/body.mmi', 'cutoff = data "lane.json" key v\nplays melody\n');
    write('gen/lane.json', '{"v":[0.2,0.4]}');
    const file = write('song.mm', song + 'part lead\n  include "gen/body.mmi"\n');
    const loaded = loadScore(file);
    const metadata = accept(file, loaded.source, realize(loaded.source).song!, loaded);
    assert.equal(metadata.scoreHash, loaded.hash);
    assert.deepEqual(metadata.dependencies, loaded.files);
    const before = accepted(file).source;
    assert.doesNotMatch(before, /include "|data "/);
    write('gen/body.mmi', 'plays notes | D4 |\n');
    rmSync(join(directory, 'gen/lane.json'));
    assert.equal(accepted(file).source, before);
    assert.equal(realize(before).summary.errors, 0);
  }));

test('render reports and performance sidecars share dependency provenance', () =>
  fixture((directory, write) => {
    write('gen/body.mmi', 'plays melody\n');
    const file = write('song.mm', song + 'part lead\n  include "gen/body.mmi"\n');
    const loaded = loadScore(file);
    const result = renderSong(loaded.source, file, {
      score: loaded,
      out: join(directory, 'mix.wav'),
      tail: 0,
    });
    assert.equal(result.report.scoreHash, loaded.hash);
    assert.deepEqual(result.report.dependencies, loaded.files);
    assert.equal(
      JSON.parse(readFileSync(join(directory, 'mix.events.json'), 'utf8')).scoreHash,
      loaded.hash,
    );
  }));

test('missing and invalid data report the fragment line and chain', () =>
  fixture((directory, write) => {
    write('gen/body.mmi', '// lane\ncutoff = data "lane.json" key v\nplays melody\n');
    const file = write('song.mm', song + 'part lead\n  include "gen/body.mmi"\n');
    for (const contents of [undefined, '{"v":[]}']) {
      if (contents) write('gen/lane.json', contents);
      const result = cli('check', file, '--json');
      assert.equal(result.status, 1, result.stderr);
      const d = JSON.parse(result.stdout).diagnostics.find((d: { message: string }) =>
        /data/i.test(d.message),
      );
      assert.equal(d.file, join(directory, 'gen/body.mmi'));
      assert.equal(d.span.line, 2);
      assert.deepEqual(d.includedFrom, [{ file, line: 7 }]);
    }
  }));

test('data-only provenance changes with lane bytes and survives moving a score tree', () =>
  fixture((directory, write) => {
    const source = song + 'part lead\n  cutoff = data "lane.json" key v\n  plays melody\n';
    const file = write('song.mm', source);
    write('lane.json', '{"v":[0.2]}');
    const first = loadScore(file);
    assert.equal(first.files.length, 2);
    write('gen/song.mm', source);
    write('gen/lane.json', '{"v":[0.2]}');
    assert.equal(loadScore(join(directory, 'gen/song.mm')).hash, first.hash);
    write('lane.json', '{"v":[0.8]}');
    assert.notEqual(loadScore(file).hash, first.hash);
  }));

test('historical diffs read includes and data from the requested git revision', () =>
  fixture((directory, write) => {
    write('gen/body.mmi', 'cutoff = data "lane.json" key v\nplays melody\n');
    write('gen/lane.json', '{"v":[0.2]}');
    const file = write('song.mm', song + 'part lead\n  include "gen/body.mmi"\n');
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['add', '.'], { cwd: directory });
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
    write('gen/body.mmi', 'plays notes | D4 |\n');
    write('gen/lane.json', '{"v":[0.8]}');
    const historic = revisionSource(file, 'HEAD');
    assert.match(historic, /smooth: 0.2/);
    assert.doesNotMatch(historic, /include "|data "|D4/);
    assert.equal(realize(historic).summary.errors, 0);
  }));

test('MP3 conversion rejects a render after an included file changes', (t) =>
  fixture((directory, write) => {
    if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
      t.skip('ffmpeg is not installed');
      return;
    }
    const file = write('song.mm', song + 'part lead\n  include "gen/body.mmi"\n');
    write('gen/body.mmi', 'plays melody\n');
    write('report.json', JSON.stringify({ source: file, scoreHash: loadScore(file).hash }));
    write('mix.wav', '');
    write('gen/body.mmi', 'plays notes | D4 |\n');
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/render-mp3.mjs', directory],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dependencies changed since rendering/);
  }));
