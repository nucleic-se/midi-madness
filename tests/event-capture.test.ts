import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderSong, type RenderOptions } from '../packages/render/src/render.ts';

const source = `mm 1
song "Event capture"
  tempo 240
  humanize off
section A = rest(1 bar)
form = A
part lead
  sound init
  mono on
  release = 0.4
  cutoff = per 1/8 smooth: 0.1, 0.9
  plays notes | C4{length 1/2} E4 . . |
part kick
  lane kick
  plays hits | x . x . |
`;

test('reduced event capture preserves all audio and scheduled inputs, omitting unrequested envelope work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-capture-'));
  try {
    const render = (name: string, options: RenderOptions = {}) => {
      const result = renderSong(source, join(dir, 'song.mm'), {
        out: join(dir, name, 'mix.wav'),
        noAnalysis: true,
        tail: 0.1,
        ...options,
      });
      return {
        wav: readFileSync(result.destination),
        data: JSON.parse(readFileSync(result.performancePath!, 'utf8')),
      };
    };
    const full = render('full'),
      explicit = render('explicit', { eventEnvelopes: 'full' }),
      lean = render('lean', { eventEnvelopes: 'none' }),
      selected = render('selected', { eventParts: ['kick'] }),
      combined = render('combined', { eventParts: ['lead'], eventEnvelopes: 'none' });
    assert.equal(full.data.version, 1);
    assert.equal(full.data.capture, undefined, 'default contract stays unchanged');
    for (const alternative of [explicit, lean, selected, combined])
      assert.deepEqual(alternative.wav, full.wav);
    const { capture, ...explicitData } = explicit.data;
    assert.deepEqual(explicitData, full.data);
    assert.deepEqual(lean.data.capture, { envelopes: 'none', parts: ['lead', 'kick'] });
    for (const track of full.data.tracks) {
      assert.ok(track.envelopes.length);
      const { envelopes, ...inputs } = track;
      assert.deepEqual(
        lean.data.tracks.find((t: any) => t.name === track.name),
        inputs,
      );
    }
    assert.deepEqual(
      selected.data.tracks,
      full.data.tracks.filter((t: any) => t.name === 'kick'),
    );
    assert.deepEqual(
      selected.data.score.parts.map((p: any) => p.name),
      ['kick'],
    );
    assert.deepEqual(
      combined.data.tracks.map((p: any) => p.name),
      ['lead'],
    );
    assert.equal(combined.data.tracks[0].envelopes, undefined);
    assert.deepEqual(combined.data.audio, full.data.audio);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid capture settings fail before replacing existing output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-capture-invalid-'));
  try {
    const out = join(dir, 'mix.wav');
    renderSong(source, 'song.mm', { out, tail: 0, noAnalysis: true });
    const before = readFileSync(out);
    for (const options of [
      { eventEnvelopes: 'brief' as 'none' },
      { eventParts: [] },
      { eventParts: [''] },
      { eventParts: ['missing'] },
      { eventParts: ['lead'], solo: 'kick' },
    ]) {
      assert.throws(() => renderSong(source, 'song.mm', { out, ...options }), /Event/);
      assert.deepEqual(readFileSync(out), before);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('render CLI forwards event options and rejects invalid or misplaced options', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-capture-cli-'));
  try {
    const file = join(dir, 'song.mm'),
      out = join(dir, 'mix.wav');
    writeFileSync(file, source);
    const invoke = (command: string, ...options: string[]) =>
      spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          'packages/cli/src/main.ts',
          command,
          file,
          ...options,
          '--json',
        ],
        { encoding: 'utf8' },
      );
    const success = invoke(
      'render',
      '--out',
      out,
      '--tail',
      '0',
      '--no-analysis',
      '--events-envelopes',
      'none',
      '--events-parts',
      'kick',
    );
    assert.equal(success.status, 0, success.stderr + success.stdout);
    const data = JSON.parse(readFileSync(join(dir, 'mix.events.json'), 'utf8'));
    assert.deepEqual(data.capture, { envelopes: 'none', parts: ['kick'] });
    assert.deepEqual(
      data.tracks.map((t: any) => t.name),
      ['kick'],
    );
    assert.equal(data.tracks[0].envelopes, undefined);
    for (const [command, options] of [
      ['render', ['--events-envelopes', 'brief']],
      ['render', ['--events-parts', 'lead,']],
      ['render', ['--events-parts', 'missing']],
      ['check', ['--events-envelopes', 'none']],
    ] as const) {
      const result = invoke(command, ...options);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.equal(JSON.parse(result.stdout).result.failure, 'usage');
      assert.match(result.stdout + result.stderr, /events|Event/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
