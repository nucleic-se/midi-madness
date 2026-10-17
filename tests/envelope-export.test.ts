import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSong } from '../packages/render/src/render.ts';
import { buffers, knobTime, renderMember } from '../packages/synth/src/engine.ts';
import { laneValue } from '../packages/synth/src/world.ts';

const sr = 48000;
const header = `mm 1\nsong "Envelopes"\n  tempo 120\n  humanize off\n  dynamics flat\n`;
function render(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-env-'));
  try {
    const file = join(dir, 'song.mm');
    writeFileSync(file, source);
    const result = renderSong(source, file, {
      out: join(dir, 'mix.wav'),
      tail: 2,
      noAnalysis: true,
    });
    const wav = readFileSync(result.destination);
    const left = new Float64Array((wav.length - 44) / 6);
    for (let i = 0; i < left.length; i++) left[i] = wav.readIntLE(44 + i * 6, 3) / 8388607;
    return { left, performance: JSON.parse(readFileSync(result.performancePath!, 'utf8')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const track = (performance: any, name: string) =>
  performance.tracks.find((t: any) => t.name === name);

test('exported amp and filter envelopes follow the synth envelope, including the release', () => {
  // attack 0, decay knob 0.4, sustain 0.5, release knob 0.3; gate = one beat (0.5 s).
  const { performance } = render(
    header +
      'section A = rest(2 bars)\nform = A\npart tone\n  sound init\n  attack = 0\n  decay = 0.4\n  sustain = 0.5\n  release = 0.3\n  filter.decay = 0.2\n  plays notes | C4 . . . | . . . . |\n',
  );
  const tone = track(performance, 'tone'),
    [record] = tone.envelopes;
  const on = tone.events.find((e: any) => e.type === 'on'),
    off = tone.events.find((e: any) => e.type === 'off');
  assert.equal(tone.envelopes.length, 1);
  assert.equal(record.on, on.sample);
  const d = knobTime(0.4),
    r = knobTime(0.3),
    attack = knobTime(0);
  const decayAt = (t: number) => 0.5 + 0.5 * Math.exp((-Math.log(100) * (t - attack)) / d);
  for (const t of [0.05, 0.15, 0.3, 0.45]) {
    const value = laneValue(record.amplitude, on.sample + t * sr);
    // The synth updates envelope coefficients at control rate, so the closed form is approximate.
    assert.ok(Math.abs(value - decayAt(t)) < 0.006, `decay at ${t}: ${value} vs ${decayAt(t)}`);
  }
  // The release starts exactly at the note-off sample.
  const atOff = laneValue(record.amplitude, off.sample);
  assert.ok(
    record.amplitude.some((p: any) => p.sample === off.sample),
    'release corner recorded',
  );
  for (const t of [0.02, 0.08]) {
    const value = laneValue(record.amplitude, off.sample + t * sr),
      expected = atOff * Math.exp((-Math.log(100) * t) / r);
    assert.ok(Math.abs(value - expected) < 0.003, `release at ${t}: ${value} vs ${expected}`);
  }
  // The voice ends when the release falls below the synth's silence threshold.
  assert.ok(laneValue(record.amplitude, record.end) < 0.0001);
  assert.ok(record.end > off.sample && record.end < off.sample + 3 * r * sr);
  // Filter envelope: decays to its sustain (0) with its own time.
  // 1 ms attack, then -40 dB per knobTime(0.2) = 41 ms: about 0.89 at 2 ms.
  const filterAt = Math.exp((-Math.log(100) * 0.001) / knobTime(0.2));
  assert.ok(Math.abs(laneValue(record.filter, on.sample + 0.002 * sr) - filterAt) < 0.02);
  assert.ok(laneValue(record.filter, on.sample + 3 * knobTime(0.2) * sr) < 0.001);
  assert.ok(record.amplitude.length < 80, `simplified: ${record.amplitude.length} points`);
});

test('voice stealing and legato hand-off end a record where the voice changed hands', () => {
  const { performance } = render(
    header +
      'section A = rest(1 bar)\nform = A\n' +
      'part poly\n  sound init\n  voices 2\n  attack = 0\n  sustain = 1\n  release = 0.6\n  plays notes | C4{length 1/1} E4{length 1/1} G4{length 1/1} . |\n' +
      'part mono\n  sound init\n  mono on\n  attack = 0.3\n  sustain = 1\n  plays notes | C4{length 1/2} E4{length 1/2} . . |\n',
  );
  const poly = track(performance, 'poly'),
    ons = poly.events.filter((e: any) => e.type === 'on');
  const first = poly.envelopes.find((r: any) => r.on === ons[0].sample);
  // Two voices: the third note takes the oldest voice, cutting the first note mid-sustain.
  assert.equal(first.end, ons[2].sample);
  assert.ok(laneValue(first.amplitude, first.end - 1) > 0.9, 'stolen while still sounding');
  const mono = track(performance, 'mono'),
    monoOns = mono.events.filter((e: any) => e.type === 'on');
  const [a, b] = mono.envelopes.sort((x: any, y: any) => x.on - y.on);
  // Legato: the second note continues the first note's envelope instead of re-attacking.
  assert.equal(a.end, monoOns[1].sample);
  assert.equal(b.on, monoOns[1].sample);
  assert.ok(Math.abs(b.amplitude[0].value - laneValue(a.amplitude, a.end)) < 0.01);
});

test('drum envelopes record retrigger cuts and open-hat chokes', () => {
  const { performance } = render(
    header +
      'section A = rest(1 bar)\nform = A\n' +
      'part kick\n  lane kick\n  plays hits | x x . . |\n' +
      'part open\n  lane openhat\n  plays hits | x . . . |\n' +
      'part hat\n  lane hat\n  plays hits | [. x . .] . . . |\n',
  );
  const kick = track(performance, 'kick');
  const [first, second] = kick.envelopes;
  // The second hit, one beat later, cuts the first (base decay 0.35 s, so still sounding).
  assert.equal(first.end, kick.hits[1].sample);
  const expected = Math.exp((-Math.log(100) * 0.5) / 0.35);
  assert.ok(Math.abs(laneValue(first.amplitude, first.end) - expected) < 0.002);
  assert.equal(laneValue(first.amplitude, first.on), 1);
  // Left alone, a hit ends after 3 × decay.
  assert.ok(Math.abs((second.end - second.on) / sr - 3 * 0.35) < 0.001);
  const open = track(performance, 'open'),
    hat = track(performance, 'hat');
  const choke = hat.hits[0].sample,
    [ring] = open.envelopes;
  // The open hat is at ~0.28 a sixteenth in, then the closed hat chokes it to 1/1000.
  assert.ok(laneValue(ring.amplitude, choke - envelopeGridSamples) > 0.2);
  assert.ok(laneValue(ring.amplitude, choke + envelopeGridSamples) < 0.001);
});
const envelopeGridSamples = 64;

test('exported amplitude tracks the rendered audio and recording leaves audio unchanged', () => {
  const { left, performance } = render(
    header +
      'section A = rest(1 bar)\nform = A\npart tone\n  sound init\n  osc1.wave = 0\n  attack = 0\n  decay = 0.35\n  sustain = 0.3\n  release = 0.35\n  reverb = 0\n  delay = 0\n  plays notes | C4{length 1/4} . . . |\n',
  );
  const tone = track(performance, 'tone'),
    [record] = tone.envelopes,
    origin = performance.audio.originSample;
  const peak = (sample: number) => {
    let p = 0;
    for (let i = sample - 92; i < sample + 92; i++) p = Math.max(p, Math.abs(left[i - origin]));
    return p;
  };
  // A pure sine at C4 (period 3.8 ms): the local peak is the voice amplitude.
  const reference =
    peak(record.on + 0.02 * sr) / laneValue(record.amplitude, record.on + 0.02 * sr);
  for (const t of [0.06, 0.12, 0.2, 0.3, 0.4]) {
    const s = record.on + t * sr;
    const ratio = peak(s) / (laneValue(record.amplitude, s) * reference);
    assert.ok(Math.abs(ratio - 1) < 0.03, `audio/envelope at ${t}: ${ratio}`);
  }
  // The sink only observes: rendering with and without it is bit-identical.
  const events = tone.events;
  const plain = buffers(sr),
    observed = buffers(sr);
  renderMember('tone', 'init', tone.mix, events, sr, 1, plain);
  renderMember('tone', 'init', tone.mix, events, sr, 1, observed, 0, { envelopes: [] });
  assert.deepEqual(observed.left, plain.left);
});
