import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realize, parseExpression } from '../packages/core/src/index.ts';
import { prepareSoftwareScore } from '../packages/render/src/score-settings.ts';
import { buffers, renderMember } from '../packages/synth/src/engine.ts';
import { renderDrum } from '../packages/synth/src/drums.ts';
import { busBuffers, renderBuses } from '../packages/synth/src/buses.ts';
import { defaultStage } from '../packages/render/src/fx-score.ts';
import { parseInsertStage } from '../packages/render/src/inserts.ts';

const header =
  'mm 1\nsong "Composer regression"\n  tempo 120\n  humanize off\n  dynamics flat\nsection S = rest(12 bars)\nform = S\n';

test('one leading rest in later bars remains a rest and preserves timing', () => {
  for (const first of ['.', '[. .]']) {
    const r = realize(
      header + `part lead\n  plays notes | G1 . . . | ${first} A1 . . |\n  range G1..A2\n`,
    );
    assert.equal(r.summary.errors, 0, JSON.stringify(r.diagnostics));
    assert.deepEqual(
      r.song!.parts[0].events.slice(0, 2).map((e) => [e.pitch, e.nominalOnset.toString()]),
      [
        [31, '0/1'],
        [33, '5/4'],
      ],
    );
  }
  assert.deepEqual(parseExpression('(| C4 |).reverse()').diagnostics, []);
});

test('rhythm silence and hit phrases sequence with their declared/inferred types', () => {
  for (const declaration of ['rhythm', 'phrase']) {
    const r = realize(
      header +
        `rhythm k = rest(8 bars)\nrhythm a = | x . . . |\n${declaration} b = k a a\npart kick\n  lane kick\n  plays hits b\n`,
    );
    assert.equal(r.summary.errors, 0, JSON.stringify(r.diagnostics));
    assert.equal(r.expanded.get('k')!.type, 'hits');
    assert.equal(r.expanded.get('b')!.type, 'hits');
    assert.equal(r.song!.parts[0].events[0].nominalOnset.toString(), '8/1');
  }
});

test('rational rate factors, falling shapes and inline tuplets parse and expand', () => {
  const fast = realize(header + 'motif a = (| C4 |).fast(6/5)\npart lead\n  plays notes a\n');
  assert.equal(fast.summary.errors, 0, JSON.stringify(fast.diagnostics));
  assert.equal(fast.expanded.get('a')!.extent.toString(), '5/6');
  const shape = parseExpression('sine 0.8..-0.8');
  assert.deepEqual(shape.diagnostics, []);
  assert.equal(shape.expression!.kind, 'shape');
  for (const material of ['| (across 1 beat: C5 E5 G5) . . . |', '(across 1 beat: C5 E5 G5)']) {
    const r = realize(header + `part lead\n  range C4..C6\n  plays notes ${material}\n`);
    assert.equal(r.summary.errors, 0, JSON.stringify(r.diagnostics));
    assert.deepEqual(
      r.song!.parts[0].events.slice(0, 3).map((e) => e.nominalOnset.toString()),
      ['0/1', '1/12', '1/6'],
    );
  }
});

test('software bus warnings explain normalized native domains', () => {
  const p = prepareSoftwareScore(
    header +
      'fx\n  bus hall = reverb decay 6s\nbus hall\n  reverb.decay = across section: ramp 6..14\npart lead\n  plays notes | C4 |\n',
  );
  const r = realize(p.coreSource, {
    parameterDomains: p.domains,
    controlOnlyParts: new Set(Object.keys(p.busParts)),
  });
  assert.match(
    r.diagnostics.find((d) => d.code === 'P006')!.message,
    /reverb.decay reads 0\.\.1, where 0 = 50 ms and 1 = 30 s; write 6s/,
  );
});

test('default echo remains finite at 120, 149 and exact 150 BPM', () => {
  const sr = 48000;
  for (const bpm of [120, 149, 150]) {
    const bus = { name: 'echo', stages: [defaultStage('delay', 'delay', bpm)], sends: [] };
    const audio = buffers(sr);
    audio.buses = busBuffers([bus], sr);
    audio.buses.echo.left[0] = 0.3;
    const r = renderBuses(audio, [bus], {}, sr, [], sr / 2);
    assert.ok(Number.isFinite(r.peak));
    assert.ok(audio.left.every(Number.isFinite));
    assert.ok(audio.right.every(Number.isFinite));
    assert.ok(r.peak > 0);
  }
});

test('reverb tail measurement survives a fading instrument input and return attenuation', () => {
  const sr = 48000;
  const bus = {
    name: 'room',
    stages: [parseInsertStage('reverb decay 3s', 120, false)],
    sends: [],
  };
  const audio = buffers(sr * 8);
  audio.buses = busBuffers([bus], sr * 8);
  for (let i = 0; i < sr * 6; i++)
    audio.buses.room.left[i] = 0.1 * Math.exp(-i / (sr * 0.5)) * Math.sin(i * 0.03);
  const r = renderBuses(
    audio,
    [bus],
    { room: [{ sample: 0, stage: '$bus', field: 'return', value: 0.1 }] },
    sr,
    [],
    sr,
  );
  assert.ok(r.reports.room.tailSeconds > 0.1, String(r.reports.room.tailSeconds));
  assert.ok(r.reports.room.tailSeconds < 4);
});

test('drum lanes can be boosted by 12dB without changing normalized level meaning', () => {
  const p = prepareSoftwareScore(
    header + 'part hats\n  lane hat\n  plays hits | x . . . |\n  level = +12dB\n',
  );
  const r = realize(p.coreSource, { parameterDomains: p.domains });
  assert.equal(r.summary.errors, 0);
  assert.equal(r.song!.parts[0].controls['level.db'][0].value, 12);
  const peak = (gain: number) => {
    const audio = buffers(4800);
    return renderDrum(
      'hat',
      [{ sample: 0, velocity: 0.8, locks: {} }],
      [{ sample: 0, name: 'level.db', value: gain }],
      [],
      48000,
      1,
      audio,
    ).peak;
  };
  assert.ok(Math.abs(peak(12) / peak(0) - 10 ** (12 / 20)) < 1e-5);
  assert.throws(() => prepareSoftwareScore(header + 'part hats\n  level = 13dB\n'), /Level must/);
});

test('init velocity affects both individual notes and multi-note stacks', () => {
  for (const pitches of [[60], [60, 64, 67]]) {
    const rms = (velocity: number) => {
      const audio = buffers(12000);
      renderMember(
        'test',
        'init',
        { gain: 1, pan: -1, room: 0, echo: 0 },
        pitches.map((pitch, i) => ({
          sample: 0,
          type: 'on' as const,
          id: String(i),
          pitch,
          velocity,
        })),
        48000,
        1,
        audio,
      );
      return Math.sqrt(audio.left.slice(4800).reduce((s, x) => s + x * x, 0) / 7200);
    };
    const differenceDb = 20 * Math.log10(rms(0.5) / rms(0.3));
    assert.ok(differenceDb > 5 && differenceDb < 7, `${pitches.length} notes: ${differenceDb}dB`);
  }
});
