import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realize, Rational as R } from '../packages/core/src/index.ts';
import { harmonyRoll, positionAt, at } from '../packages/core/src/inspect.ts';
import { help } from '../packages/cli/src/commands/help.ts';
import { reserved } from '../packages/core/src/lexer.ts';
const source =
  'mm 1\nsong "Inspect"\n  meter 6/8\n  key D minor\n  humanize off\nsection A = | D4 E4 F4 |\nform = A A.modulate(2)\nharmony = i V V every 1/4\npart lead\n  plays notes | D4 E4 F4 |\n';
test('harmony inspection reports intra-bar changes, section modulation and meter beats', () => {
  const r = realize(source);
  assert.equal(r.summary.errors, 0, JSON.stringify(r.diagnostics));
  const rows = harmonyRoll(r.structure!, r.harmony!, 1, 2);
  assert.deepEqual(
    rows.map((b) => b.changes.map((c) => [c.beat.toString(), c.chord, c.key])),
    [
      [
        ['1/1', 'i', 'D minor'],
        ['2/1', 'V', 'D minor'],
      ],
      [
        ['1/1', 'i', 'E minor'],
        ['2/1', 'V', 'E minor'],
      ],
    ],
  );
  assert.equal(positionAt(r.song!, new R(1, 4)).beat!.toString(), '2/1');
  assert.equal(at(r.song!, new R(1, 4)).beat!.toString(), '2/1');
  const undeclared = realize(source.replace('harmony = i V V every 1/4\n', ''));
  assert.equal(harmonyRoll(undeclared.structure!, undeclared.harmony!)[0].changes[0].chord, null);
});
test('CLI harmony rows and event positions are available in human and JSON inspection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inspect-options-'));
  try {
    const path = join(dir, 'song.mm');
    writeFileSync(path, source);
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        ['--experimental-strip-types', 'packages/cli/src/main.ts', ...args],
        { encoding: 'utf8' },
      );
    const roll = run('roll', path, '--harmony', '--bars', '2', '--json');
    assert.equal(roll.status, 0, roll.stdout);
    const rows = JSON.parse(roll.stdout).result;
    assert.equal(rows.harmony.length, 1);
    assert.equal(rows.harmony[0].bar, 2);
    assert.match(rows.text, /beat 2\/1: V \[E minor\]/);
    const explain = run('explain', path, '--bar', '1', '--positions', '--json');
    assert.equal(explain.status, 0, explain.stdout);
    const events = JSON.parse(explain.stdout).result.parts[0].events;
    assert.deepEqual(
      events.map((e: { position: { bar: number; beat: string } }) => [
        e.position.bar,
        e.position.beat,
      ]),
      [
        [1, '1/1'],
        [1, '2/1'],
        [1, '3/1'],
      ],
    );
    assert.match(run('explain', path, '--bar', '1', '--positions').stdout, /bar 1, beat 2\/1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('names help includes actual reserved words and built-in functions', () => {
  const result = help('names');
  for (const name of reserved) assert.ok(result.text.includes(name));
  assert.match(result.text, /Separate|separate/);
  assert.match(result.text, /cadence/);
});
