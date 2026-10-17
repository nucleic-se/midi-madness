import { automation } from './automation.ts';
import type { Expression, Field } from './ast.ts';
import { curveAt } from './curves.ts';
import { diagnostic, type Diagnostic } from './diag.ts';
import type { Structure } from './ir.ts';
import type { PartsResult, PartRegion } from './parts.ts';
import { generator } from './random.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import type { Resolution } from './resolve.ts';
import { createSignalSampler, parameterNames } from './signals.ts';
import { sequenceText } from './source.ts';
const zero = new R(0),
  step = new R(1, 16);
function expression(field: Field): Expression | undefined {
  return field.value.kind === 'sequence'
    ? field.value.elements.length === 1
      ? field.value.elements[0]
      : { kind: 'group', value: field.value, span: field.span }
    : undefined;
}
function word(field?: Field): string {
  return field?.value.kind === 'clause'
    ? field.value.tokens.join(' ')
    : field?.value.kind === 'sequence'
      ? sequenceText(field.value)
      : '';
}
export type ParameterDomains = Record<string, Record<string, readonly [number, number, string?]>>;
export function realizeControls(
  resolution: Resolution,
  structure: Structure,
  result: PartsResult,
  domains: ParameterDomains = {},
) {
  const sampler = createSignalSampler(resolution, structure, result.parts),
    diagnostics: Diagnostic[] = [];
  const checked = new Set<Field>();
  function validate(name: string, field: Field, partName: string) {
    if (checked.has(field)) return;
    checked.add(field);
    const e = expression(field);
    if (!e) return;
    if (
      name !== 'velocity' &&
      !parameterNames.has(name) &&
      !name.includes('.') &&
      !domains[partName]?.[name]
    ) {
      diagnostics.push(diagnostic('I003', `Unknown parameter ${name}`, field.span));
      return;
    }
    const configured = domains[partName]?.[name];
    const domain: readonly [number, number] = configured
        ? [configured[0], configured[1]]
        : ['pan', 'bend'].includes(name)
          ? [-1, 1]
          : [0, 1],
      range = sampler.range(e);
    if (range[0] < domain[0] || range[1] > domain[1])
      diagnostics.push(
        diagnostic(
          e.kind === 'number' ? 'R003' : 'P006',
          `Parameter ${name} can leave its domain${configured?.[2] ? `; ${configured[2]}` : ''}`,
          field.span,
          { severity: e.kind === 'number' ? 'error' : 'warning', measured: { range, domain } },
        ),
      );
  }
  for (const part of result.parts) {
    const regions = result.regions.get(part.name) ?? [];
    let attack = -1,
      lastTime: R | undefined;
    for (const event of part.events) {
      const config = result.eventFields.get(event.id)!;
      if (!lastTime?.equals(event.nominalOnset)) {
        attack++;
        lastTime = event.nominalOnset;
      }
      const v = config.fields.get('velocity'),
        ctx = { ...config, part: part.name, velocity: config.incomingVelocity, attack };
      let velocity = event.velocity;
      if (v) {
        validate('velocity', v, part.name);
        const e = expression(v);
        if (e) velocity = sampler.sample(e, event.nominalOnset, ctx) ?? velocity;
      }
      const dynamics = word(config.fields.get('dynamics')) || structure.settings.dynamics;
      if (dynamics === 'energy')
        velocity *=
          0.4 + (0.6 * (curveAt(resolution, structure, 'energy', event.nominalOnset) ?? 5)) / 9;
      event.velocity = Math.max(0, Math.min(1, velocity));
      event.provenance.stage2Velocity = config.incomingVelocity;
      const humanize = word(config.fields.get('humanize'));
      let milliseconds =
        humanize === 'off'
          ? zero
          : humanize.endsWith('ms')
            ? R.parse(humanize.slice(0, -2).trim())
            : structure.settings.humanizeMs;
      if (milliseconds.compare(zero) > 0) {
        const draw = generator([
          'mm2',
          structure.settings.seed,
          'humanize',
          part.name,
          event.path,
          event.nominalOnset.toString(),
          JSON.stringify(
            ((s: unknown) => {
              const source = s as {
                slot?: number[];
                ratchet?: number;
                operationOrdinal?: number;
              };
              return [source.slot, source.ratchet, source.operationOrdinal ?? 0];
            })(event.provenance.source),
          ),
        ])();
        const shift = R.parse(String(Math.round((draw * 2 - 1) * 1000000)))
          .div(new R(1000000))
          .mul(milliseconds)
          .mul(structure.settings.tempo)
          .div(new R(240000));
        event.performedOnset = event.performedOnset.add(shift);
      }
    }
    const names = new Set([
      ...regions.flatMap((r) => [...r.fields].filter(([, f]) => !!expression(f)).map(([n]) => n)),
      ...part.events.flatMap((e) => Object.keys(e.locks)),
    ]);
    for (const name of 'plays velocity group range role lane length octave voices order restart play swing humanize dynamics use sound'.split(
      ' ',
    ))
      names.delete(name);
    const times = [
      zero,
      ...regions.flatMap((r) => [r.start, r.end]),
      ...part.events.flatMap((e) => [e.nominalOnset, e.nominalOnset.add(e.gate)]),
      structure.extent,
    ];
    for (let t = zero; t.compare(structure.extent) < 0; t = t.add(step)) times.push(t);
    const ordered = times
      .filter((t) => t.compare(zero) >= 0 && t.compare(structure.extent) <= 0)
      .sort((a, b) => a.compare(b))
      .filter((t, i, a) => !i || !t.equals(a[i - 1]));
    for (const name of [...names].sort()) {
      const points: import('./ir.ts').Control[] = [];
      for (const time of ordered) {
        const region = regions.find((r) => time.compare(r.start) >= 0 && time.compare(r.end) < 0),
          field = region?.fields.get(name);
        let value: number | undefined,
          source = 'absent';
        if (field && region) {
          validate(name, field, part.name);
          const e = expression(field);
          if (e) {
            value = sampler.sample(e, time, { ...region, part: part.name });
            source = `expression:${field.span.line}`;
          }
        }
        const lock = part.events
          .filter(
            (e) =>
              e.locks[name] !== undefined &&
              time.compare(e.nominalOnset) >= 0 &&
              time.compare(e.nominalOnset.add(e.gate)) < 0,
          )
          .sort((a, b) => b.nominalOnset.compare(a.nominalOnset))[0];
        if (lock) {
          value = lock.locks[name];
          source = `lock:${lock.id}`;
          if (!parameterNames.has(name) && !name.includes('.') && !domains[part.name]?.[name])
            diagnostics.push(
              diagnostic('I003', `Unknown lock parameter ${name}`, resolution.ast.span),
            );
        }
        if (value !== undefined)
          value = Math.max(
            domains[part.name]?.[name]?.[0] ?? (['pan', 'bend'].includes(name) ? -1 : 0),
            Math.min(domains[part.name]?.[name]?.[1] ?? 1, value),
          );
        if (
          !points.length ||
          points.at(-1)!.value !== (value ?? null) ||
          points.at(-1)!.source !== source
        )
          points.push({ time, value: value ?? null, source });
      }
      part.controls[name] = points;
    }
  }
  for (const d of sampler.diagnostics) diagnostics.push(d);
  return {
    sampler,
    diagnostics,
    automation: automation(structure, result.parts, result.regions, sampler),
  };
}
