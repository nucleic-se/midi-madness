import type { Field, Expression } from './ast.ts';
import type { PartIR, Structure } from './ir.ts';
import type { PartRegion } from './parts.ts';
import type { Resolution } from './resolve.ts';
import { expandSequence } from './expand.ts';
import { argumentText, expressionText } from './source.ts';
import { parseDuration } from './literals.ts';
import { sectionAt } from './structure.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import { perData } from './constants.ts';
import type { createSignalSampler } from './signals.ts';
const zero = new R(0);
function expression(field: Field): Expression | undefined {
  return field.value.kind === 'sequence'
    ? field.value.elements.length === 1
      ? field.value.elements[0]
      : { kind: 'group', value: field.value, span: field.span }
    : undefined;
}
export function automation(
  structure: Structure,
  parts: PartIR[],
  regions: Map<string, PartRegion[]>,
  sampler: ReturnType<typeof createSignalSampler>,
) {
  function at(part: string, name: string, time: R): number | undefined {
    const t = time.compare(zero) < 0 ? zero : time,
      region = regions.get(part)?.find((r) => t.compare(r.start) >= 0 && t.compare(r.end) < 0),
      field = region?.fields.get(name),
      e = field ? expression(field) : undefined;
    return e && region ? sampler.sample(e, t, { ...region, part }) : undefined;
  }
  function boundaries(part: string, name: string): R[] {
    const times: R[] = [zero, structure.extent],
      partRegions = regions.get(part) ?? [];
    function walk(e: Expression, region: PartRegion) {
      if (e.kind === 'call' && e.name === '__per') {
        try {
          const step = perData(e, structure.settings.meter).step;
          const origin = e.clock === 'song' ? zero : region.reset;
          let t = origin.add(step.mul(new R(region.start.sub(origin).div(step).floor())));
          for (let guard = 0; t.compare(region.end) <= 0 && guard < 65536; guard++, t = t.add(step))
            times.push(t);
        } catch {
          /* The signal sampler reports invalid spans. */
        }
        return;
      }
      if (e.kind === 'binary') {
        walk(e.left, region);
        walk(e.right, region);
        return;
      }
      if (e.kind === 'group') {
        let offset = zero;
        const section = sectionAt(structure, region.start);
        for (const child of e.value.elements) {
          walk(child, { ...region, reset: region.reset.add(offset) });
          const value = expandSequence(
            { kind: 'sequence', elements: [child], span: child.span },
            'values',
            { meter: structure.settings.meter, section: section?.extent, phrase: section?.extent },
          ).value;
          if (value) offset = offset.add(value.extent);
        }
        return;
      }
      if (e.kind === 'call' && e.name === 'trigger') {
        const source = argumentText(e.args[0]).replace(/[()]/g, '').trim(),
          text = e.args.slice(1).map(argumentText).join(', '),
          envelope = text.match(/(?:attack ([\d/.]+) )?decay ([\d/.]+)/),
          durations: R[] = [zero];
        if (envelope) {
          const attack = envelope[1] ? parseDuration(envelope[1]) : zero;
          durations.push(attack, attack.add(parseDuration(envelope[2])));
        }
        for (const point of text.matchAll(/at ([\d/.]+)/g)) durations.push(parseDuration(point[1]));
        for (const ev of parts.find((p) => p.name === source)?.events ?? [])
          for (const duration of durations) times.push(ev.nominalOnset.add(duration));
        return;
      }
      if (e.kind === 'call') {
        for (const a of e.args)
          if (a.kind === 'sequence') a.elements.forEach((e) => walk(e, region));
        return;
      }
      if (e.kind === 'name' || e.kind === 'number' || e.kind === 'range' || e.kind === 'span')
        return;
      const section = sectionAt(structure, region.start),
        phrase = structure.material.units.find(
          (u) =>
            u.kind === 'phrase' &&
            region.start.compare(u.onset) >= 0 &&
            region.start.compare(u.onset.add(u.extent)) < 0,
        ),
        value = expandSequence({ kind: 'sequence', elements: [e], span: e.span }, 'values', {
          meter: structure.settings.meter,
          section: section?.extent,
          phrase: phrase?.extent ?? section?.extent,
        }).value;
      if (!value || value.extent.compare(zero) <= 0) return;
      const text = expressionText(e),
        origin = text.includes('across section')
          ? region.sectionStart
          : text.includes('across phrase')
            ? region.phraseStart
            : region.reset;
      let start = origin.add(
        value.extent.mul(new R(region.start.sub(origin).div(value.extent).floor())),
      );
      for (
        let count = 0;
        start.compare(region.end) <= 0 && count < 65536;
        count++, start = start.add(value.extent)
      ) {
        times.push(start, start.add(value.extent));
        for (const ev of value.events)
          times.push(start.add(ev.onset), start.add(ev.onset).add(ev.writtenSpan));
        for (const shape of value.shapes) {
          if (shape.name === 'square' || shape.name === 'triangle')
            times.push(start.add(shape.onset).add(shape.period.div(new R(2))));
          if (shape.every)
            for (let t = zero; t.compare(shape.period) < 0; t = t.add(shape.every))
              times.push(start.add(shape.onset).add(t));
        }
      }
    }
    for (const region of partRegions) {
      times.push(region.start, region.end);
      const field = region.fields.get(name),
        e = field ? expression(field) : undefined;
      if (e) walk(e, region);
    }
    return times
      .filter((t) => t.compare(zero) >= 0 && t.compare(structure.extent) <= 0)
      .sort((a, b) => a.compare(b))
      .filter((t, i, a) => !i || !t.equals(a[i - 1]));
  }
  function regionStart(part: string, name: string, time: R): R | undefined {
    const list = regions.get(part) ?? [];
    let index = list.findIndex((r) => time.compare(r.start) >= 0 && time.compare(r.end) < 0);
    if (index < 0 || !list[index].fields.has(name)) return;
    const field = list[index].fields.get(name),
      reset = list[index].reset;
    while (
      index > 0 &&
      list[index - 1].fields.get(name) === field &&
      list[index - 1].reset.equals(reset)
    )
      index--;
    return list[index].start;
  }
  return { at, boundaries, regionStart };
}
