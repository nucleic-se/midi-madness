import { diagnostic, type Diagnostic } from './diag.ts';
import type { PartIR, Structure } from './ir.ts';
import { durationNumber } from './literals.ts';
import { resolvePitch } from './pitch.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import type { Resolution } from './resolve.ts';
export function checkExpectations(
  resolution: Resolution,
  structure: Structure,
  parts: PartIR[],
  options: { deferDevice?: boolean; deviceParts?: PartIR[]; onlyDevice?: boolean } = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [],
    bar = new R(...structure.settings.meter);
  const regions = (name: string) =>
    name === 'form'
      ? [{ onset: new R(0), extent: structure.extent, path: 'form' }]
      : [
          ...structure.sections.filter((s) => s.name === name || s.sectionName === name),
          ...structure.material.units
            .filter((u) => u.kind === 'label' && u.name === name)
            .map((u) => ({ ...u, path: `label/${name}` })),
        ];
  function duration(text: string): R {
    let sum = new R(0);
    for (const term of text.split(/\s*\+\s*/)) {
      const match = term.match(/^([\d/.]+)(?: (bars?|beats?))?$/);
      if (!match) throw new RangeError('Invalid expected duration');
      sum = sum.add(
        durationNumber(match[1]).mul(
          match[2]?.startsWith('bar') ? bar : match[2]?.startsWith('beat') ? new R(1, 4) : new R(1),
        ),
      );
    }
    return sum;
  }
  for (const statement of resolution.normalized.statements)
    if (statement.kind === 'expect') {
      const text = statement.value.tokens.join(' ').replace(/\s*\.\.\s*/g, '..');
      if (options.onlyDevice && !text.endsWith(' at device')) continue;
      const fail = (message: string, measured: Record<string, unknown>, path?: string) =>
        diagnostics.push(diagnostic('X001', message, statement.span, { measured, path }));
      const length = text.match(/^([\w-]+) length (.+)$/),
        presence = text.match(/^in ([\w-]+) : (.+)$/),
        range = text.match(/^([\w-]+) range(?: in ([\w-]+))? (.+?)( at device)?$/),
        density = text.match(/^([\w-]+) onsets per bar(?: in ([\w-]+))? between (\d+) and (\d+)$/);
      if (length) {
        const occurrences = regions(length[1]);
        if (!occurrences.length) fail('Expected region does not exist', { region: length[1] });
        for (const region of occurrences) {
          const expected = duration(length[2]);
          if (!region.extent.equals(expected))
            fail('Length expectation failed', { actual: region.extent, expected }, region.path);
        }
      } else if (presence) {
        if (!regions(presence[1]).length)
          fail('Expected region does not exist', { region: presence[1] });
        for (const region of regions(presence[1]))
          for (const name of presence[2].split(/\s*,\s*/)) {
            const absent = name.startsWith('no '),
              partName = absent ? name.slice(3) : name,
              count =
                parts
                  .find((p) => p.name === partName)
                  ?.events.filter(
                    (e) =>
                      e.nominalOnset.compare(region.onset) >= 0 &&
                      e.nominalOnset.compare(region.onset.add(region.extent)) < 0,
                  ).length ?? 0;
            if (absent ? count > 0 : count === 0)
              fail(
                'Part presence expectation failed',
                { part: partName, attacks: count, expected: absent ? 'none' : 'at least one' },
                region.path,
              );
          }
      } else if (range) {
        if (range[4] && !options.deviceParts) {
          if (options.deferDevice) continue;
          fail('Device expectations require a setup (M2)', { requires: '--setup' });
          continue;
        }
        const limits = range[3].replace(/\s/g, '').split('..'),
          low = limits[0] ? resolvePitch(limits[0]) : 0,
          high = limits[1] ? resolvePitch(limits[1]) : 127;
        for (const region of regions(range[2] ?? 'form')) {
          const pitches =
            (range[4] ? options.deviceParts! : parts)
              .find((p) => p.name === range[1])
              ?.events.filter(
                (e) =>
                  e.nominalOnset.compare(region.onset) >= 0 &&
                  e.nominalOnset.compare(region.onset.add(region.extent)) < 0,
              )
              .flatMap((e) => (e.pitch === null ? [] : [e.pitch])) ?? [];
          if (pitches.some((p) => p < low || p > high))
            fail(
              'Range expectation failed',
              { range: [Math.min(...pitches), Math.max(...pitches)], expected: [low, high] },
              region.path,
            );
        }
      } else if (density) {
        for (const region of regions(density[2] ?? 'form'))
          for (const b of structure.bars.filter(
            (b) =>
              b.onset.compare(region.onset) >= 0 &&
              b.onset.compare(region.onset.add(region.extent)) < 0,
          )) {
            const count = new Set(
              parts
                .find((p) => p.name === density[1])
                ?.events.filter(
                  (e) =>
                    e.nominalOnset.compare(b.onset) >= 0 &&
                    e.nominalOnset.compare(b.onset.add(b.span)) < 0,
                )
                .map((e) => e.nominalOnset.toString()),
            ).size;
            if (count < Number(density[3]) || count > Number(density[4]))
              fail(
                'Onset density expectation failed',
                {
                  onsets: count,
                  minimum: Number(density[3]),
                  maximum: Number(density[4]),
                  bar: b.number,
                },
                b.path,
              );
          }
      } else fail('Unsupported expectation syntax', { text });
    }
  return diagnostics;
}
