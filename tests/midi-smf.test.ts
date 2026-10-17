import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMidi } from 'midi-file';
import { readFileSync, readdirSync } from 'node:fs';
import { realize } from '../packages/core/src/index.ts';
import { prepareSoftwareScore } from '../packages/render/src/score-settings.ts';
import {
  implicitRig,
  parseInstrument,
  parseSetup,
  resolveRig,
  gm,
} from '../packages/midi/src/config.ts';
import { compileNotes } from '../packages/midi/src/notes.ts';
import { writeMidi } from '../packages/midi/src/smf.ts';
test('M06: independent decoder reads partial meter and complete note lifetimes', () => {
  const song = realize(
      'mm 1\nsong "Meter"\n  humanize off\nsection A = (| 1 |).loop(3 bars + 1/2 bar)\nsection B = | 3 |\nform = A B\npart lead\n  plays melody\n',
    ).song!,
    compiled = compileNotes(song, implicitRig(song.parts)),
    bytes = writeMidi(compiled),
    decoded = parseMidi(bytes);
  assert.equal(decoded.header.format, 1);
  assert.equal(decoded.header.ticksPerBeat, 960);
  assert.deepEqual(
    decoded.tracks[0]
      .filter((e) => e.type === 'timeSignature')
      .map((e) => [e.numerator, e.denominator]),
    [
      [4, 4],
      [2, 4],
      [4, 4],
    ],
  );
  const notes = decoded.tracks[1];
  assert.equal(notes.filter((e) => e.type === 'noteOn').length, compiled.notes.length);
  assert.equal(notes.filter((e) => e.type === 'noteOff').length, compiled.notes.length);
  assert.deepEqual(writeMidi(compiled), bytes);
});
test('all example songs encode and independently decode with explicit fixture mapping where needed', () => {
  for (const file of readdirSync('examples').filter((f) => f.endsWith('.mm'))) {
    const prepared = prepareSoftwareScore(readFileSync('examples/' + file, 'utf8'));
    const r = realize(prepared.coreSource, {
      templateContext: prepared.templates,
      parameterDomains: prepared.domains,
      deferDeviceExpectations: true,
      attackLimit: 256,
      attackLimitSeverity: 'warning',
      controlOnlyParts: new Set(Object.keys(prepared.busParts)),
    });
    assert.equal(r.summary.errors, 0, file);
    r.song!.parts = r.song!.parts.filter((p) => !(p.name in prepared.busParts));
    const melodic = parseInstrument('instrument tone\n  voices poly\n').instrument!;
    const drums = parseInstrument(
      'instrument drums\n  voices drums\n' +
        Object.entries({
          ...gm,
          boom: 36,
          brush: 38,
          cowbell: 56,
          noise: 39,
          zap: 78,
          'tom-high': 50,
          'tom-low': 45,
        })
          .map(([name, note]) => `  lane ${name} note:${note}`)
          .join('\n'),
    ).instrument!;
    // Full arrangements can exceed the fifteen pitched channels on one port.
    const ports = r.song!.parts.map((_, i) => `  port p${i} = "Offline ${i}"`).join('\n');
    const bindings = r
      .song!.parts.map((p, i) => {
        return `  ${p.name} = ${p.lane ? 'drums' : 'tone'} port:p${i} ch:${p.lane ? 10 : 1}`;
      })
      .join('\n');
    const actual = resolveRig(
      parseSetup(`setup fixture\n${ports}\n${bindings}\n`).setup!,
      { tone: melodic, drums },
      r.song!.parts,
    );
    const compiled = compileNotes(r.song!, actual);
    assert.deepEqual(
      compiled.diagnostics.filter((d) => d.severity === 'error'),
      [],
      file,
    );
    const bytes = writeMidi(compiled),
      decoded = parseMidi(bytes);
    assert.equal(
      decoded.tracks.flat().filter((e) => e.type === 'noteOn').length,
      compiled.notes.length,
      file,
    );
    assert.deepEqual(writeMidi(compiled), bytes);
  }
});
