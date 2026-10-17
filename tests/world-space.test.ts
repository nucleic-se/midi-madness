import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSong } from '../packages/render/src/render.ts';
import { configuredPreset } from '../packages/synth/src/presets.ts';
import { drumLaneModel } from '../packages/synth/src/drums.ts';
import {
  LaneCursor,
  laneValue,
  listenerBasis,
  relativeToListener,
  simplifyLane,
  worldFromRelative,
  type LanePoint,
} from '../packages/synth/src/world.ts';

const header = (extra = '') =>
  `mm 1\nsong "World"\n  tempo 120\n  humanize off\n  dynamics flat\n${extra}`;
const sine = (name: string, fields: string, notes: string) =>
  `part ${name}\n  sound init\n  osc1.wave = 0\n  attack = 0\n  sustain = 1\n  release = 0\n  reverb = 0\n  delay = 0\n${fields}  plays notes ${notes}\n`;

function render(source: string, options: { tail?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-world-'));
  try {
    const file = join(dir, 'song.mm');
    writeFileSync(file, source);
    const result = renderSong(source, file, {
      out: join(dir, 'mix.wav'),
      tail: options.tail ?? 0,
      noAnalysis: true,
    });
    return {
      wav: readFileSync(result.destination),
      performance: JSON.parse(readFileSync(result.performancePath!, 'utf8')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function channels(wav: Buffer) {
  const frames = (wav.length - 44) / 6,
    left = new Float64Array(frames),
    right = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = wav.readIntLE(44 + i * 6, 3) / 8388607;
    right[i] = wav.readIntLE(47 + i * 6, 3) / 8388607;
  }
  return { left, right };
}
function power(wav: Buffer, from: number, to: number) {
  const { left, right } = channels(wav);
  let l = 0,
    r = 0;
  for (let i = Math.floor(from * 48000); i < Math.min(left.length, Math.floor(to * 48000)); i++) {
    l += left[i] ** 2;
    r += right[i] ** 2;
  }
  return { l, r, balance: (r - l) / (r + l), total: l + r };
}
function onset(wav: Buffer, threshold = 1e-4) {
  const { left, right } = channels(wav);
  return left.findIndex((v, i) => Math.abs(v) > threshold || Math.abs(right[i]) > threshold);
}

test('world-to-listener geometry preserves distance and inverts exactly', () => {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let n = 0; n < 200; n++) {
    const pose = {
      x: random() * 50,
      y: random() * 10,
      z: random() * 50,
      yaw: random() * 720,
      pitch: random() * 89,
    };
    const point: [number, number, number] = [random() * 40, random() * 20, random() * 40];
    const basis = listenerBasis(pose),
      audio = relativeToListener(...point, basis);
    const distance = Math.hypot(point[0] - pose.x, point[1] - pose.y, point[2] - pose.z);
    assert.ok(Math.abs(audio.distance - distance) < 1e-9);
    const back = worldFromRelative(audio.azimuth, audio.elevation, audio.distance, basis);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - point[i]) < 1e-9);
  }
  // Named directions: the default listener faces -z; +x is to the right; yaw 90 faces +x.
  const origin = listenerBasis({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  assert.equal(Math.round(relativeToListener(0, 0, -5, origin).azimuth), 0);
  assert.equal(Math.round(relativeToListener(5, 0, 0, origin).azimuth), 90);
  assert.equal(Math.round(relativeToListener(0, 5, 0, origin).elevation), 90);
  const east = listenerBasis({ x: 0, y: 0, z: 0, yaw: 90, pitch: 0 });
  assert.equal(Math.round(relativeToListener(5, 0, 0, east).azimuth), 0);
  const tilted = listenerBasis({ x: 0, y: 0, z: 0, yaw: 90, pitch: 30 });
  const ahead = relativeToListener(5, 0, 0, tilted);
  assert.ok(Math.abs(ahead.azimuth) < 1e-9);
  assert.ok(Math.abs(ahead.elevation + 30) < 1e-9);
});

test('lanes use default before, outgoing curve and hold after', () => {
  const lane: LanePoint[] = [
    { sample: 100, value: 2, curve: 'linear' },
    { sample: 200, value: 4, curve: 'step' },
    { sample: 300, value: -1, curve: 'linear' },
  ];
  const cursor = new LaneCursor(lane);
  const expectedSamples = [
    [0, 0],
    [99, 0],
    [100, 2],
    [150, 3],
    [199, 3.98],
    [200, 4],
    [250, 4],
    [299, 4],
    [300, -1],
    [1000, -1],
  ];
  for (const [sample, expected] of expectedSamples) {
    assert.equal(laneValue(lane, sample), expected, `sample ${sample}`);
    assert.equal(cursor.at(sample), expected, `cursor ${sample}`);
  }
  const ramp = Array.from({ length: 50 }, (_, i) => ({
    sample: i * 10,
    value: i * 0.5,
    curve: 'linear' as const,
  }));
  assert.deepEqual(
    simplifyLane(ramp, 1e-4).map((p) => p.sample),
    [0, 490],
  );
});

test('lane simplification never moves a removed point by more than the tolerance', () => {
  let seed = 3;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let n = 0; n < 50; n++) {
    // Envelope-like curves with jumps: decays, ramps, holds and steps.
    const points: LanePoint[] = [];
    let value = random();
    for (let i = 0; i < 400; i++) {
      value += random() * 0.02 + (i % 97 === 0 ? random() : 0) - value * 0.01;
      points.push({ sample: i * 64, value, curve: i % 131 === 0 ? 'step' : 'linear' });
    }
    const simple = simplifyLane(points, 0.001);
    for (const p of points) {
      const error = Math.abs(laneValue(simple, p.sample) - laneValue(points, p.sample));
      assert.ok(error <= 0.001 + 1e-12, `error ${error} at ${p.sample}`);
    }
    assert.ok(simple.length < points.length);
  }
});

test('world sources are placed relative to a turning listener', () => {
  const at = (yaw: number) =>
    render(
      header(`  space stereo\nlistener\n  yaw = ${yaw}\n`) +
        'section A = rest(1 bar)\nform = A\n' +
        sine('tone', '  space.x = 5\n', '| C4 _ _ _ |'),
    ).wav;
  // +x is right of the default listener, ahead when facing +x, and left when facing +z.
  assert.ok(power(at(0), 0.1, 1.5).balance > 0.9);
  assert.ok(Math.abs(power(at(90), 0.1, 1.5).balance) < 0.05);
  assert.ok(power(at(180), 0.1, 1.5).balance < -0.9);
});

test('listener motion alone changes distance, level and arrival time', () => {
  const walking = render(
    header(
      '  space stereo\n  space distance inverse, air off\nlistener\n  z = across 2 bars: ramp 2..20\n',
    ) +
      'section A = rest(2 bars)\nform = A\n' +
      sine('tone', '  space.z = 0\n', '(across 2 bars: C4)'),
  );
  const near = power(walking.wav, 0.2, 0.5).total,
    far = power(walking.wav, 3.4, 3.7).total;
  // Inverse distance: ~2.7 m vs ~18.5 m is roughly 47x in power.
  assert.ok(near / far > 25 && near / far < 80, `near/far ${near / far}`);
  const z = walking.performance.world.listener.z;
  assert.equal(z[0].sample, 0);
  assert.equal(z[0].value, 2);
  assert.ok(z.length <= 3, 'a linear ramp simplifies to its endpoints');

  const kick = (distance: number) =>
    onset(
      render(
        header('  space stereo\n  space distance inverse, air off\n') +
          'section A = rest(1 bar)\nform = A\n' +
          `part kick\n  lane kick\n  reverb = 0\n  space.z = ${-distance}\n  plays hits | x . . . |\n`,
        { tail: 0.5 },
      ).wav,
    );
  // 34.3 m is 100 ms of propagation; compare with 1 m to cancel the kick's own attack.
  const delay = (kick(34.3) - kick(1)) / 48000;
  assert.ok(Math.abs(delay - (34.3 - 1) / 343) < 0.001, `propagation ${delay}`);
});

test('world sources change level at the source; head-locked members keep a listener fader', () => {
  // A held tone 34.3 m away (100 ms) drops 12 dB at beat 2. Find when the drop is heard.
  const drop = (place: string) => {
    const { wav } = render(
      header('  space stereo\n  space distance inverse, air off\n') +
        'section A = rest(1 bar)\nform = A\n' +
        sine('tone', `${place}  level.db = | 0 -12 -12 -12 |\n`, '| C4 _ _ _ |'),
    );
    const { left, right } = channels(wav),
      beat = 24000;
    const level = (at: number) => {
      let peak = 0;
      for (let i = at - 120; i < at + 120; i++)
        peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
      return peak;
    };
    const before = level(beat - 2400);
    let i = beat - 1200;
    while (level(i) > before * 10 ** (-6 / 20)) i += 24;
    return (i - beat) / 48000;
  };
  const world = drop('  space.z = -34.3\n'),
    headLocked = drop('  space.az = 0\n  space.dist = 34.3\n');
  assert.ok(Math.abs(world - 0.1) < 0.006, `world level change heard after ${world} s`);
  assert.ok(Math.abs(headLocked) < 0.006, `head-locked fader heard after ${headLocked} s`);
});

test('listener-relative parts keep their old behaviour and are head-locked', () => {
  const body =
    'section A = rest(1 bar)\nform = A\n' +
    sine('tone', '  space.az = 60\n  space.dist = 3\n', '| C4 _ _ _ |');
  const plain = render(header('  space binaural\n') + body);
  const moving = render(
    header('  space binaural\nlistener\n  x = 8\n  yaw = across 1 bar: ramp 0..180\n') + body,
  );
  assert.ok(plain.wav.equals(moving.wav), 'listener motion must not move head-locked sources');
  const track = plain.performance.tracks.find((t: any) => t.name === 'tone');
  assert.deepEqual(track.space, { frame: 'listener' });
  assert.deepEqual(plain.performance.world.listener, {});
  assert.ok(track.events.some((e: any) => e.type === 'set' && e.name === 'space.az'));
});

test('a listener block with restart never keeps one path across sections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-path-'));
  try {
    writeFileSync(join(dir, 'path.json'), JSON.stringify({ z: [0, 1, 2, 3, 4, 5, 6, 7] }));
    const source =
      header(
        '  space stereo\nlistener\n  restart never\n  z = data "path.json" key z per 1 beat hold\n',
      ) +
      'section A = rest(1 bar)\nsection B = rest(1 bar)\nform = A B\n' +
      sine('tone', '  space.z = -5\n', '| C4 _ _ _ | C4 _ _ _ |');
    const file = join(dir, 'song.mm');
    writeFileSync(file, source);
    const result = renderSong(source, file, {
      out: join(dir, 'mix.wav'),
      tail: 0,
      noAnalysis: true,
    });
    const performance = JSON.parse(readFileSync(result.performancePath!, 'utf8'));
    const z = performance.world.listener.z,
      origin = performance.audio.scoreOffsetSample;
    // Beat 6 is in section B: the lane continues (6), it does not restart at 2.
    assert.equal(laneValue(z, origin + 6 * 24000 + 100), 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one part cannot mix world and listener-relative coordinates', () => {
  assert.throws(
    () =>
      render(
        header('  space stereo\n') +
          'section A = rest(1 bar)\nform = A\n' +
          sine('tone', '  space.x = 2\n', '| C4{space.az 30} . . . |'),
      ),
    /either world space\.x\/y\/z or listener-relative/,
  );
  assert.throws(
    () => render(header() + 'listener\n  roll = 3\nsection A = rest(1 bar)\nform = A\n'),
    /listener block accepts x, y, z, yaw and pitch/,
  );
});

test('export carries world lanes, listener lanes, per-note overrides and resolved presets', () => {
  const { performance } = render(
    header('  space binaural\nlistener\n  y = 1.7\n  z = 12\n  when in B:\n    z = 4\n') +
      'section A = rest(1 bar)\nsection B = rest(1 bar)\nform = A B\n' +
      sine('stone', '  space.x = 10\n', '| C4{space.y -2 -> 4 over 1/2} . . . |') +
      'part kick\n  lane kick\n  plays hits | x . x{space.x 3, drum.pitch.depth 24} . |\n',
  );
  assert.equal(performance.version, 1);
  assert.equal(performance.world.units, 'm');
  // The section change is a jump: a step point one sample before the boundary.
  const z = performance.world.listener.z;
  const jump = z.findIndex((p: any) => p.value === 4);
  assert.equal(z[jump - 1].curve, 'step');
  assert.equal(z[jump - 1].value, 12);
  assert.equal(z[jump].sample - z[jump - 1].sample, 1);
  assert.equal(z[jump].sample, performance.audio.scoreOffsetSample + 96000);

  const stone = performance.tracks.find((t: any) => t.name === 'stone');
  assert.equal(stone.space.frame, 'world');
  assert.deepEqual(stone.space.position.x, [{ sample: 0, value: 10, curve: 'step' }]);
  assert.ok(!stone.events.some((e: any) => e.type === 'set' && e.name.startsWith('space.')));
  const on = stone.events.find((e: any) => e.type === 'on');
  assert.deepEqual(
    on.paths.map((p: any) => [p.name, p.from, p.to]),
    [['space.y', -2, 4]],
  );
  assert.deepEqual(
    stone.resolved.preset,
    configuredPreset(stone.preset, {
      ...performance.settings.presetOverrides.stone,
    }),
  );
  assert.equal(
    stone.resolved.voiceCount,
    stone.resolved.preset.mono ? 1 : stone.resolved.preset.voices,
  );

  const kick = performance.tracks.find((t: any) => t.name === 'kick');
  assert.equal(kick.space.frame, 'world');
  assert.deepEqual(kick.space.position, {});
  assert.deepEqual(kick.resolved, drumLaneModel('kick'));
  assert.deepEqual(kick.hits[1].locks, { 'space.x': 3, 'drum.pitch.depth': 24 });
  assert.ok(!performance.tracks.some((t: any) => t.name.startsWith('fxbus__')));
});
