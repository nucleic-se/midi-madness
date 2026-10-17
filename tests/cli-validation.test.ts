import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const header = 'mm 1\nsong "Validation"\n  humanize off\nsection A = rest(1 bar)\nform = A\n';
const valid = header + 'part lead\n  plays notes | C4 . . . |\n';
const invoke = (...args: string[]) =>
  spawnSync(process.execPath, ['--experimental-strip-types', 'packages/cli/src/main.ts', ...args], {
    encoding: 'utf8',
  });
function fixture(run: (path: string, directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'score-validation-'));
  const path = join(directory, 'song.mm');
  try {
    writeFileSync(path, valid);
    run(path, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test('software setting errors have score diagnostics and original include locations', () =>
  fixture((path, directory) => {
    const fragment = join(directory, 'lead.mmi');
    writeFileSync(fragment, 'sound missing-preset\nplays notes | C4 . . . |\n');
    writeFileSync(path, header + 'part lead\n  include "lead.mmi"\n');
    for (const command of ['check', 'render']) {
      const args =
        command === 'check'
          ? ['--setup', 'setups/band/band.setup']
          : ['--out', join(directory, 'mix.wav'), '--tail', '0'];
      const result = invoke(command, path, ...args, '--json');
      assert.equal(result.status, 1, result.stderr);
      const data = JSON.parse(result.stdout);
      assert.equal(data.summary.errors, 1);
      assert.equal(data.result.failure, undefined);
      assert.equal(data.diagnostics[0].file, fragment);
      assert.equal(data.diagnostics[0].span.line, 1);
      assert.match(data.diagnostics[0].message, /missing-preset/);
      assert.ok(data.diagnostics[0].includedFrom.length);
    }
    const human = invoke('check', path, '--setup', 'setups/band/band.setup');
    assert.match(human.stdout, /error\[R003\]/);
    assert.ok(human.stdout.includes(fragment + ':1:'));
  }));
test('software insert and bus declarations diagnose at their authored lines', () =>
  fixture((path) => {
    for (const [source, line] of [
      [header + 'part lead\n  insert = not-an-effect\n  plays notes | C4 . . . |\n', 7],
      [header + 'fx\n  bus hall = not-an-effect\npart lead\n  plays notes | C4 . . . |\n', 7],
      [header + 'part lead\n  send.missing = 1\n  plays notes | C4 . . . |\n', 6],
      [header + 'mix\n  echo time 20s\npart lead\n  plays notes | C4 . . . |\n', 7],
      [
        header.replace('  humanize off', '  space distance inverse, reverb missing') +
          'part lead\n  plays notes | C4 . . . |\n',
        3,
      ],
      [
        header +
          'silence before missing for 1 beat and cut fx\npart lead\n  plays notes | C4 . . . |\n',
        6,
      ],
    ] as const) {
      writeFileSync(path, source);
      const result = invoke('check', path, '--setup', 'setups/band/band.setup', '--json');
      assert.equal(result.status, 1, result.stderr);
      const data = JSON.parse(result.stdout);
      assert.equal(data.summary.errors, 1);
      assert.equal(data.diagnostics[0].span.line, line);
    }
  }));
test('software template errors map back to the authored invocation', () =>
  fixture((path) => {
    const source =
      header +
      'template tone():\n  sound missing-preset\n  plays notes | C4 . . . |\n\npart lead = tone()\n';
    writeFileSync(path, source);
    const result = invoke('check', path, '--setup', 'setups/band/band.setup', '--json');
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.summary.errors, 1);
    assert.equal(data.diagnostics[0].span.line, 10);
    assert.equal(data.diagnostics[0].file, path);
  }));
test('usage and filesystem failures remain distinct from score validation', () =>
  fixture((path, directory) => {
    for (const args of [
      ['check', path, '--solo', 'lead'],
      ['expand', path, '--to', 'nonsense'],
      ['expand', path, '--to', 'bar'],
      ['help', '--bogus'],
      ['check', path, '--color', 'always'],
      ['check', path, '--json', '--json'],
      ['play', path, '--clock', 'banana'],
      ['render', path, '--bars', '0'],
      ['roll', path, '--bars', '5..2'],
      ['render', path, '--tail', '-1'],
    ]) {
      const result = invoke(...args, ...(args.includes('--json') ? [] : ['--json']));
      assert.equal(result.status, 2, JSON.stringify(args) + result.stdout);
      assert.equal(JSON.parse(result.stdout).result.failure, 'usage');
    }
    const missing = invoke('check', join(directory, 'missing.mm'), '--json');
    assert.equal(missing.status, 2);
    assert.equal(JSON.parse(missing.stdout).result.failure, 'io');
    const setup = invoke('check', path, '--setup', join(directory, 'missing.setup'), '--json');
    assert.equal(setup.status, 2);
    assert.equal(JSON.parse(setup.stdout).result.failure, 'io');
  }));
test('check explicitly reports target and warns when software settings are not checked', () =>
  fixture((path) => {
    writeFileSync(path, header + 'part lead\n  sound warm-lead\n  plays notes | C4 . . . |\n');
    const plain = invoke('check', path, '--json');
    assert.equal(plain.status, 0);
    const core = JSON.parse(plain.stdout);
    assert.deepEqual(core.result.validation, { target: 'core', software: false });
    assert.ok(core.diagnostics.some((d: { code: string }) => d.code === 'I005'));
    const checked = invoke('check', path, '--setup', 'setups/band/band.setup', '--json');
    assert.equal(checked.status, 0);
    const software = JSON.parse(checked.stdout);
    assert.deepEqual(software.result.validation, { target: 'software', software: true });
    assert.ok(!software.diagnostics.some((d: { code: string }) => d.code === 'I005'));
    const midi = invoke(
      'check',
      'setups/example/smoke.mm',
      '--setup',
      'setups/example/studio.setup',
      '--json',
    );
    assert.equal(midi.status, 0);
    assert.equal(JSON.parse(midi.stdout).result.validation.target, 'midi');
    writeFileSync(path, valid);
    const simple = JSON.parse(invoke('check', path, '--json').stdout);
    assert.ok(!simple.diagnostics.some((d: { code: string }) => d.code === 'I005'));
  }));

test('render retains compiler diagnostics instead of reclassifying them as usage errors', () =>
  fixture((path, directory) => {
    writeFileSync(path, header + 'part lead\n  plays notes missing-name\n');
    const result = invoke('render', path, '--out', join(directory, 'mix.wav'), '--json');
    assert.equal(result.status, 1, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.ok(data.summary.errors > 0);
    assert.ok(data.diagnostics.some((d: { code: string }) => d.code === 'R001'));
    assert.equal(data.result.failure, undefined);
  }));

test('native envelope and EQ errors retain included source diagnostics', () =>
  fixture((path, directory) => {
    const fragment = join(directory, 'controls.mmi');
    for (const field of ['attack = 0ms', 'filter.release = 9s', 'insert = eq gain 30dB']) {
      writeFileSync(fragment, field + '\nplays notes | C4 . . . |\n');
      writeFileSync(path, header + 'part lead\n  include "controls.mmi"\n');
      const result = invoke('check', path, '--setup', 'setups/band/band.setup', '--json');
      assert.equal(result.status, 1, result.stderr);
      const data = JSON.parse(result.stdout);
      assert.equal(data.summary.errors, 1);
      assert.equal(data.diagnostics[0].file, fragment);
      assert.equal(data.diagnostics[0].span.line, 1);
      assert.match(data.diagnostics[0].message, /must be/);
    }
  }));

test('section lane diagnostics preserve include and template origins', () =>
  fixture((path, directory) => {
    const fragment = join(directory, 'controls.mmi');
    writeFileSync(fragment, 'cutoff = by section: missing 0.3, * 0.2\nplays notes | C4 . . . |\n');
    writeFileSync(path, header + 'part lead\n  include "controls.mmi"\n');
    const included = invoke('check', path, '--setup', 'setups/band/band.setup', '--json');
    assert.equal(included.status, 1, included.stderr);
    const data = JSON.parse(included.stdout);
    assert.equal(data.diagnostics[0].file, fragment);
    assert.equal(data.diagnostics[0].span.line, 1);
    assert.match(data.diagnostics[0].message, /Unknown section selector/);
    const source =
      header +
      'template tone():\n  cutoff = by section: missing 0.2, * 0.3\n  plays notes | C4 . . . |\n\npart lead = tone()\n';
    writeFileSync(path, source);
    const templated = invoke('check', path, '--setup', 'setups/band/band.setup', '--json');
    assert.equal(templated.status, 1, templated.stderr);
    assert.equal(JSON.parse(templated.stdout).diagnostics[0].span.line, 10);
  }));
