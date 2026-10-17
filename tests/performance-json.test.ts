import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performanceJson } from '../packages/render/src/performance.ts';
import { Rational as R } from '@midi-madness/foundation/time';

test('performance JSON retains backend inputs and expanded event semantics without compiler syntax', () => {
  const span = { line: 10, col: 3, endLine: 10, endCol: 21, file: 'score.mm' };
  const syntax = { kind: 'literal', literalText: 'C4 '.repeat(10000), groups: [{ span }] };
  const source = {
    span,
    literal: span,
    slot: [1, 2],
    ratchet: 2,
    operationOrdinal: 4,
    literalText: syntax.literalText,
    callSites: [span],
    figureExtent: new R(3, 4),
  };
  const semantic = {
    id: 'lead/A/1',
    part: 'lead',
    nominalOnset: new R(1, 3),
    performedOnset: new R(337, 1000),
    gate: new R(1, 7),
    writtenSpan: new R(1, 4),
    pitch: 60.25,
    velocity: 0.8,
    locks: { pan: -0.3, cutoff: 0.8 },
    paths: [{ name: 'pitch', from: 0, to: 1200, duration: new R(1, 8), curve: 'linear' }],
    generator: { kind: 'grains', count: 8, scatter: 0.2 },
    grain: true,
    panOffset: 0.15,
    group: 'foreground',
    path: 'A/1',
  };
  const provenance = {
    source,
    operations: [{ name: 'repeat', args: [syntax], span }],
    override: { condition: syntax },
  };
  const frame = {
    name: 'A',
    onset: new R(0),
    extent: new R(1),
    source: span,
    expression: syntax,
    children: [],
  };
  const score = {
    title: 'Projection',
    tempo: new R(120),
    seed: '42',
    extent: new R(2),
    meter: [4, 4],
    sections: [{ ...frame, children: [frame] }],
    bars: [{ number: 1, onset: new R(0), span: new R(1), section: 'A' }],
    parts: [
      {
        name: 'lead',
        kind: 'notes',
        role: 'lead',
        events: [
          { ...semantic, provenance },
          { ...semantic, id: 'lead/A/2', performedOnset: new R(5, 4), provenance },
        ],
        controls: {
          pan: [
            { time: new R(0), value: -0.3 },
            { time: new R(1), value: null },
          ],
        },
        suppressions: [{ onset: new R(1, 2), reason: 'rest', source: span }],
      },
    ],
  };
  const backend = {
    format: 'midi-madness-performance',
    version: 1,
    audio: {
      sampleRate: 48000,
      originSample: 24000,
      scoreOffsetSample: 100,
      frames: 96000,
      channels: 2,
    },
    tracks: [
      {
        name: 'lead',
        events: [
          { type: 'set', sample: 0, name: 'pan', value: null },
          {
            type: 'on',
            sample: 16176,
            id: 'lead/A/1',
            pitch: 60.25,
            velocity: 0.8,
            paths: [{ name: 'pitch', from: 0, to: 1200, samples: 12000, curve: 'linear' }],
            locks: { cutoff: 0.8 },
          },
          { type: 'off', sample: 23033, id: 'lead/A/1' },
        ],
      },
      {
        name: 'hat',
        hits: [{ sample: 0, velocity: 0.9, locks: { pan: 0.2 } }],
        controls: [{ sample: 100, name: 'pan', value: null }],
        initialControls: { pan: 0.2 },
      },
    ],
    buses: [{ name: 'echo', stages: [{ id: 'echo', type: 'delay', params: { time: 0.25 } }] }],
    busControls: { echo: [{ sample: 0, stage: 'echo', field: 'feedback', value: 0.6 }] },
    hats: [0, 12000],
    settings: {
      cuts: [60000],
      space: { output: 'stereo' },
      presetOverrides: {},
      tuning: { kind: 'equal' },
    },
    seed: 12345678901234567890n,
  };
  const input = { ...backend, score };
  const json = (value: unknown) =>
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
  const before = json(input);
  const serialized = performanceJson(input);
  const { score: projected, ...actualBackend } = JSON.parse(serialized);
  assert.deepEqual(actualBackend, JSON.parse(json(backend)));
  assert.equal(projected.parts[0].events.length, 2);
  const { provenance: compact, ...actualSemantic } = projected.parts[0].events[0];
  assert.deepEqual(actualSemantic, JSON.parse(json(semantic)));
  assert.equal(actualSemantic.performedOnset, '337/1000');
  assert.equal(actualSemantic.gate, '1/7');
  const { literalText: _text, ...location } = source;
  assert.deepEqual(compact, { source: JSON.parse(json(location)) });
  assert.deepEqual(projected.parts[0].controls, JSON.parse(json(score.parts[0].controls)));
  assert.deepEqual(projected.parts[0].suppressions, JSON.parse(json(score.parts[0].suppressions)));
  assert.deepEqual(projected.bars, JSON.parse(json(score.bars)));
  assert.equal('expression' in projected.sections[0], false);
  assert.equal('expression' in projected.sections[0].children[0], false);
  assert.equal(serialized.includes('literalText'), false);
  assert.equal(serialized.includes('operations'), false);
  assert.equal(json(input), before);
  assert.equal(input.score.parts[0].events[0].provenance, provenance);
  assert.equal(input.score.sections[0].expression, syntax);
  assert.ok(serialized.length < before.length / 5);
});

test('streamed performance JSON is byte-identical to performanceJson', async () => {
  const { writePerformanceJson } = await import('../packages/render/src/performance.ts');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'perf-json-'));
  try {
    const cases: unknown[] = [
      {
        format: 'midi-madness-performance',
        version: 1,
        score: { sections: [], parts: [] },
        big: 12345678901234567890n,
        rational: new R(3, 8),
        odd: [NaN, Infinity, -0, undefined, () => 1, null, true, 'q"uote\n'],
        skip: undefined,
        fn: () => 2,
        empty: { a: [], b: {} },
        typed: new Float32Array([0.5, 1.25]),
        nested: [[1, [2, [3, { deep: 'x' }]]]],
        date: new Date(0),
        boxed: [new Number(4), new String('s'), new Boolean(false)],
        unicode: 'é ✓  ',
      },
      [],
      'plain',
      42,
      null,
    ];
    cases.forEach((value, i) => {
      const file = join(dir, `${i}.json`);
      writePerformanceJson(file, value);
      assert.equal(readFileSync(file, 'utf8'), performanceJson(value));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
