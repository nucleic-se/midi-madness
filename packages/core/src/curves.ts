import { interpolate } from '@midi-madness/foundation/curves';
import type { Resolution } from './resolve.ts';
import type { Structure } from './ir.ts';
import { sectionAt } from './structure.ts';
import { Rational as R } from '@midi-madness/foundation/time';
export function curveAt(
  resolution: Resolution,
  structure: Structure,
  name: string,
  time: R,
): number | undefined {
  const curve = resolution.ast.statements.find((s) => s.kind === 'curve' && s.name === name);
  if (curve?.kind !== 'curve') return name === 'energy' ? 5 : undefined;
  const across = curve.entries.find((e) => e.tokens[0] === 'across' && e.tokens[1] === 'song');
  if (across) {
    const values = across.tokens.slice(2).map(Number);
    if (!values.length) return undefined;
    const p =
        (Number(time.div(structure.extent).numerator) /
          Number(time.div(structure.extent).denominator)) *
        (values.length - 1),
      i = Math.max(0, Math.min(values.length - 1, Math.floor(p)));
    return interpolate(values[i], values[i + 1] ?? values[i], p - i);
  }
  const section = sectionAt(structure, time);
  if (!section) return undefined;
  const labels = structure.material.units
    .filter(
      (u) =>
        u.kind === 'label' && time.compare(u.onset) >= 0 && time.compare(u.onset.add(u.extent)) < 0,
    )
    .sort((a, b) => a.extent.compare(b.extent));
  const label = labels.find((label) => curve.entries.some((e) => e.tokens[0] === label.name));
  const matches = curve.entries.filter((e) =>
    [label?.name, section.name, section.sectionName, 'others'].includes(e.tokens[0]),
  );
  const priority = (name: string) =>
    name === label?.name ? 3 : name === section.name ? 2 : name === 'others' ? 0 : 1;
  matches.sort((a, b) => priority(a.tokens[0]) - priority(b.tokens[0]));
  const entry = matches.at(-1);
  if (!entry) return 5;
  const low = Number(entry.tokens[1]),
    range = entry.tokens.indexOf('..'),
    high = range >= 0 ? Number(entry.tokens[range + 1]) : low;
  const unit = label && entry.tokens[0] === label.name ? label : section;
  const ratio = time.sub(unit.onset).div(unit.extent);
  return interpolate(low, high, ratio.toNumber());
}
