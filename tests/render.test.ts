import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSong } from '../packages/render/src/render.ts';
import { buffers, renderMember, type SynthEvent } from '../packages/synth/src/engine.ts';
import { memberMix } from '../packages/synth/src/presets.ts';

test('report-free solo renders invalidate previous full-mix provenance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'band-provenance-'));
  const source = `mm 1
song "Provenance"
  humanize off
section A = | C4 |
form = A
part lead
  plays melody
part bass
  plays melody
`;
  try {
    const out = join(dir, 'mix.wav');
    renderSong(source, 'provenance.mm', { out, tail: 0 });
    const full = readFileSync(out);
    assert.equal(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).fullRender, true);
    assert.ok(existsSync(join(dir, 'report.txt')));
    const solo = renderSong(source, 'provenance.mm', {
      out,
      tail: 0,
      solo: 'lead',
      noAnalysis: true,
    });
    assert.equal(solo.report.fullRender, false);
    assert.notDeepEqual(readFileSync(out), full);
    assert.equal(existsSync(join(dir, 'report.json')), false);
    assert.equal(existsSync(join(dir, 'report.txt')), false);
    // Repeated report-free rendering must also work without existing reports.
    renderSong(source, 'provenance.mm', { out, tail: 0, noAnalysis: true });
    assert.equal(existsSync(join(dir, 'report.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synth pitch and fractional just-intonation bends stay within 0.1 cent', () => {
  const sr = 48000;
  for (const [pitch, cents] of [
    [39, 0],
    [58, -31.17],
    [69, 1.955],
  ]) {
    const audio = buffers(sr);
    renderMember(
      'pitch',
      'init',
      { gain: 1, pan: -1, room: 0, echo: 0 },
      [
        { sample: 0, type: 'set', name: 'wave', value: 0 },
        { sample: 0, type: 'set', name: 'bend.range', value: 2 },
        { sample: 0, type: 'set', name: 'bend', value: cents / 200 },
        { sample: 0, type: 'on', id: 'pitch', pitch, velocity: 0.8 },
      ],
      sr,
      1,
      audio,
    );
    const crossings: number[] = [];
    for (let i = sr / 5; i < sr - 1; i++)
      if (audio.left[i] <= 0 && audio.left[i + 1] > 0)
        crossings.push(i - audio.left[i] / (audio.left[i + 1] - audio.left[i]));
    assert.ok(crossings.length > 20);
    const measured = ((crossings.length - 1) * sr) / (crossings.at(-1)! - crossings[0]);
    const expected = 440 * 2 ** ((pitch - 69 + cents / 100) / 12);
    const error = 1200 * Math.log2(measured / expected);
    assert.ok(Math.abs(error) < 0.1, `pitch ${pitch}, bend ${cents}ct: error ${error}ct`);
  }
});

test('legacy reverb and drum tone reach the software engine without ignored controls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'band-controls-'));
  try {
    const result = renderSong(
      `mm 1
song "Room and tone"
  tempo 120
  humanize off
section A = rest(1 bar)
form = A
part keys
  plays notes | C4 . . . |
  reverb = 0.6
part kick
  lane kick
  plays hits | x{tone 0.9} . . . |
  tone = 0.4
  reverb = 0.35
`,
      'controls.mm',
      { out: join(dir, 'mix.wav'), tail: 2 },
    );
    assert.deepEqual(result.report.members.keys.ignored, []);
    assert.deepEqual(result.report.members.kick.ignored, []);
    assert.ok(result.report.buses.room.peak > 0.0001);
    assert.ok(result.report.buses.room.tailSeconds > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('draft timeline retains opening rests and first kick at sample 192000', () => {
  const dir = mkdtempSync(join(tmpdir(), 'band-render-'));
  try {
    const result = renderSong(
      readFileSync('tests/fixtures/render/timeline.mm', 'utf8'),
      'timeline.mm',
      { out: join(dir, 'mix.wav') },
    );
    const wav = readFileSync(result.destination);
    let first = -1;
    for (let i = 44; i < wav.length; i += 6)
      if (wav.readIntLE(i, 3) || wav.readIntLE(i + 3, 3)) {
        first = (i - 44) / 6;
        break;
      }
    assert.equal(first, 192000);
    assert.ok(result.report.peak <= 0.950001);
    assert.deepEqual(result.report.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mono overlap survives an older note-off and renders deterministically', () => {
  const events: SynthEvent[] = [
    { sample: 0, type: 'on', id: 'a', pitch: 48, velocity: 0.8 },
    { sample: 12000, type: 'on', id: 'b', pitch: 55, velocity: 0.8 },
    { sample: 18000, type: 'off', id: 'a' },
    { sample: 36000, type: 'off', id: 'b' },
  ];
  const a = buffers(48000),
    b = buffers(48000);
  const report = renderMember('bass', 'round-bass', memberMix('bass'), events, 48000, 123, a);
  renderMember('bass', 'round-bass', memberMix('bass'), events, 48000, 123, b);
  assert.equal(report.slides, 1);
  assert.equal(report.retriggers, 1);
  assert.ok(a.left.subarray(20000, 30000).some((n) => Math.abs(n) > 0.001));
  assert.deepEqual(a.left, b.left);
  assert.deepEqual(a.right, b.right);
});

test('humanize cannot create mono slides, and cannot erase written slides', async () => {
  const { realize, Rational: R } = await import('../packages/core/src/index.ts');
  const { scheduleNotes } = await import('../packages/render/src/notes.ts');
  const { loadSoftwareSetup, softwareArticulation } =
    await import('../packages/render/src/setup.ts');
  const setup = loadSoftwareSetup();
  const source = `mm 1
song "Humanize articulation"
  tempo 120
  seed 17
  humanize 50ms
  dynamics flat
section A = rest(4 bars)
form = A
part lead
  plays notes | C4 D4 E4 G4 |
  length 100%
part counter
  plays notes | E5 G5 A5 C6 |
  length 100%
`;
  const song = realize(source).song!;
  const position = (t: InstanceType<typeof R>) =>
    Math.round((Number(t.numerator) / Number(t.denominator)) * 96000);
  for (const part of song.parts) {
    const events = scheduleNotes(part, true, position, 4800, 500000);
    events.sort((a, b) => a.sample - b.sample || (a.type === 'off' ? -1 : 1));
    const audio = buffers(500000);
    const p = part.name === 'lead' ? 'warm-lead' : 'soft-square';
    const report = renderMember(part.name, p, memberMix(part.name), events, 48000, 17, audio);
    assert.equal(report.slides, 0, part.name);
    assert.equal(report.retriggers, part.events.length, part.name);
  }
  assert.ok(softwareArticulation(song.parts, setup).every((p) => p.slides === 0));

  // Force jitter to pull a written overlap apart; it must still be legato.
  const part = song.parts[0];
  part.events = part.events.slice(0, 2);
  part.events[0].gate = new R(13, 50); // 0.26 whole notes; next attack at 0.25
  part.events[0].performedOnset = new R(-1, 100);
  part.events[1].performedOnset = new R(27, 100);
  const events = scheduleNotes(part, true, position, 4800, 96000);
  events.sort((a, b) => a.sample - b.sample || (a.type === 'off' ? -1 : 1));
  const report = renderMember(
    'lead',
    'warm-lead',
    memberMix('lead'),
    events,
    48000,
    17,
    buffers(96000),
  );
  assert.equal(report.slides, 1);
  assert.equal(report.retriggers, 1);
});

test('software modulation literals and high-rate shapes resolve without coarse-grid aliasing', async () => {
  const { prepareSoftwareScore } = await import('../packages/render/src/score-settings.ts');
  const { fastShapeControl } = await import('../packages/render/src/shape-rate.ts');
  const { realize } = await import('../packages/core/src/index.ts');
  const p = prepareSoftwareScore(readFileSync('tests/fixtures/render/modulation.mm', 'utf8'));
  const r = realize(p.coreSource, { parameterDomains: p.domains, attackLimit: 256 });
  assert.equal(r.summary.errors, 0);
  assert.equal(p.echo.width, 1);
  assert.ok(Math.abs(p.echo.time! - ((240 / 156) * 3) / 16) < 1e-12);
  assert.equal(fastShapeControl(r, 'lead', 'pan', 156), true);
  assert.ok(
    r.song!.parts[0].controls['lfo.rate'].some(
      (p) => p.value !== null && Math.abs(0.05 * 40000 ** p.value - 440) < 1e-6,
    ),
  );
  assert.ok(r.song!.parts[0].controls['bend.range'].some((p) => p.value === 24));
});

test('note pan is local to each overlapping voice and overrides member pan', () => {
  const a = buffers(24000),
    b = buffers(24000),
    together = buffers(24000);
  const left: SynthEvent[] = [
    { sample: 0, type: 'on', id: 'a', pitch: 48, velocity: 0.8, pan: -1 },
  ];
  const right: SynthEvent[] = [
    { sample: 0, type: 'on', id: 'b', pitch: 72, velocity: 0.8, pan: 1 },
  ];
  const mix = { gain: 1, pan: 0, room: 0, echo: 0 };
  renderMember('test', 'init', mix, left, 48000, 1, a);
  renderMember('test', 'init', mix, right, 48000, 1, b);
  renderMember('test', 'init', mix, [...left, ...right], 48000, 1, together);
  for (let i = 0; i < a.left.length; i++) {
    assert.ok(Math.abs(together.left[i] - a.left[i]) < 1e-6);
    assert.ok(Math.abs(together.right[i] - b.right[i]) < 1e-6);
  }
});

test('software accepts 128 attacks while the default studio density guard stays at 64', async () => {
  const { realize } = await import('../packages/core/src/index.ts');
  const source = `mm 1
song "Dense software"
  tempo 156
  humanize off
section A = rest(1 bar)
form = A
part seq
  plays notes steps 1/128: C4 D4
`;
  assert.ok(realize(source).diagnostics.some((d) => d.code === 'D001' && d.severity === 'error'));
  const software = realize(source, { attackLimit: 256, attackLimitSeverity: 'warning' });
  assert.equal(software.summary.errors, 0);
  assert.equal(software.song!.parts[0].events.length, 128);
});

test('ping-pong echo repeats alternate channels at the configured delay', async () => {
  const { effects } = await import('../packages/synth/src/effects.ts');
  const audio = buffers(6000);
  audio.echo[0] = 1;
  effects(audio, 48000, 120, { time: 0.02, width: 1, feedback: 0.5 });
  const energy = (data: Float32Array, from: number, to: number) =>
    data.subarray(from, to).reduce((s, v) => s + v * v, 0);
  assert.ok(energy(audio.left, 960, 1100) > 0.01);
  assert.ok(energy(audio.right, 960, 1100) < 1e-12);
  assert.ok(energy(audio.right, 1920, 2100) > 0.001);
  assert.ok(energy(audio.left, 1920, 2100) < 1e-12);
});

test('a note throw excludes overlapping voices, and pre-fader sends survive a muted member', async () => {
  const make = () => {
    const a = buffers(24000);
    a.buses = { dub: { left: new Float32Array(24000), right: new Float32Array(24000) } };
    return a;
  };
  const single = make(),
    combined = make();
  const note: SynthEvent = {
    sample: 0,
    type: 'on',
    id: 'throw',
    pitch: 48,
    velocity: 0.8,
    sends: { dub: 1 },
  };
  const mix = { gain: 1, pan: 0, room: 0, echo: 0 };
  renderMember('test', 'init', mix, [note], 48000, 73, single);
  renderMember(
    'test',
    'init',
    mix,
    [note, { sample: 0, type: 'on', id: 'dry', pitch: 72, velocity: 0.8 }],
    48000,
    73,
    combined,
  );
  assert.deepEqual(combined.buses!.dub.left, single.buses!.dub.left);
  assert.deepEqual(combined.buses!.dub.right, single.buses!.dub.right);
  const pre = make();
  renderMember(
    'test',
    'init',
    mix,
    [
      { sample: 0, type: 'set', name: 'level', value: 0 },
      { sample: 0, type: 'set', name: 'send.dub', value: 1 },
      { sample: 0, type: 'set', name: 'send.dub.pre', value: 1 },
      { sample: 0, type: 'on', id: 'note', pitch: 48, velocity: 0.8 },
    ],
    48000,
    73,
    pre,
  );
  assert.ok(pre.left.subarray(12000).every((v) => Math.abs(v) < 1e-9));
  assert.ok(pre.buses!.dub.left.subarray(12000).some((v) => Math.abs(v) > 0.01));
});

test('bus automation uses score regions and effect routing rejects cycles', async () => {
  const { prepareSoftwareScore } = await import('../packages/render/src/score-settings.ts');
  const { realize, Rational: R } = await import('../packages/core/src/index.ts');
  const p = prepareSoftwareScore(readFileSync('tests/fixtures/render/effects.mm', 'utf8'));
  const r = realize(p.coreSource, {
    parameterDomains: p.domains,
    controlOnlyParts: new Set(Object.keys(p.busParts)),
  });
  assert.equal(r.summary.errors, 0);
  assert.ok(r.song!.parts.filter((p) => p.kind === 'control').every((p) => p.events.length === 0));
  assert.ok(Math.abs(r.automation!.at('fxbus__dub', 'delay.feedback', new R(5))! - 0.725) < 1e-6);
  assert.equal(r.automation!.at('fxbus__hall', 'reverb.decay', new R(6)), 0.8);
  assert.throws(
    () =>
      prepareSoftwareScore('mm 1\nfx\n  bus a = delay -> send b 1\n  bus b = delay -> send a 1\n'),
    /cycle/,
  );
  assert.throws(
    () => prepareSoftwareScore('mm 1\nfx\n  bus a = delay -> send nowhere 1\n'),
    /unknown bus/,
  );
});

test('named buses are wet-only and downstream routing adds the expected extra delay', async () => {
  const { busBuffers, renderBuses, defaultStage } = {
    ...(await import('../packages/synth/src/buses.ts')),
    ...(await import('../packages/render/src/fx-score.ts')),
  };
  const a = defaultStage('delay'),
    b = defaultStage('delay');
  a.params.time = 0.02;
  a.params.feedback = 0;
  b.params.time = 0.01;
  b.params.feedback = 0;
  const buses = [
    { name: 'a', stages: [a], sends: [{ bus: 'b', gain: 1 }] },
    { name: 'b', stages: [b], sends: [] },
  ];
  const audio = buffers(4800);
  audio.buses = busBuffers(buses, 4800);
  audio.left[0] = 0.1;
  audio.buses.a.left[0] = 0.5;
  audio.buses.a.right[0] = 0.5;
  const result = renderBuses(audio, buses, {}, 48000, [], 0);
  assert.ok(Math.abs(audio.left[0] - 0.1) < 1e-7);
  assert.ok(audio.buses.a.left.subarray(0, 960).every((v) => v === 0));
  assert.ok(audio.buses.b.left.subarray(0, 1440).every((v) => v === 0));
  assert.ok(audio.buses.b.left[1440] > 0);
  assert.ok(result.peak <= 0.95);
});

test('a late echo is retained across a quiet gap after the form ends', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bus-tail-'));
  try {
    const source = `mm 1
song "Late throw"
  tempo 120
  humanize off
  dynamics flat
section A = rest(1 bar)
form = A
fx
  bus late = delay time 4s, feedback 0%
part keys
  plays notes | . . . C4{send.late 1} |
  reverb = 0
  delay = 0
`;
    const rendered = renderSong(source, 'late.mm', { out: join(dir, 'mix.wav') });
    assert.ok(rendered.report.durationSeconds > 5.7);
    const wav = readFileSync(rendered.destination);
    const start = 44 + Math.round(5.5 * 48000) * 6;
    assert.ok(wav.subarray(start, start + 4800 * 6).some((v) => v !== 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
