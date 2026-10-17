import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
function run(...args: string[]) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'packages/cli/src/main.ts', ...args],
    { encoding: 'utf8' },
  );
}
test('CLI diagnostics are deterministic structured data and exit 1', () => {
  const result = run('check', 'tests/fixtures/G04.mm', '--json');
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const data = JSON.parse(result.stdout);
  assert.equal(data.schemaVersion, '1');
  assert.deepEqual(data.summary, { errors: 1, warnings: 0, infos: 0 });
  assert.equal(data.diagnostics[0].code, 'R003');
  assert.equal(data.diagnostics[0].file, 'tests/fixtures/G04.mm');
  assert.equal(data.diagnostics[0].path, 'part lead');
  assert.equal(result.stdout, run('check', 'tests/fixtures/G04.mm', '--json').stdout);
});
test('CLI renders the same diagnostics with source and fixes', () => {
  const result = run('check', 'tests/fixtures/G04.mm');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /error\[R003\]/);
  assert.match(result.stdout, /3 \|   length 0.2/);
  assert.match(result.stdout, /20%/);
  assert.match(result.stdout, /1\/16/);
});
test('CLI success, quiet, usage and IO exit codes', () => {
  assert.equal(run('check', 'tests/fixtures/G01.mm').status, 0);
  assert.equal(run('check', 'tests/fixtures/G01.mm', '--quiet').stdout, '');
  for (const args of [
    [],
    ['roll', 'x.mm'],
    ['new', 'unused.mm'],
    ['check'],
    ['check', 'tests/fixtures/G01.mm', '--bogus'],
    ['check', 'missing.mm'],
  ])
    assert.equal(run(...args).status, 2);
  const data = JSON.parse(run('check', 'missing.mm', '--json').stdout);
  assert.equal(data.result.failure, 'io');
});
test('inspection commands share deterministic envelopes', () => {
  const file = 'tests/fixtures/scores/five_against_the_tide.mm';
  for (const [command, ...flags] of [
    ['roll', '--part', 'lead', '--bars', '5..6'],
    ['explain', '--bar', '5'],
    ['at', 'bar 5'],
    ['metrics'],
    ['expand'],
    ['query', '--from', '1/8', '--to', '2/1'],
    ['help', 'drone'],
    ['schema', 'roll'],
  ]) {
    const args =
      command === 'help' || command === 'schema'
        ? [command, ...flags, '--json']
        : [command, file, ...flags, '--json'];
    const r = run(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).command, command);
  }
});
test('setup explain exposes controller endpoints and serializes MIDI ticks', () => {
  const args = [
    'explain',
    'setups/example/smoke.mm',
    '--setup',
    'setups/example/studio.setup',
    '--bar',
    '1',
  ];
  const result = run(...args, '--json');
  assert.equal(result.status, 0);
  const data = JSON.parse(result.stdout),
    cutoff = data.result.midi.parameters[0].values.find(
      (v: { name: string }) => v.name === 'cutoff',
    );
  assert.equal(cutoff.start.normalized, 0.2);
  assert.equal(cutoff.start.wire, 25);
  assert.equal(typeof data.result.midi.offset, 'string');
  assert.equal(typeof data.result.midi.messages[0].tick, 'string');
  assert.match(run(...args).stdout, /bar 1[\s\S]*cutoff.*wire 25/);
});
test('composer feedback exposes duration, planned port load and alias capabilities', () => {
  const file = 'setups/example/smoke.mm',
    setup = 'setups/example/studio.setup';
  const metrics = run('metrics', file, '--setup', setup, '--json');
  assert.equal(metrics.status, 0);
  const data = JSON.parse(metrics.stdout).result;
  assert.ok(Math.abs(data.durationSeconds - (16 * 60) / 110) < 1e-9);
  assert.equal(data.duration, '0:09');
  assert.ok(data.ports[0].sections[0].peakPercent > 0);
  assert.ok(data.ports[0].sections[0].averagePercent <= data.ports[0].sections[0].peakPercent);
  const alias = run('help', 'alias', 'lead', '--setup', setup, '--json');
  assert.equal(alias.status, 0);
  const binding = JSON.parse(alias.stdout).result;
  assert.equal(binding.channel, 1);
  assert.equal(binding.instrument, 'example-synth');
  assert.equal(
    binding.parameters.find((p: { name: string }) => p.name === 'cutoff').address[0],
    74,
  );
  assert.match(run('help', 'acid').stdout, /explicit note lengths[\s\S]*mm help alias acid/);
});

test('CLI engine metadata follows the release version', () => {
  const output = JSON.parse(run('schema', 'check', '--json').stdout);
  const packageVersion = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ).version;
  assert.equal(output.engine, packageVersion);
});
