import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffers, renderMember, type SynthEvent } from '../packages/synth/src/engine.ts';
import { prepareSoftwareScore } from '../packages/render/src/score-settings.ts';
import { realize } from '../packages/core/src/index.ts';
import { renderSong } from '../packages/render/src/render.ts';
import { loadSoftwareSetup, softwareArticulation } from '../packages/render/src/setup.ts';

function audio(controls: [string, number][], patch = 'init') {
  const out = buffers(12000);
  const events: SynthEvent[] = controls.map(([name, value]) => ({
    sample: 0,
    type: 'set',
    name,
    value,
  }));
  events.push({ sample: 0, type: 'on', id: 'note', pitch: 60, velocity: 0.8 });
  const report = renderMember(
    'test',
    patch,
    { gain: 1, pan: -1, room: 0, echo: 0 },
    events,
    48000,
    1,
    out,
  );
  assert.deepEqual(report.ignored, []);
  assert.ok(out.left.every(Number.isFinite));
  return out.left;
}
const difference = (a: Float32Array, b: Float32Array) =>
  a.reduce((sum, x, i) => sum + Math.abs(x - b[i]), 0);

test('oscillator, filter and modulation controls actually change the existing voice', () => {
  const base = audio([]);
  for (const controls of [
    [
      ['osc2.level', 0.5],
      ['osc2.semitone', 7],
      ['osc2.fine', 12],
    ],
    [
      ['osc1.wave', 1],
      ['pw', 0.2],
    ],
    [
      ['fm.index', 2],
      ['fm.ratio', 2],
    ],
    [
      ['osc1.level', 0],
      ['osc2.level', 1],
      ['sync', 1],
      ['sync.ratio', 3.5],
    ],
    [['fold', 0.7]],
    [
      ['filter.type', 5],
      ['cutoff', 0.5],
    ],
    [
      ['filter.fm', 2],
      ['cutoff', 0.5],
    ],
    [
      ['keytrack', 2],
      ['osc1.fine', -40],
    ],
    [
      ['lfo.ratio', 2],
      ['lfo.cutoff', 2],
    ],
  ] as [string, number][][])
    assert.ok(difference(base, audio(controls)) > 1, String(controls));
  assert.ok(
    difference(
      audio([
        ['fm.index', 2],
        ['fm.ratio', 1],
      ]),
      audio([
        ['fm.index', 2],
        ['fm.ratio', 3],
      ]),
    ) > 1,
  );
  assert.ok(
    difference(
      audio([
        ['osc1.wave', 1],
        ['pw', 0.5],
      ]),
      audio([
        ['osc1.wave', 1],
        ['pw', 0.2],
      ]),
    ) > 1,
  );
});

test('note-triggered LFO retriggers at the note, with fade/slew bounded and finite', () => {
  const render = (start: number) => {
    const out = buffers(24000);
    renderMember(
      'test',
      'init',
      { gain: 1, pan: -1, room: 0, echo: 0 },
      [
        { sample: 0, type: 'set', name: 'lfo.hz', value: 7 },
        { sample: 0, type: 'set', name: 'lfo.trigger', value: 1 },
        { sample: 0, type: 'set', name: 'lfo.pitch', value: 500 },
        { sample: 0, type: 'set', name: 'lfo.phase', value: 0.25 },
        { sample: 0, type: 'set', name: 'lfo.slew', value: 0.003 },
        { sample: 0, type: 'set', name: 'lfo.delay', value: 0.01 },
        { sample: 0, type: 'set', name: 'lfo.fade', value: 0.03 },
        { sample: start, type: 'on', id: 'same', pitch: 60, velocity: 0.8 },
      ],
      48000,
      1,
      out,
    );
    return out.left.slice(start, start + 12000);
  };
  assert.ok(difference(render(0), render(4000)) < 0.01);
});

test('part configuration selects real poly voices and unison in check and render', () => {
  const dir = mkdtempSync(join(tmpdir(), 'band-instrument-'));
  try {
    const source = `mm 1
song "poly pluck"
  tempo 120
  humanize off
  dynamics flat
section A = rest(1 bar)
form = A
part arp
  sound saw-pluck
  mono off
  voices 8
  unison 4
  unison.spread = 18ct
  unison.width = 1
  osc2.level = 0.4
  osc2.semitone = 7st
  filter.type = notch
  lfo.trigger = note
  lfo.delay = 10ms
  plays notes | C4+E4+G4 _ _ _ |
`;
    const p = prepareSoftwareScore(source);
    const r = realize(p.coreSource, { parameterDomains: p.domains });
    assert.equal(r.summary.errors, 0, JSON.stringify(r.diagnostics));
    assert.deepEqual(p.presetOverrides.arp, { mono: false, voices: 8, unison: 4 });
    assert.deepEqual(
      softwareArticulation(r.song!.parts, loadSoftwareSetup(), p.sounds, p.presetOverrides),
      [],
    );
    const rendered = renderSong(source, 'poly.mm', { out: join(dir, 'mix.wav'), tail: 0.1 });
    assert.equal(rendered.report.members.arp.slides, 0);
    assert.deepEqual(rendered.report.members.arp.ignored, []);
    assert.ok(rendered.report.peak > 0 && Number.isFinite(rendered.report.peak));
    assert.throws(
      () => prepareSoftwareScore(source.replace('unison 4', 'unison 9')),
      /unison must/,
    );
    assert.throws(
      () =>
        renderSong(source.replace('saw-pluck', 'ks-pluck'), 'bad.mm', {
          out: join(dir, 'bad.wav'),
        }),
      /unison 1/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('per-note modulation locks stay with overlapping voices instead of moving the member', () => {
  const a: SynthEvent = {
    sample: 0,
    type: 'on',
    id: 'a',
    pitch: 60,
    velocity: 0.6,
    pan: -1,
    locks: {
      'fm.index': 2,
      fold: 0.2,
      pw: 0.3,
      'sync.ratio': 3,
      'filter.fm': 1,
      'modenv.fold': 0.3,
      'lfo.hz': 7,
      'lfo.trigger': 1,
      'lfo.pitch': 200,
      envamount: 0.2,
    },
  };
  const b: SynthEvent = {
    sample: 2000,
    type: 'on',
    id: 'b',
    pitch: 67,
    velocity: 0.6,
    pan: 1,
    locks: { 'lfo.hz': 11, 'lfo.trigger': 1, 'lfo.cutoff': 2, envamount: 0.8, 'filter.decay': 0.3 },
  };
  const render = (events: SynthEvent[]) => {
    const out = buffers(12000);
    renderMember('test', 'init', { gain: 1, pan: 0, room: 0, echo: 0 }, events, 48000, 1, out);
    return out;
  };
  const both = render([a, b]),
    left = render([a]),
    right = render([b]);
  assert.ok(difference(both.left, left.left) < 1e-4);
  assert.ok(difference(both.right, right.right) < 1e-4);
  for (const control of [
    [
      ['lfo2.hz', 13],
      ['lfo2.pitch', 400],
      ['lfo2.rateMod', 2],
      ['lfo.cutoff', 1],
    ],
    [
      ['modenv.pitch', 900],
      ['modenv.attack', 0.002],
      ['modenv.decay', 0.05],
    ],
    [
      ['lfo.hz', 11],
      ['lfo.pw', 0.2],
      ['osc1.wave', 1],
    ],
    [
      ['lfo.hz', 9],
      ['lfo.fm.index', 4],
    ],
    [
      ['lfo2.hz', 9],
      ['lfo2.fold', 0.8],
    ],
    [['modenv.fold', 0.8]],
    [['modenv.filter.fm', 3]],
    [
      ['osc2.level', 1],
      ['sync', 1],
      ['lfo.sync.ratio', 2],
    ],
    [
      ['osc1.wave', 1],
      ['modenv.pw', 0.4],
    ],
  ] as [string, number][][])
    assert.ok(difference(audio([]), audio(control)) > 1, String(control));
});

test('drum pitch, envelope, noise and LFO controls are audible and keep old defaults', async () => {
  const { renderDrum } = await import('../packages/synth/src/drums.ts');
  const render = (values: [string, number][]) => {
    const out = buffers(12000);
    const report = renderDrum(
      'tom-low',
      [{ sample: 0, velocity: 0.8, locks: {} }],
      values.map(([name, value]) => ({ sample: 0, name, value })),
      [],
      48000,
      1,
      out,
    );
    assert.deepEqual(report.ignored, []);
    assert.ok(out.left.every(Number.isFinite));
    return out.left;
  };
  const base = render([]);
  for (const values of [
    [['drum.pitch', 60]],
    [
      ['drum.pitch.depth', 24],
      ['drum.pitch.decay', 0.1],
    ],
    [['drum.pitch.decay', 0.3]],
    [['noise', 0.7]],
    [
      ['drum.lfo.hz', 17],
      ['drum.lfo.pitch', 12],
      ['drum.lfo.amp', 0.7],
    ],
  ] as [string, number][][])
    assert.ok(difference(base, render(values)) > 1);
  const source = readFileSync('tests/fixtures/render/instrument-params.mm', 'utf8');
  const p = prepareSoftwareScore(source);
  const r = realize(p.coreSource, {
    parameterDomains: p.domains,
    controlOnlyParts: new Set(Object.keys(p.busParts)),
  });
  assert.equal(r.summary.errors, 0, JSON.stringify(r.diagnostics));
});
