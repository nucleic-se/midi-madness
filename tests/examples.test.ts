import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { check, realize, query, Rational as R } from '../packages/core/src/index.ts';
import { prepareSoftwareScore } from '../packages/render/src/score-settings.ts';
import { loadSoftwareSetup, bindSoftware } from '../packages/render/src/setup.ts';
import { validateInserts } from '../packages/render/src/inserts.ts';
import { validateSends } from '../packages/render/src/fx-score.ts';
for (const file of ['five_against_the_tide.mm']) {
  test(`example realization: ${file}`, () => {
    const result = check(
      readFileSync(new URL(`./fixtures/scores/${file}`, import.meta.url), 'utf8'),
    );
    assert.deepEqual(
      result.diagnostics.filter((d) => d.severity === 'error'),
      [],
    );
    assert(result.parts?.every((p) => p.events.length > 0));
    assert(result.ast.statements.some((s) => s.kind === 'form'));
    assert(result.ast.statements.some((s) => s.kind === 'part'));
    const source = readFileSync(new URL(`./fixtures/scores/${file}`, import.meta.url), 'utf8');
    for (const [from, to] of [
      [new R(1, 8), new R(3, 2)],
      [new R(8), new R(10)],
    ]) {
      const window = query(source, { from, to });
      for (const part of result.parts!) {
        assert.deepEqual(
          window.song!.parts.find((p) => p.name === part.name)!.events,
          part.events.filter(
            (e) => e.nominalOnset.compare(to) < 0 && e.nominalOnset.add(e.gate).compare(from) > 0,
          ),
        );
      }
    }
  });
}

for (const file of readdirSync(new URL('../examples/', import.meta.url))
  .filter((f) => f.endsWith('.mm'))
  .sort()) {
  test(`software example realization: ${file}`, () => {
    const prepared = prepareSoftwareScore(
      readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8'),
    );
    const result = realize(prepared.coreSource, {
      templateContext: prepared.templates,
      parameterDomains: prepared.domains,
      deferDeviceExpectations: true,
      attackLimit: 256,
      attackLimitSeverity: 'warning',
      controlOnlyParts: new Set(Object.keys(prepared.busParts)),
    });
    assert.deepEqual(
      result.diagnostics.filter((d) => d.severity === 'error'),
      [],
    );
    assert.ok(result.song);
    const software = loadSoftwareSetup();
    const parts = result.song.parts;
    validateInserts(parts, prepared.inserts);
    validateSends(parts, prepared.buses, prepared.busParts);
    for (const part of parts.filter((p) => !(p.name in prepared.busParts))) {
      assert.ok(part.events.length > 0, part.name);
      bindSoftware(software, part, prepared.sounds[part.name]);
    }
  });
}
