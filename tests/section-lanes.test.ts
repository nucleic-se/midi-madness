import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  realize,
  query,
  Rational as R,
  parseExpression,
  parse,
} from '../packages/core/src/index.ts';
import { expressionText } from '../packages/core/src/source.ts';
import { renderSong } from '../packages/render/src/render.ts';
import { fastShapeControl } from '../packages/render/src/shape-rate.ts';
import { prepareSoftwareScore } from '../packages/render/src/score-settings.ts';

const header =
  'mm 1\nsong "Section controls"\n  tempo 240\n  humanize off\n  dynamics flat\nsection A = rest(1 bar)\nsection B = rest(2 bars)\nform = A B A\n';
const score = (value: string, extra = '') =>
  header +
  extra +
  `part lead\n  sound init\n  range C0..C9\n  restart every 1 bar\n  cutoff = ${value}\n  plays notes | C4 E4 . . |\n`;
const r = (s: string) => {
  const x = realize(s);
  assert.equal(x.summary.errors, 0, JSON.stringify(x.diagnostics));
  return x;
};
const points = (x: ReturnType<typeof realize>, name = 'cutoff') =>
  x.parts![0].controls[name].map((p) => [p.time.toString(), p.value]);
const events = (x: ReturnType<typeof realize>) =>
  x.parts![0].events.map((e) => [
    e.id,
    e.nominalOnset.toString(),
    e.performedOnset.toString(),
    e.gate.toString(),
    e.pitch,
    e.velocity,
  ]);

test('section controls lower to equivalent song-clock hold/smooth lanes without changing events', () => {
  for (const smooth of [false, true]) {
    const keyed = r(score(`by section: A 0.2, B 0.8${smooth ? ' smooth 1 bar' : ''}`));
    const explicit = r(
      score(
        `per song 1 bar${smooth ? ' smooth' : ''}: ${smooth ? '0.2, 0.2, 0.8, 0.8, 0.2, 0.2' : '0.2, 0.8, 0.8, 0.2, 0.2, 0.2'}`,
      ),
    );
    assert.deepEqual(points(keyed), points(explicit));
    assert.deepEqual(events(keyed), events(explicit));
    assert.deepEqual(
      keyed.automation!.boundaries('lead', 'cutoff'),
      explicit.automation!.boundaries('lead', 'cutoff'),
    );
    for (let i = 0; i < 64; i++) {
      const at = new R(i, 16);
      assert.equal(
        keyed.automation!.at('lead', 'cutoff', at),
        explicit.automation!.at('lead', 'cutoff', at),
      );
    }
    const q = query(score('by section: A 0.2, B 0.8 smooth 1 bar'), {
      from: new R(3, 2),
      to: new R(7, 2),
    });
    assert.equal(q.automation!.at('lead', 'cutoff', new R(3, 2)), 0.5);
  }
});

test('section labels override base names, repeats follow form edits, and wildcard covers other sections', () => {
  const s = score('by section: A 0.2, ending 0.9, * 0.8').replace(
    'form = A B A',
    'form = A B A as ending',
  );
  const x = r(s);
  assert.deepEqual(
    [0, 1, 3].map((t) => x.automation!.at('lead', 'cutoff', new R(t))),
    [0.2, 0.8, 0.9],
  );
  const y = r(s.replace('form = A B A as ending', 'form = B A A as ending'));
  assert.deepEqual(
    [0, 2, 3].map((t) => y.automation!.at('lead', 'cutoff', new R(t))),
    [0.8, 0.2, 0.9],
  );
  const short = r(
    score('by section: A 0.2, B 0.8')
      .replace('  tempo 240', '  tempo 240\n  meter 6/8')
      .replace('rest(2 bars)', 'rest(1/2)'),
  );
  assert.equal(short.automation!.at('lead', 'cutoff', new R(3, 4)), 0.8);
  assert.equal(short.automation!.at('lead', 'cutoff', new R(5, 4)), 0.2);
});

test('interrupted smoothing is continuous, keeps unchanged targets and holds its end value', () => {
  const keyed = r(
    score('by section: A 0.2, B 0.8 smooth 2 bars').replace('rest(2 bars)', 'rest(1 bar)'),
  );
  const explicit = r(
    score('per song 1 bar smooth: 0.2, 0.2, 0.5, 0.35, 0.35').replace(
      'rest(2 bars)',
      'rest(1 bar)',
    ),
  );
  assert.deepEqual(points(keyed), points(explicit));
  assert.equal(keyed.automation!.at('lead', 'cutoff', new R(5, 2)), 0.425);
  const shared = r(
    score('by section: A 0.2, B 0.8 smooth 2 bars').replace('form = A B A', 'form = A B B'),
  );
  assert.equal(shared.automation!.at('lead', 'cutoff', new R(3)), 0.8);
});

test('bindings and value functions normalize before section lane compilation', () => {
  const x = r(score('choose(20%)', 'define choose(v: percent) = by section: A v, B 0.8\n'));
  assert.equal(x.automation!.at('lead', 'cutoff', new R(1)), 0.8);
  const y = r(score('by section: A base, B pow(2, -1)', 'signal base = 0.2\n'));
  assert.equal(y.automation!.at('lead', 'cutoff', new R(1)), 0.5);
  const text = 'by section: A 0.2, * 0.8 smooth 1 bar';
  const parsed = parseExpression(text);
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(expressionText(parsed.expression!), text);
});

test('song-clock lanes ignore part restarts while ordinary per retains its old reset clock', () => {
  const ordinary = r(score('per 1 bar: 0.2, 0.8'));
  const song = r(score('per song 1 bar: 0.2, 0.8'));
  assert.equal(ordinary.automation!.at('lead', 'cutoff', new R(1)), 0.2);
  assert.equal(song.automation!.at('lead', 'cutoff', new R(1)), 0.8);
  const keyed = r(
    score('by section: A 0.2, B 0.8').replace(
      '  plays notes',
      '  when in B:\n    restart on entry\n  plays notes',
    ),
  );
  assert.equal(keyed.automation!.at('lead', 'cutoff', new R(2)), 0.8);
});

test('invalid section lanes diagnose duplicates, gaps, typos, smoothing and resource limits', () => {
  for (const [value, expected] of [
    ['by section: A 0.2', /No section lane value for B/],
    ['by section: A 0.2, A 0.8, * 0.4', /Duplicate section selector/],
    ['by section: typo 0.2, * 0.4', /Unknown section selector/],
    ['by section: * 0.2 smooth 0 bars', /smoothing must be positive/],
    ['by section: * 0.2 smooth -1 bar', /smoothing must be positive/],
    ['by section: * 0.2 smooth 1/999999', /65536/],
    ['by section: * (across 1 bar: ramp 0..1)', /constant/],
  ] as const) {
    const x = realize(score(value));
    assert.ok(x.summary.errors, value);
    assert.ok(
      x.diagnostics.some((d) => expected.test(d.message)),
      JSON.stringify(x.diagnostics),
    );
  }
});

test('software-native section values lower before compilation and yield identical audio', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-sections-'));
  try {
    const native =
      header +
      'fx\n  bus space = delay time 1/16, feedback 20%\nbus space\n  delay.feedback = by section: A 20%, B 60% smooth 1 bar\npart lead\n  sound init\n  range C0..C9\n  insert = eq gain 0dB\n  insert.eq.gain = by section: A -6dB, B 6dB smooth 1 bar\n  attack = by section: A 10ms, B note(1/8)\n  send.space = 0.3\n  plays notes | C4 E4 . . |\n';
    const p = prepareSoftwareScore(native);
    assert.doesNotMatch(p.coreSource, /-6dB|10ms|note\(/);
    const explicit = native
      .replace(
        'by section: A 20%, B 60% smooth 1 bar',
        'per song 1 bar smooth: 0.2, 0.2, 0.6, 0.6, 0.2, 0.2',
      )
      .replace(
        'by section: A -6dB, B 6dB smooth 1 bar',
        'per song 1 bar smooth: 0.375, 0.375, 0.625, 0.625, 0.375, 0.375',
      )
      .replace(
        'by section: A 10ms, B note(1/8)',
        `per song 1 bar: ${[0.01, 0.125, 0.125, 0.01, 0.01, 0.01].map((s) => Math.cbrt((s - 0.001) / 5)).join(', ')}`,
      );
    renderSong(native, 'section.mm', { out: join(dir, 'keyed.wav'), tail: 0.1 });
    renderSong(explicit, 'section.mm', { out: join(dir, 'explicit.wav'), tail: 0.1 });
    assert.deepEqual(readFileSync(join(dir, 'keyed.wav')), readFileSync(join(dir, 'explicit.wav')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('section selector names stay literal inside value functions', () => {
  const x = r(score('choose(30%)', 'define choose(A: percent) = by section: A A, B 0.8\n'));
  assert.equal(x.automation!.at('lead', 'cutoff', new R(0)), 0.3);
});
test('song-clock rate lanes preserve boundaries through section-entry resets', () => {
  const base =
    header +
    'part lead\n  sound init\n  range C0..C9\n  restart on entry\n  plays notes (| C4 . . . |).fast(VALUE)\n';
  const keyed = r(base.replace('VALUE', 'by section: A 1, B 2'));
  const explicit = r(base.replace('VALUE', 'per song 1 bar: 1, 2, 2, 1, 1, 1'));
  assert.deepEqual(events(keyed), events(explicit));
});
test('native section mapping distinguishes a section named smooth from the smoothing modifier', () => {
  const s =
    header
      .replaceAll('section A', 'section smooth')
      .replace('form = A B A', 'form = smooth B smooth') +
    'part lead\n  insert = eq\n  insert.eq.gain = by section: B -3dB, smooth 3dB smooth 1 bar\n  plays notes | C4 . . . |\n';
  const p = prepareSoftwareScore(s);
  const x = realize(p.coreSource, { parameterDomains: p.domains });
  assert.equal(x.summary.errors, 0, JSON.stringify(x.diagnostics));
});

test('short section grids select the same fast renderer sampling rate as explicit lanes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-fast-sections-'));
  try {
    const s =
      'mm 1\nsong "Fast sections"\n  tempo 240\n  humanize off\nsection A = rest(1/64)\nsection B = rest(3/64)\nform = A B A\npart lead\n  sound init\n  cutoff = VALUE\n  plays notes | C4 . . . |\n';
    const values = [
      'by section: A 0.2, B 0.8 smooth 1/64',
      'per song 1/64 smooth: 0.2,0.2,0.8,0.8,0.8,0.2,0.2',
    ];
    for (const [i, value] of values.entries()) {
      const p = prepareSoftwareScore(s.replace('VALUE', value));
      const x = realize(p.coreSource, { parameterDomains: p.domains });
      assert.equal(x.summary.errors, 0, JSON.stringify(x.diagnostics));
      assert.equal(fastShapeControl(x, 'lead', 'cutoff', 240), true);
      renderSong(s.replace('VALUE', value), 'fast.mm', { out: join(dir, `${i}.wav`), tail: 0.1 });
    }
    assert.deepEqual(readFileSync(join(dir, '0.wav')), readFileSync(join(dir, '1.wav')));
    for (const value of values) {
      const aliased = s
        .replace('part lead', `signal lane = ${value}\npart lead`)
        .replace('VALUE', 'lane');
      const p = prepareSoftwareScore(aliased);
      const x = realize(p.coreSource, { parameterDomains: p.domains });
      assert.equal(x.summary.errors, 0, JSON.stringify(x.diagnostics));
      assert.equal(fastShapeControl(x, 'lead', 'cutoff', 240), true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('section-dependent controls require a form while unused function libraries remain checkable', () => {
  const x = realize('mm 1\npart lead\n  cutoff = by section: * 0.5\n');
  assert.ok(x.diagnostics.some((d) => /resolved song form/.test(d.message)));
  const y = realize('mm 1\ndefine control(v: percent) = by section: * v\n');
  assert.equal(y.summary.errors, 0, JSON.stringify(y.diagnostics));
});

test('parser feature metadata avoids lowering old scores and tracks expanded templates', () => {
  const old = parse(score('0.3'));
  assert.equal(old.hasSectionLanes, undefined);
  const templated = parse(
    header +
      'template control():\n  cutoff = by section: * 0.3\n  plays notes | C4 . . . |\npart lead = control()\n',
  );
  assert.equal(templated.hasSectionLanes, true);
});
