import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSoftwareScore } from '../packages/render/src/score-settings.ts';
import { realize } from '../packages/core/src/index.ts';
import { renderSong } from '../packages/render/src/render.ts';
import { buffers, renderMember, type SynthEvent } from '../packages/synth/src/engine.ts';
const score = (controls: string, notes: string) =>
  `mm 1\nsong "Boundary audit"\n  tempo 120\n  humanize off\n  dynamics flat\nsection A = rest(2 bars)\nform = A\npart lead\n  sound init\n  range C0..C9\n  reverb = 0\n  delay = 0\n${controls}\n  plays notes ${notes}\n`;
function stereo(wav: Buffer, a: number, b: number) {
  let l = 0,
    r = 0;
  for (let i = Math.round(a * 48000); i < Math.round(b * 48000); i++) {
    const at = 44 + i * 6;
    if (at + 6 > wav.length) break;
    l += wav.readIntLE(at, 3) ** 2;
    r += wav.readIntLE(at + 3, 3) ** 2;
  }
  return (r - l) / (r + l);
}
test('grain pan spread preserves member automation and explicit note pan instead of recentering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-grain-pan-'));
  try {
    const output = join(dir, 'mix.wav');
    const source = score(
      '  pan = per 1 bar smooth: -0.9, 0.9',
      '(across 2 bars: C4{grains 128, grain.size 30ms, grain.pan 0.02})',
    );
    renderSong(source, join(dir, 'song.mm'), { out: output, tail: 0, noAnalysis: true });
    const wav = readFileSync(output);
    assert.ok(stereo(wav, 0.2, 0.6) < -0.5);
    assert.ok(stereo(wav, 2.2, 2.6) > 0.5);
    const locked = score(
      '  pan = 0.9',
      '(across 2 bars: C4{pan -0.8, grains 128, grain.size 30ms, grain.pan 0.02})',
    );
    renderSong(locked, join(dir, 'song.mm'), { out: output, tail: 0, noAnalysis: true });
    assert.ok(stereo(readFileSync(output), 0.2, 1) < -0.9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('short grains retain propagation tails when distance delay exceeds their lifetime', () => {
  const out = buffers(24000),
    events: SynthEvent[] = [
      { type: 'set', sample: 0, name: 'space.dist', value: 30 },
      { type: 'on', sample: 0, id: 'grain', pitch: 60, velocity: 1, grainSamples: 1440 },
      { type: 'off', sample: 1440, id: 'grain' },
    ];
  renderMember('grain', 'init', { gain: 1, pan: 0, room: 0, echo: 0 }, events, 48000, 1, out, 0, {
    grainCapacity: 256,
    space: { output: 'stereo', distance: true, air: false },
  });
  const before = out.left.slice(0, 4000).reduce((s, v) => s + v * v, 0),
    arrival = out.left.slice(4100, 6000).reduce((s, v) => s + v * v, 0),
    after = out.left.slice(8000).reduce((s, v) => s + v * v, 0);
  assert.equal(before, 0);
  assert.ok(arrival > 1e-7, `delayed grain lost: ${arrival}`);
  assert.ok(after < 1e-10, `grain restarted after its window: ${after}`);
});
test('native path units follow destination dimensions and incompatible units diagnose', () => {
  const prepared = prepareSoftwareScore(
    score(
      '',
      '| C4{lfo2.cutoff 1oct -> 3oct over 1/4, modenv.attack 10ms -> 100ms over 1/4, lfo2.hz 2Hz -> 1kHz over 1/4, pitch 1st -> 1oct over 1/4} . . . |',
    ),
  );
  const result = realize(prepared.coreSource, { parameterDomains: prepared.domains });
  assert.equal(result.summary.errors, 0, JSON.stringify(result.diagnostics));
  const paths = result.parts![0].events[0].paths!;
  assert.deepEqual(
    paths.map((p) => [p.name, p.from, p.to]),
    [
      ['lfo2.cutoff', 1, 3],
      ['modenv.attack', 0.01, 0.1],
      ['lfo2.hz', 2, 1000],
      ['pitch', 100, 1200],
    ],
  );
  for (const bad of ['pan 10ms -> 20ms', 'lfo2.hz 1oct -> 2oct']) {
    const p = prepareSoftwareScore(score('', `| C4{${bad} over 1/4} . . . |`));
    assert.ok(realize(p.coreSource, { parameterDomains: p.domains }).summary.errors);
  }
});

test('absolute pitch paths validate geometric endpoints after resolving the starting note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-pitch-path-'));
  try {
    const source = score('', '| C4{pitch 100ct -> B3 over 1/4 curve exp} . . . |');
    assert.throws(
      () =>
        renderSong(source, join(dir, 'song.mm'), {
          out: join(dir, 'mix.wav'),
          tail: 0,
          noAnalysis: true,
        }),
      /positive after pitch resolution/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('varying native-unit controls stay equivalent to near-constant settings across domain boundaries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-control-domain-'));
  try {
    const fields: Record<string, number> = {
      'space.az': -60,
      'space.el': 30,
      'space.dist': 4,
      'lfo2.hz': 5,
      'lfo2.cutoff': -1.5,
      'modenv.cutoff': 2,
      'level.db': -9,
    };
    const header = (dynamic: boolean) =>
      Object.entries(fields)
        .map(
          ([name, value]) =>
            `  ${name} = ${dynamic ? `per 1 bar smooth: ${value}, ${value + 0.000001}` : value}`,
        )
        .join('\n');
    const output = join(dir, 'mix.wav');
    const render = (dynamic: boolean) => {
      const source = score(header(dynamic), '(across 2 bars: C4)').replace(
        '  dynamics flat',
        '  dynamics flat\n  space stereo\n  space distance inverse, air on',
      );
      renderSong(source, join(dir, 'song.mm'), {
        out: output,
        bars: '1',
        tail: 0,
        noAnalysis: true,
      });
      return readFileSync(output);
    };
    const fixed = render(false),
      varying = render(true);
    assert.equal(fixed.length, varying.length);
    let difference = 0;
    for (let offset = 44; offset + 3 <= fixed.length; offset += 3)
      difference += Math.abs(fixed.readIntLE(offset, 3) - varying.readIntLE(offset, 3)) / 8388607;
    assert.ok(
      difference / ((fixed.length - 44) / 3) < 0.00001,
      `native-unit automation changed scale: ${difference}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('absolute pitch paths accept accidental targets split by the lexer', () => {
  for (const target of ['D#5', 'Bb4', 'F#-1']) {
    const prepared = prepareSoftwareScore(score('', `| C4{pitch -> ${target} over 1/4} . . . |`));
    const result = realize(prepared.coreSource, { parameterDomains: prepared.domains });
    assert.ok(
      !result.diagnostics.some((d) => d.code === 'R003'),
      JSON.stringify(result.diagnostics),
    );
  }
});
