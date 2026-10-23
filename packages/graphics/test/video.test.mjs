import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPianoRoll } from '../dist/video.js';

const document = {
  format: 'midi-madness-performance',
  version: 1,
  audio: { sampleRate: 1000, originSample: 2000, frames: 4000 },
  tracks: [
    {
      name: 'lead',
      events: [
        { type: 'on', sample: 0, id: 'held', pitch: 64, velocity: 1 },
        { type: 'off', sample: 4000, id: 'held' },
        { type: 'on', sample: 5000, id: 'next', pitch: 72, velocity: 0.8 },
        { type: 'off', sample: 5500, id: 'next' },
      ],
    },
    { name: 'kick', hits: [{ sample: 2000, velocity: 1 }] },
  ],
};

test('offline frames honor excerpt origins, held gates and drum hits, and seek without state', () => {
  const roll = createPianoRoll(document, { width: 320, height: 180, windowSeconds: 4 });
  assert.equal(roll.duration, 4);
  const zero = roll.frame(0);
  assert.equal(zero.length, 320 * 180 * 3);
  // Playhead = 64 + (320 - 64 - 12) / 4 = 125. Lead was held before the excerpt.
  const pixel = (image, x, y) => [...image.slice((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
  assert.deepEqual(pixel(zero, 122, 63), [83, 218, 226]);
  assert.deepEqual(pixel(zero, 128, 125), [181, 133, 255]);
  assert.notDeepEqual(pixel(roll.frame(0.3), 128, 125), [181, 133, 255]);
  assert.notDeepEqual(roll.frame(3), zero);
  assert.deepEqual(roll.frame(0), zero);
  assert.deepEqual(
    roll.frame(3),
    createPianoRoll(document, { width: 320, height: 180, windowSeconds: 4 }).frame(3),
  );
});

test('offline preset handles silence and rejects unsupported contracts and invalid dimensions', () => {
  const empty = { ...document, tracks: [] };
  assert.equal(createPianoRoll(empty, { width: 160, height: 120 }).frame(0).length, 57600);
  assert.throws(() => createPianoRoll({ ...document, version: 2 }), /Unsupported performance/);
  assert.throws(() => createPianoRoll(document, { width: 321 }), /dimensions/);
  assert.throws(() => createPianoRoll(document, { windowSeconds: 0 }), /window/);
  assert.throws(() => createPianoRoll(document).frame(NaN), /finite/);
});
