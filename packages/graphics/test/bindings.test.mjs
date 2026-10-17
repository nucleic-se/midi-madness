import test from 'node:test';
import assert from 'node:assert/strict';
import { StructureEngine } from '../dist/engine.js';
import { bindParameters } from '../dist/bindings.js';

test('graphics bindings share explicit sum/reset and descriptor validation', () => {
  const engine = new StructureEngine({}, { collections: {} });
  const frame = engine.frame(0);
  const a = { effect: 'heart', parameter: 'level', source: () => 0.4 };
  const descriptor = {
    id: JSON.stringify(['heart', 'level']),
    label: 'Level',
    unit: 'normalized',
    min: 0,
    max: 1,
    defaultValue: 0.5,
  };
  assert.throws(() => bindParameters(frame, [a, a]), /every writer/);
  assert.deepEqual(bindParameters(frame, [a], [descriptor]), { heart: { level: 0.4 } });
  const special = bindParameters(frame, [{ ...a, effect: '__proto__', parameter: '__proto__' }]);
  assert.equal(Object.getPrototypeOf(special), Object.prototype);
  assert.equal(Object.hasOwn(special, '__proto__'), true);
  assert.equal(special.__proto__.__proto__, 0.4);
  const summed = [a, { ...a, source: () => 0.2 }].map((b) => ({ ...b, combine: 'sum' }));
  assert.ok(Math.abs(bindParameters(frame, summed, [descriptor]).heart.level - 0.6) < 1e-12);
  assert.throws(
    () =>
      bindParameters(
        frame,
        summed.map((b) => ({ ...b, source: () => 0.8 })),
        [descriptor],
      ),
    /Summed/,
  );
  assert.equal(
    Object.keys(bindParameters(frame, [{ ...a, source: () => null }], [descriptor])).length,
    0,
  );
  assert.throws(() => bindParameters(frame, [{ ...a, source: () => NaN }]));
});

test('structure signals use the shared lane defaults, reset and backwards sampling', () => {
  const points = [
    { time: 1, value: 0 },
    { time: 3, value: 1 },
    { time: 5, value: null },
  ];
  const config = (interpolation) => ({
    data: 'points',
    time: (p) => p.time,
    value: (p) => p.value,
    interpolation,
  });
  const engine = new StructureEngine(
    { points },
    { collections: {}, signals: { linear: config('linear'), step: config('hold') } },
  );
  assert.deepEqual(engine.frame(0).signals, { linear: 0, step: null });
  assert.deepEqual(engine.frame(2).signals, { linear: 0.5, step: 0 });
  assert.deepEqual(engine.frame(5).signals, { linear: null, step: null });
  assert.deepEqual(engine.frame(2).signals, { linear: 0.5, step: 0 });
});
