import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadScore, realize, IncludeError, originOf } from '../packages/core/src/index.ts';
import { prepareSoftwareScore } from '../packages/render/src/score-settings.ts';
import { renderSong } from '../packages/render/src/render.ts';

const base = `mm 1
song "Restyling"
  tempo 240
  seed 37
  humanize 8ms
section A = rest(1 bar)
section B = rest(1 bar)
form = A B
fx
  bus echo = delay time 1/8, feedback 0.3
part lead
  group keys
  sound init
  range C3..C6
  cutoff = 0.3
  plays notes | C4 E4 G4 . |
  when in B:
    cutoff = 0.4
    plays notes | D4 F4 A4 . |
part pad
  group keys
  sound init
  range C3..C6
  plays notes | C4+E4+G4 _ . . |
`;
const layer = (body: string, file = 'base.mm') =>
  `mm 1\ninclude score ${JSON.stringify(file)}\n${body}`;
function fixture(run: (dir: string, write: (name: string, source: string) => string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-restyle-'));
  const write = (name: string, source: string) => {
    const file = join(dir, name);
    writeFileSync(file, source);
    return file;
  };
  try {
    write('base.mm', base);
    run(dir, write);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const music = (source: string) => {
  const prepared = prepareSoftwareScore(source);
  const result = realize(prepared.coreSource, { parameterDomains: prepared.domains });
  assert.equal(result.summary.errors, 0, JSON.stringify(result.diagnostics));
  return result
    .parts!.filter((p) => !p.name.startsWith('fxbus__'))
    .map((p) => ({
      name: p.name,
      events: p.events.map((e) => [
        e.id,
        e.pitch,
        e.velocity,
        e.gate.toString(),
        e.writtenSpan.toString(),
        e.locks,
        e.paths,
        e.generator,
        e.group,
        e.nominalOnset.toString(),
        e.performedOnset.toString(),
      ]),
    }));
};

test('sound/group/part and conditional overrides preserve deterministic musical events', () =>
  fixture((dir, write) => {
    const file = write(
      'style.mm',
      layer(`restyle group keys
  sound warm-lead
  cutoff = 0.6
restyle part lead
  sound fm-keys
  when in B:
    cutoff = 0.8
`),
    );
    const loaded = loadScore(file);
    assert.deepEqual(music(loaded.source), music(base));
    assert.match(loaded.source, /part lead\n  group keys\n  sound fm-keys/);
    assert.match(loaded.source, /part pad\n  group keys\n  sound warm-lead/);
    assert.match(loaded.source, /when in B:\n    cutoff = 0.8\n    plays notes/);
    assert.equal((loaded.source.match(/cutoff = 0.6/g) ?? []).length, 2);
    assert.equal((loaded.source.match(/^mm 1/gm) ?? []).length, 1);
    assert.equal(readFileSync(join(dir, 'base.mm'), 'utf8'), base);
    const originalLine =
      loaded.source.split('\n').findIndex((r) => r.includes('plays notes | D4')) + 1;
    assert.equal(originOf(loaded, originalLine)?.file, join(dir, 'base.mm'));
    const patchedLine = loaded.source.split('\n').findIndex((r) => r.includes('cutoff = 0.8')) + 1;
    assert.equal(originOf(loaded, patchedLine)?.file, file);
    assert.equal(originOf(loaded, patchedLine)?.line, 9);
    // Expanded output is a complete ordinary score.
    assert.deepEqual(music(loadScore(write('expanded.mm', loaded.source)).source), music(base));
  }));

test('nested layers, indented fragment overrides and snapshot reads preserve precedence and provenance', () =>
  fixture((dir, write) => {
    write('fields.mmi', 'sound fm-keys\ncutoff = 0.8\n');
    write('inner.mm', layer('restyle part lead\n  sound warm-lead\n'));
    const file = write(
      'outer.mm',
      layer('restyle part lead\n  include "fields.mmi"\n', 'inner.mm'),
    );
    const loaded = loadScore(file);
    assert.match(loaded.source, /sound fm-keys/);
    assert.deepEqual(music(loaded.source), music(base));
    assert.equal(loaded.files.length, 4);
    const line = loaded.source.split('\n').findIndex((r) => r.includes('cutoff = 0.8')) + 1;
    assert.deepEqual(originOf(loaded, line), {
      file: join(dir, 'fields.mmi'),
      line: 2,
      indent: 2,
      from: [{ file, line: 4 }],
    });
    const snapshot = new Map(loaded.files.map((f) => [f.path, readFileSync(f.path)]));
    const virtual = loadScore(file, { read: (p) => snapshot.get(p)! });
    assert.equal(virtual.source, loaded.source);
    assert.equal(virtual.hash, loaded.hash);
    write('fields.mmi', 'sound round-bass\n');
    assert.notEqual(loadScore(file).hash, loaded.hash);
    assert.equal(loadScore(file, { read: (p) => snapshot.get(p)! }).source, loaded.source);
  }));

test('FX replacement and bus control patches preserve notes and retain unmentioned automation', () =>
  fixture((dir, write) => {
    write('base.mm', base + 'bus echo\n  return = 0.2\n  when in B:\n    delay.feedback = 0.4\n');
    const file = write(
      'style.mm',
      layer(`restyle fx
  bus echo = delay time 1/16, feedback 0.2 -> drive amount 0.1
restyle bus echo
  return = 0.4
  when in B:
    delay.feedback = 0.6
restyle part lead
  send.echo = 0.3
`),
    );
    const source = loadScore(file).source;
    assert.deepEqual(music(source), music(base));
    assert.match(source, /return = 0.4/);
    assert.match(source, /delay.feedback = 0.6/);
    const software = prepareSoftwareScore(source);
    assert.equal(software.buses.find((b) => b.name === 'echo')?.stages.length, 2);
    const fresh = loadScore(write('new-bus.mm', layer('restyle bus room\n  return = 0.3\n')));
    assert.match(fresh.source, /bus room\n  return = 0.3/);
    assert.deepEqual(music(fresh.source), music(base));
  }));

test('no-op overrides render identical audio; changed sounds change audio with the same event schedule', () =>
  fixture((dir, write) => {
    const original = base.replace('humanize 8ms', 'humanize off');
    write('base.mm', original);
    const render = (name: string, source: string) => {
      const wav = join(dir, `${name}.wav`);
      renderSong(source, join(dir, `${name}.mm`), { out: wav, tail: 0.05 });
      return readFileSync(wav);
    };
    const a = render('base', original);
    const noop = loadScore(
      write('noop.mm', layer('restyle part lead\n  sound init\n  cutoff = 0.3\n')),
    ).source;
    assert.deepEqual(render('noop', noop), a);
    const changed = loadScore(
      write('different.mm', layer('restyle part lead\n  sound fm-keys\n')),
    ).source;
    assert.deepEqual(music(changed), music(original));
    assert.notDeepEqual(render('different', changed), a);
  }));

test('musical edits, unknown targets, invalid layers and duplicate patch fields are rejected at their source', () =>
  fixture((dir, write) => {
    for (const field of [
      'plays notes | D4 |',
      'range C2..C7',
      'restart never',
      'velocity = 0.4',
      'length = 0.5',
      'group other',
      'role bass',
      'rate = 2',
      'lane snare',
    ]) {
      const file = write('bad.mm', layer(`restyle part lead\n  ${field}\n`));
      assert.throws(
        () => loadScore(file),
        (e: unknown) =>
          e instanceof IncludeError &&
          e.file === file &&
          e.line === 4 &&
          /musical fields/.test(e.message),
      );
    }
    for (const [body, error] of [
      ['restyle part missing\n  sound init\n', /Unknown or generated/],
      ['restyle group missing\n  sound init\n', /Unknown or generated/],
      ['restyle bus missing\n  return = 0.3\n', /Unknown or generated/],
      ['restyle part lead\n  cutoff = 0.2\n  cutoff = 0.4\n', /Duplicate restyle/],
      ['restyle fx\n  plays notes | C4 |\n', /bus declarations only/],
    ] as const)
      assert.throws(() => loadScore(write('bad.mm', layer(body))), error);
    for (const source of [
      layer('part other\n  plays notes | C4 |\n'),
      layer('song "bad"\n'),
      layer('form = B A\n'),
      layer('include score "base.mm"\n'),
      'mm 1\nrestyle part lead\n  sound init\n',
      'mm 1\nrestyle part lead\n  sound init\ninclude score "base.mm"\n',
      layer('').replace('mm 1', 'mm 2'),
    ])
      assert.throws(() => loadScore(write('bad.mm', source)), IncludeError);
    write('base.mm', base.replace('mm 1', 'mm 2'));
    assert.throws(() => loadScore(write('bad.mm', layer(''))), /exactly one mm 1/);
  }));

test('score includes retain fragment boundaries and detect nested or symlink cycles', () =>
  fixture((dir, write) => {
    write('a.mm', layer('', 'b.mm'));
    const b = write('b.mm', layer('', 'a.mm'));
    assert.throws(() => loadScore(b), /Include cycle/);
    symlinkSync(join(dir, 'a.mm'), join(dir, 'alias.mm'));
    write('a.mm', layer('', 'alias.mm'));
    assert.throws(() => loadScore(join(dir, 'a.mm')), /Include cycle/);
    write('fragment.mmi', 'include score "base.mm"\n');
    assert.throws(
      () => loadScore(write('ordinary.mm', 'mm 1\ninclude "fragment.mmi"\n')),
      /top-level layer/,
    );
    assert.throws(
      () => loadScore(write('ordinary.mm', 'mm 1\ninclude "base.mm"\n')),
      /must not contain the mm header/,
    );
  }));

test('CLI errors identify both inherited and overridden source files', () =>
  fixture((dir, write) => {
    const run = (file: string) => {
      const r = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          'packages/cli/src/main.ts',
          'render',
          file,
          '--out',
          join(dir, 'out.wav'),
          '--json',
        ],
        { encoding: 'utf8' },
      );
      assert.notEqual(r.status, 0);
      return `${r.stdout}\n${r.stderr}`;
    };
    const file = write('style.mm', layer('restyle part lead\n  cutoff = 50000Hz\n'));
    assert.match(run(file), /style.mm/);
    write('style.mm', layer('restyle part lead\n  sound init\n'));
    write('base.mm', base.replace('  range C3..C6', '  cutoff = 50000Hz\n  range C3..C6'));
    assert.match(run(file), /base.mm/);
  }));

test('restyling retains harmony, seeded variation, note locks, paths and chance decisions', () =>
  fixture((dir, write) => {
    const complex = base
      .replace('form = A B', 'form = A B\nharmony = I V')
      .replace(
        'plays notes | C4 E4 G4 . |',
        'plays notes (| c1{pitch -> E4 over 1/8, cutoff 0.2, chance 80%} c3 c5 . |).vary(1)',
      )
      .replace('plays notes | C4+E4+G4 _ . . |', 'plays chords');
    write('base.mm', complex);
    const source = loadScore(
      write('style.mm', layer('restyle part lead\n  sound warm-lead\n  insert = eq gain 3dB\n')),
    ).source;
    assert.deepEqual(music(source), music(complex));
    assert.ok(music(complex).flatMap((p) => p.events).length > 0);
  }));

test('generated targets are rejected while unmodified template parts coexist with restyled explicit parts', () =>
  fixture((dir, write) => {
    const source =
      base +
      'template tone():\n  sound init\n  plays notes | D4 . . . |\npart generated = tone()\n';
    write('base.mm', source);
    assert.throws(
      () => loadScore(write('bad.mm', layer('restyle part generated\n  sound warm-lead\n'))),
      /Unknown or generated/,
    );
    const loaded = loadScore(write('style.mm', layer('restyle part lead\n  sound warm-lead\n')));
    assert.deepEqual(music(loaded.source), music(source));
  }));

test('data paths remain relative to their source and replaced data fields need no obsolete dependency', () =>
  fixture((dir, write) => {
    write('values.json', '{"cutoff":[0.2,0.8]}');
    const file = write(
      'style.mm',
      layer('restyle part lead\n  cutoff = data "values.json" key cutoff\n'),
    );
    const loaded = loadScore(file);
    assert.equal(loaded.files.at(-1)?.kind, 'data');
    assert.match(loaded.source, /cutoff = data "\//);
    assert.deepEqual(music(loaded.source), music(base));
    write('base.mm', base.replace('cutoff = 0.3', 'cutoff = data "obsolete.json" key cutoff'));
    const replaced = loadScore(write('override.mm', layer('restyle part lead\n  cutoff = 0.5\n')));
    assert.ok(!replaced.files.some((f) => f.path.endsWith('obsolete.json')));
    assert.deepEqual(music(replaced.source), music(base));
  }));

test('new conditional blocks validate duplicate keys and preserve existing conditional controls', () =>
  fixture((dir, write) => {
    for (const fields of [
      '    cutoff = 0.2\n    cutoff = 0.3',
      '    plays notes | C4 |',
      '    sound init',
    ]) {
      assert.throws(
        () => loadScore(write('bad.mm', layer(`restyle part lead\n  when in A:\n${fields}\n`))),
        /Duplicate restyle|musical fields/,
      );
    }
    const source = loadScore(
      write('style.mm', layer('restyle part lead\n  cutoff = 0.9\n')),
    ).source;
    assert.match(source, /when in B:\n    cutoff = 0.4/);
    assert.deepEqual(music(source), music(base));
    assert.throws(
      () => loadScore(write('bad.mm', 'mm 1\n  tempo 120\ninclude score "base.mm"\n')),
      /Indented layer fields/,
    );
  }));

test('new conditional sound controls preserve events and dangling replaced FX references remain errors', () =>
  fixture((dir, write) => {
    const source = loadScore(
      write('conditional.mm', layer('restyle part lead\n  when in A:\n    cutoff = 0.8\n')),
    ).source;
    assert.deepEqual(music(source), music(base));
    write('base.mm', base + 'bus echo\n  delay.feedback = 0.2\n');
    const broken = loadScore(
      write('broken.mm', layer('restyle fx\n  bus echo = reverb decay 1s\n')),
    );
    assert.throws(
      () =>
        renderSong(broken.source, broken.file, { score: broken, out: join(dir, 'invalid.wav') }),
      /Unknown bus parameter/,
    );
  }));

test('sound controls written by their score names can be restyled', () =>
  fixture((_, write) => {
    const file = write(
      'resonance.mm',
      layer('restyle part lead\n  resonance = per 1/8: 0.2, 0.4, 0.3\n  keytrack = 1\n'),
    );
    const prepared = prepareSoftwareScore(loadScore(file).source);
    assert.match(prepared.coreSource, /resonance = per 1\/8: 0\.2, 0\.4, 0\.3/);
    assert.deepEqual(music(loadScore(file).source), music(base));
  }));
