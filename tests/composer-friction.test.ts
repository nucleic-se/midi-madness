import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realize } from '../packages/core/src/index.ts';
import { prepareSoftwareScore } from '../packages/render/src/score-settings.ts';
import { renderSong } from '../packages/render/src/render.ts';
import { softwareWarnings } from '../packages/render/src/warnings.ts';
import { loadSoftwareSetup } from '../packages/render/src/setup.ts';

const score = (body: string) =>
  `mm 1\nsong "repro"\n  tempo 120\n  humanize off\n  dynamics flat\nsection A = rest(1 bar)\nform = A\n${body}\n`;
const compile = (source: string) => {
  const p = prepareSoftwareScore(source);
  const r = realize(p.coreSource, { parameterDomains: p.domains });
  return { p, r };
};
const valid = (source: string) => {
  const result = compile(source);
  assert.equal(result.r.summary.errors, 0, JSON.stringify(result.r.diagnostics));
  return result;
};

test('drum lock milliseconds become seconds without dropping hits; unsupported units diagnose', () => {
  const { r } = valid(
    score(
      'part kick\n  lane kick\n  plays hits | x{drum.pitch 62, drum.pitch.depth 36, drum.pitch.decay 8ms} . . . |',
    ),
  );
  const events = r.song!.parts[0].events;
  assert.equal(events.filter((e) => e.velocity > 0).length, 1);
  assert.equal(events[0].locks['drum.pitch.decay'], 0.008);
  const bad = compile(score('part kick\n  lane kick\n  plays hits | x{tone 8ms} . . . |'));
  assert.ok(bad.r.summary.errors > 0);
  assert.throws(
    () =>
      prepareSoftwareScore(
        score('part kick\n  lane kick\n  plays hits | x{drum.pitch.decay 8Hz} . . . |'),
      ),
    /unit|expects|requires/i,
  );
});

test('fractional beat FX cuts, adjacent tuplets and implicit per-bar spans parse', () => {
  const source = score('part lead\n  plays notes | . (across 1/4: C5 E5 G5) . . |');
  valid(source);
  valid(source.replace('. (across', 'C4 (across'));
  valid(score('part kick\n  lane kick\n  plays hits | x(3,8) |'));
  valid(score('part lead\n  plays notes | C4 . . . |\n  pan = per bar smooth: 0, 1'));
  const cut = prepareSoftwareScore(
    score('silence before A for 1/2 beat and cut fx\npart lead\n  plays notes | C4 . . . |'),
  );
  assert.equal(cut.cutBefore[0].seconds, 0.25);
});

test('name collisions and bare sync provide actionable diagnostics; bus mix explains wet-only', () => {
  const clash = compile(score('part lead\n  plays notes | C4 . . . |').replace(/\bA\b/g, 'canon'));
  assert.ok(clash.r.diagnostics.some((d) => /prelude function canon/.test(d.message)));
  const bare = compile(score('part lead\n  sync 1\n  plays notes | C4 . . . |'));
  assert.ok(bare.r.diagnostics.some((d) => /sync = 1/.test(d.message)));
  assert.throws(
    () =>
      prepareSoftwareScore(
        score('fx\n  bus swirl = phaser mix 100%\npart lead\n  plays notes | C4 . . . |'),
      ),
    /wet-only/,
  );
});

test('mono chord and static chord-tuning warnings explain the corrective controls', () => {
  const source = score('part arp\n  sound saw-pluck\n  plays notes | C4+E4+G4 . . . |');
  const warnings = (s: string) => {
    const { p, r } = valid(s);
    return softwareWarnings(r, loadSoftwareSetup(), p.sounds, p.presetOverrides, p.tuning);
  };
  assert.ok(warnings(source).some((d) => /mono off/.test(d.message)));
  assert.ok(
    !warnings(source.replace('sound saw-pluck', 'sound saw-pluck\n  mono off')).some((d) =>
      /mono off/.test(d.message),
    ),
  );
  assert.ok(
    warnings(source.replace('  tempo 120', '  tempo 120\n  tuning just chord\n  harmony = i')).some(
      (d) => /one declared harmony root/.test(d.message),
    ),
  );
});

test('unused default buses are omitted and reports identify the master clamp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'composer-repro-'));
  try {
    const result = renderSong(
      score('part lead\n  sound init\n  reverb = 0\n  delay = 0\n  plays notes | C4 . . . |'),
      'repro.mm',
      { out: join(dir, 'mix.wav'), tail: 0.1 },
    );
    assert.equal(result.report.buses.echo, undefined);
    assert.equal(result.report.buses.room, undefined);
    assert.match(result.report.safety.kind, /clamp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
