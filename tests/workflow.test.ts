import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realize, Rational as R } from '../packages/core/src/index.ts';
import { prepareSoftwareScore } from '../packages/render/src/score-settings.ts';
import { readFeedback, recordFeedback } from '../packages/cli/src/commands/feedback.ts';
const header = `mm 1\nsong "Workflow"\n  tempo 120\n  humanize off\n  dynamics flat\nsection A = rest(4 bars)\nform = A\n`;

test('templates and literal loops match handwritten parts and preserve provenance', () => {
  const generated = realize(
    header +
      `template tone(cutoff: number, note: notes):
  plays notes | note . note . |
  cutoff = cutoff
for i, note in [0 G3, 1 A3, 2 B3]:
  part bell-{i} = tone((i + 1) / 4, note)
`,
  );
  assert.equal(generated.summary.errors, 0);
  const manual = realize(
    header +
      ['G3', 'A3', 'B3']
        .map(
          (note, i) =>
            `part bell-${i}\n  plays notes | ${note} . ${note} . |\n  cutoff = ${(i + 1) / 4}\n`,
        )
        .join(''),
  );
  const meaning = (r: typeof generated) =>
    r.song!.parts.map((p) => ({
      name: p.name,
      events: p.events.map((e) => [
        e.pitch,
        e.nominalOnset.toString(),
        e.gate.toString(),
        e.velocity,
      ]),
      cutoff: p.controls.cutoff.map((c) => c.value),
    }));
  assert.deepEqual(meaning(generated), meaning(manual));
  assert.equal(
    (generated.song!.parts[0].events[0].provenance.template as { name: string }).name,
    'tone',
  );
  const bad = realize(
    header +
      `template tone(note: notes):\n  plays notes | note |\nfor i, note in [0 G3, 0 A3]:\n  part bell-{i} = tone(note)\n`,
  );
  const clash = bad.diagnostics.find((d) => d.code === 'R004');
  assert.ok(clash);
  assert.equal(clash.span.line, 10);
});

test('per controls hold exact spans, loop, and interpolate across the wrap', () => {
  const r = realize(
    header +
      `part keys\n  plays notes | C4 . . . |\n  bend = per 2 bars: 0, 0.5\n  cutoff = per 2 bars smooth: 0.2, 0.8\n`,
  );
  assert.equal(r.summary.errors, 0);
  assert.deepEqual(
    [0, 1, 2, 3].map((t) => r.automation!.at('keys', 'bend', new R(t))),
    [0, 0, 0.5, 0.5],
  );
  assert.ok(Math.abs(r.automation!.at('keys', 'cutoff', new R(1))! - 0.5) < 1e-12);
  assert.ok(Math.abs(r.automation!.at('keys', 'cutoff', new R(3))! - 0.5) < 1e-12);
  assert.ok(r.automation!.boundaries('keys', 'bend').some((t) => t.equals(new R(2))));
  const fractions = realize(
    header + 'part keys\n  plays notes | C4 |\n  cutoff = per 1 bar: 1/4, 3/4\n',
  );
  assert.equal(fractions.summary.errors, 0);
  assert.equal(fractions.automation!.at('keys', 'cutoff', new R(1)), 0.75);
  assert.ok(
    realize(header + `part keys\n  plays notes | C4 |\n  cutoff = per 0 bars: 0, 1\n`).summary
      .errors > 0,
  );
});

test('per pattern rates restart at changes with the expected attack counts', () => {
  const r = realize(
    header +
      `signal speed = per 1 bar: 1, 2, 3, 2\nrhythm beat = | x x x x |.fast(speed)\npart kick\n  lane kick\n  plays hits beat\n`,
  );
  assert.equal(r.summary.errors, 0);
  assert.deepEqual(
    [0, 1, 2, 3].map(
      (bar) =>
        r.song!.parts[0].events.filter(
          (e) =>
            e.nominalOnset.compare(new R(bar)) >= 0 && e.nominalOnset.compare(new R(bar + 1)) < 0,
        ).length,
    ),
    [4, 8, 12, 8],
  );
});

test('software adapters retain template sound selections and their source locations', () => {
  const p = prepareSoftwareScore(readFileSync('tests/fixtures/render/workflow.mm', 'utf8'));
  assert.deepEqual(p.sounds, {
    'pend-0': 'ks-pluck',
    'pend-1': 'ks-pluck',
    'pend-2': 'ks-pluck',
    bed: 'choir',
  });
  const r = realize(p.coreSource, { templateContext: p.templates, parameterDomains: p.domains });
  assert.equal(r.summary.errors, 0);
  assert.equal(
    (r.song!.parts[0].events[0].provenance.template as { name: string }).name,
    'pendulum',
  );
  const units = prepareSoftwareScore(
    header +
      'part lead\n  plays notes | C4 |\n  insert = delay\n  insert.delay.time = per 1 bar: 1/16, 1/8\n',
  );
  const ur = realize(units.coreSource, { parameterDomains: units.domains });
  assert.equal(ur.summary.errors, 0);
  const v = ur.automation!.at('lead', 'insert.delay.time', new R(1))!;
  assert.ok(Math.abs(0.001 * 10000 ** v - 0.25) < 1e-12);
});

test('listening feedback retains the score snapshot and original bar/section location', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mm-feedback-'));
  try {
    const file = join(directory, 'song.mm'),
      source = header + 'part keys\n  plays notes | C4 _ _ _ |\n';
    writeFileSync(file, source);
    const song = realize(source).song!;
    const a = recordFeedback(file, source, song, 'Test listening note', '0:03');
    assert.equal(a.entry.position!.bar, 2);
    assert.equal(a.entry.position!.path, 'form/A#1');
    assert.deepEqual(a.entry.position!.parts, ['keys']);
    assert.equal(readFileSync(a.entry.sourceSnapshot, 'utf8'), source);
    const b = recordFeedback(file, source + '// revision\n', song, 'Another test note');
    assert.equal(b.entry.id, 2);
    assert.notEqual(a.entry.sourceHash, b.entry.sourceHash);
    assert.equal(readFeedback(file).entries.length, 2);
    assert.throws(() => recordFeedback(file, source, song, 'Outside', 'bar 99'), /outside/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
