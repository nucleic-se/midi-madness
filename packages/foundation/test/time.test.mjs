import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Rational,
  wholeNotesToBeats,
  beatsToWholeNotes,
  beatsPerBar,
  beatTimeline,
  mediaClock,
  createPlayback,
} from '../dist/time.js';

test('decimal project durations accumulate exactly without guessing fractions', () => {
  assert.deepEqual(beatTimeline([0.1, 0.2, 0.3]), { starts: [0, 0.1, 0.3], end: 0.6 });
  assert.deepEqual(beatTimeline([]), { starts: [], end: 0 });
  for (const value of [1e-7, -1.25e20, 5e-324, 1e308, 0.3333333333333333])
    assert.equal(Rational.fromNumber(value).toNumber(), value);
  assert.equal(Rational.fromNumber(1 / 3).equals(new Rational(1, 3)), false);
  assert.equal(new Rational(10n ** 400n, 3n * 10n ** 399n).toNumber(), 10 / 3);
  assert.throws(() => new Rational(10n ** 400n).toNumber(), /range/);
  for (const value of [NaN, Infinity, -Infinity]) assert.throws(() => Rational.fromNumber(value));
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => beatTimeline([1, value]));
});

test('whole-note score coordinates and quarter-note beats stay explicit in non-4/4', () => {
  assert.equal(wholeNotesToBeats(new Rational(3, 8)).toString(), '3/2');
  assert.equal(beatsToWholeNotes(new Rational(3, 2)).toString(), '3/8');
  assert.equal(beatsPerBar(7, 8).toString(), '7/2');
  assert.equal(beatsPerBar(3, 4).toString(), '3/1');
  for (const meter of [
    [0, 4],
    [4, 0],
    [1.5, 8],
    [Infinity, 4],
  ])
    assert.throws(() => beatsPerBar(...meter));
});

test('excerpt media origin retains signed score time and fractional sample coordinates', () => {
  const clock = mediaClock(
    { sampleRate: 48000, originSample: 96000, scoreOffsetSample: 24000 },
    120,
  );
  assert.equal(clock.secondsAtSample(72000), -0.5);
  assert.equal(clock.scoreBeatsAtSeconds(0), 3);
  assert.equal(clock.secondsAtScoreBeat(0), -1.5);
  assert.equal(clock.sampleAtSeconds(1 / 96000), 96000.5);
  for (const seconds of [-2, -0.5, 0, 1.25, 32]) {
    assert.equal(clock.secondsAtScoreBeat(clock.scoreBeatsAtSeconds(seconds)), seconds);
    assert.equal(clock.secondsAtSample(clock.sampleAtSeconds(seconds)), seconds);
  }
  assert.throws(() => clock.sampleAtSeconds(Infinity));
  assert.throws(() => clock.scoreBeatsAtSeconds(NaN));
  assert.throws(() => mediaClock({ sampleRate: 0, originSample: 0, scoreOffsetSample: 0 }, 120));
  assert.throws(() =>
    mediaClock({ sampleRate: 48000, originSample: 0.5, scoreOffsetSample: 0 }, 120),
  );
});

test('transport preserves historical tempo, cadence independence and stop origin', () => {
  let now = 0;
  const playback = createPlayback(() => now);
  playback.play();
  now = 500;
  playback.setTempo(60);
  now = 1500;
  assert.equal(playback.position(), 2);
  assert.equal(playback.secondsAt(1), 0.5);
  now = 1400;
  assert.equal(playback.position(), 2);
  now = 2000;
  playback.play();
  assert.equal(playback.position(), 2.5);
  playback.stop();
  assert.equal(playback.position(), 0);
  assert.equal(playback.secondsAt(1), 1);
  for (const fps of [30, 144]) {
    now = 0;
    const clock = createPlayback(() => now);
    clock.setTempo(121);
    clock.play();
    for (let i = 1; i < fps; i++) {
      now = (i * 1000) / fps;
      clock.position();
    }
    now = clock.secondsAt(272) * 1000;
    assert.ok(Math.abs(clock.position() - 272) < 1e-12);
  }
});
