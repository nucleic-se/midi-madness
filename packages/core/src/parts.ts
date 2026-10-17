import type { Expression } from './ast.ts';
import { parseExpression } from './parser.ts';
import { createSignalSampler } from './signals.ts';
import type { Field, Condition, Sequence } from './ast.ts';
import { evaluateCondition, type ConditionContext } from './conditions.ts';
import { curveAt } from './curves.ts';
import { perData } from './constants.ts';
import { diagnostic, type Diagnostic } from './diag.ts';
import { expandSequence } from './expand.ts';
import { voiceLead, type installHarmony } from './harmony.ts';
import type { Event, PartIR, Structure } from './ir.ts';
import { durationNumber, parseDuration } from './literals.ts';
import { resolvePitch, resolvePitches } from './pitch.ts';
import { generator } from './random.ts';
import { sequenceText } from './source.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import type { Resolution } from './resolve.ts';
import { keyAt, sectionAt } from './structure.ts';
import { emptyTimed, type LiteralEvent } from './timed.ts';
const zero = new R(0),
  one = new R(1);
const registers: Record<string, readonly [number, number]> = {
  front: [60, 84],
  bed: [48, 72],
  low: [28, 55],
  color: [55, 79],
  high: [72, 96],
};
export type EventFields = {
  fields: Map<string, Field>;
  reset: R;
  sectionStart: R;
  phraseStart: R;
  incomingVelocity: number;
};
export type PartRegion = {
  start: R;
  end: R;
  fields: Map<string, Field>;
  reset: R;
  sectionStart: R;
  phraseStart: R;
};
export type PartsResult = {
  regions: Map<string, PartRegion[]>;
  parts: PartIR[];
  diagnostics: Diagnostic[];
  eventFields: Map<string, EventFields>;
};
function text(field?: Field): string {
  const v = field?.value;
  return !v
    ? ''
    : v.kind === 'clause'
      ? v.tokens.join(' ')
      : v.kind === 'sequence'
        ? sequenceText(v)
        : '';
}
function within(t: R, start: R, extent: R): boolean {
  return t.compare(start) >= 0 && t.compare(start.add(extent)) < 0;
}
function fold(pitch: number, range: readonly [number, number]): number {
  const possible: number[] = [];
  for (let n = Math.max(0, range[0]); n <= Math.min(127, range[1]); n++)
    if ((n - pitch) % 12 === 0) possible.push(n);
  return possible.sort((a, b) => Math.abs(a - pitch) - Math.abs(b - pitch) || a - b)[0] ?? pitch;
}
export function realizeParts(
  resolution: Resolution,
  structure: Structure,
  harmony: ReturnType<typeof installHarmony>,
  attackLimit = 64,
  attackLimitSeverity: 'error' | 'warning' = 'error',
  controlOnlyParts: Set<string> = new Set(),
): PartsResult {
  const diagnostics: Diagnostic[] = [],
    parts: PartIR[] = [],
    eventFields = new Map<string, EventFields>();
  const regions = new Map<string, PartRegion[]>(),
    sampler = createSignalSampler(resolution, structure);
  const bar = new R(...structure.settings.meter),
    conditions = new Map<string, Condition>();
  for (const s of resolution.normalized.statements)
    if (s.kind === 'when') conditions.set(s.name, s.condition);
  const units = structure.material.units;
  function context(
    t: R,
    reset?: R,
    cycle?: number,
    event?: LiteralEvent,
    events?: LiteralEvent[],
  ): ConditionContext {
    const section = sectionAt(structure, t)!,
      active = units.filter((u) => within(t, u.onset, u.extent)),
      phrase = active
        .filter((u) => u.kind === 'phrase')
        .sort((a, b) => a.extent.compare(b.extent))[0];
    return {
      time: t,
      bar,
      reset: reset ?? section.onset,
      sectionStart: section.onset,
      sectionExtent: section.extent,
      phraseStart: phrase?.onset ?? section.onset,
      phraseExtent: phrase?.extent ?? section.extent,
      n: cycle ?? Number(t.sub(section.onset).div(bar).floor()) + 1,
      cycle,
      names: [section.name, section.sectionName ?? '', ...active.map((u) => u.name)],
      conditions,
      signal: (n, time) =>
        sampler.named(
          n,
          time,
          {
            reset: reset ?? section.onset,
            sectionStart: section.onset,
            phraseStart: phrase?.onset ?? section.onset,
          },
          true,
        ),
      event,
      events,
      resets: new Map([
        ['song', zero],
        ['section', section.onset],
        ['phrase', phrase?.onset ?? section.onset],
        ['restart', reset ?? section.onset],
        ...active.filter((u) => u.kind === 'label').map((u) => [u.name, u.onset] as [string, R]),
      ]),
    };
  }
  function passes(
    c: Condition,
    t: R,
    reset?: R,
    cycle?: number,
    event?: LiteralEvent,
    events?: LiteralEvent[],
  ): boolean {
    try {
      return evaluateCondition(c, context(t, reset, cycle, event, events));
    } catch (error) {
      if (!diagnostics.some((d) => d.code === 'C005' && d.span.line === c.span.line))
        diagnostics.push(diagnostic('C005', String(error), c.span));
      return false;
    }
  }
  for (const statement of resolution.normalized.statements)
    if (statement.kind === 'part') {
      const partName = statement.name;
      const partRegions: PartRegion[] = [];
      regions.set(partName, partRegions);
      const base = new Map(
          statement.fields.filter((f) => f.kind === 'field').map((f) => [f.name, f]),
        ),
        overrides = statement.fields.filter((f) => f.kind === 'override');
      const part: PartIR = {
        name: statement.name,
        kind: 'notes',
        role: text(base.get('role')) || (base.has('lane') ? 'pulse' : 'bed'),
        lane: text(base.get('lane')) || undefined,
        events: [],
        controls: {},
        suppressions: [],
      };
      parts.push(part);
      const boundaries = [
        zero,
        ...structure.bars.map((b) => b.onset),
        ...units
          .filter((u) => u.kind === 'label' || u.kind === 'phrase')
          .flatMap((u) => [u.onset, u.onset.add(u.extent)]),
        structure.extent,
      ]
        .filter((t) => t.compare(zero) >= 0 && t.compare(structure.extent) <= 0)
        .sort((a, b) => a.compare(b))
        .filter((t, i, a) => !i || !t.equals(a[i - 1]));
      const used = new Set<number>(),
        cache = new Map<Field, import('./timed.ts').TimedValue>();
      let entry = zero,
        lastPlays: Field | undefined,
        lastPrevious: LiteralEvent | undefined,
        voicing: number[] | undefined,
        arpeggioIndex = 0;
      const candidates: {
        event: LiteralEvent;
        fields: Map<string, Field>;
        reset: R;
        cycle: number;
        kind: string;
        override?: number;
      }[] = [];
      for (let region = 0; region < boundaries.length - 1; region++) {
        const start = boundaries[region],
          end = boundaries[region + 1],
          section = sectionAt(structure, start);
        if (!section) continue;
        const fields = new Map(base);
        let override: number | undefined;
        overrides.forEach((block, i) => {
          if (passes(block.condition, start)) {
            used.add(i);
            for (const f of block.fields) fields.set(f.name, f);
            if (block.fields.some((f) => f.name === 'plays')) override = i;
          }
        });
        if (controlOnlyParts.has(partName)) {
          part.kind = 'control';
          const cc = context(start);
          // Automation-only parts honour restart like playing parts (e.g. a song-long camera path).
          const restart = text(fields.get('restart'));
          let reset = restart === 'never' ? zero : section.onset;
          if (restart === 'every phrase') reset = cc.phraseStart ?? section.onset;
          const periodic = restart.match(/^every (\d+) bars$/);
          if (periodic) {
            const span = bar.mul(new R(Number(periodic[1])));
            if (span.compare(zero) > 0)
              reset = section.onset.add(
                span.mul(new R(start.sub(section.onset).div(span).floor())),
              );
          }
          partRegions.push({
            start,
            end,
            fields,
            reset,
            sectionStart: section.onset,
            phraseStart: cc.phraseStart ?? section.onset,
          });
          continue;
        }
        const plays = fields.get('plays');
        if (!plays || plays.value.kind !== 'sequence') continue;
        const kind = plays.playKind ?? 'notes';
        part.kind = kind;
        const restart = text(fields.get('restart'));
        const cc = context(start);
        let reset = restart === 'never' ? zero : section.onset;
        if (restart === 'every phrase') reset = cc.phraseStart ?? section.onset;
        const periodic = restart.match(/^every (\d+) bars$/);
        if (periodic) {
          const span = bar.mul(new R(Number(periodic[1])));
          if (span.compare(zero) > 0)
            reset = section.onset.add(span.mul(new R(start.sub(section.onset).div(span).floor())));
        }
        if (plays !== lastPlays) {
          entry = start;
          lastPlays = plays;
        }
        if (restart === 'on entry') reset = entry;
        partRegions.push({
          start,
          end,
          fields,
          reset,
          sectionStart: section.onset,
          phraseStart: cc.phraseStart ?? section.onset,
        });
        const sequence: Sequence =
          kind === 'melody'
            ? plays.value
            : { ...plays.value, elements: plays.value.elements.slice(1) };
        const notes = ['melody', 'line', 'notes'].includes(kind),
          held = kind === 'chords' && !sequence.elements.length;
        const offset = (value: import('./timed.ts').TimedValue, at: R) => ({
          ...value,
          events: value.events.map((e) => ({
            ...e,
            onset: e.onset.add(at),
            holds: e.holds.map((h) => ({ ...h, onset: h.onset.add(at) })),
          })),
        });
        function expand(at: R, cycle: number) {
          const result = expandSequence(sequence, notes ? 'notes' : 'hits', {
            meter: structure.settings.meter,
            materialTime: at.sub(reset),
            absoluteMaterialTime: at,
            section: section!.extent,
            phrase: cc.phraseExtent,
            cycle,
            key: keyAt(structure, at),
            keyAt: (t) => keyAt(structure, t.add(at)),
            chordAt: (t) => harmony.chordAt(t.add(at)),
            seed: structure.settings.seed,
            address: [partName, section!.path, cycle],
            allowLeadingHold: true,
            materials: new Map([['__form_melody', structure.material]]),
            signal: (n, t) => curveAt(resolution, structure, n, t.add(at)),
          });
          diagnostics.push(...result.diagnostics);
          return result.value;
        }
        if (held) {
          const times = [
            ...structure.sections.map((s) => s.onset),
            ...harmony.layers.flatMap((l) => [
              l.start,
              l.start.add(l.extent),
              ...l.chords.map((c) => c.onset),
            ]),
            structure.extent,
          ]
            .sort((a, b) => a.compare(b))
            .filter((t, i, a) => !i || !t.equals(a[i - 1]));
          for (let i = 0; i < times.length - 1; i++) {
            const t = times[i];
            if (!within(t, start, end.sub(start))) continue;
            const source = plays.span;
            const ev: LiteralEvent = {
              onset: t,
              writtenSpan: times[i + 1].sub(t),
              gate: times[i + 1].sub(t),
              attackSpan: times[i + 1].sub(t),
              pitches: [],
              offset: 0,
              velocity: 0.7,
              locks: {},
              conditions: [],
              fields: [],
              holds: [],
              operations: [],
              source: { span: source, literal: source, slot: [i], ratchet: 0 },
            };
            candidates.push({ event: ev, fields, reset, cycle: 1, kind, override });
          }
          continue;
        }
        if (kind === 'melody' || kind === 'line') {
          let value = cache.get(plays);
          if (!value) {
            value = expand(zero, 1);
            if (value) cache.set(plays, value);
          }
          if (value)
            for (const event of value.events)
              if (within(event.onset, start, end.sub(start)))
                candidates.push({ event, fields, reset, cycle: 1, kind, override });
          continue;
        }
        const first = expand(reset, 1);
        if (!first || first.extent.compare(zero) <= 0) continue;
        const rateSteps: { step: R; origin: R }[] = [];
        function rateWalk(value: unknown) {
          if (!value || typeof value !== 'object') return;
          if (
            'kind' in value &&
            value.kind === 'call' &&
            'name' in value &&
            value.name === '__per'
          ) {
            try {
              const call = value as Extract<Expression, { kind: 'call' }>;
              rateSteps.push({
                step: perData(call, structure.settings.meter).step,
                origin: call.clock === 'song' ? zero : reset,
              });
            } catch {
              /* Expansion reports the invalid expression. */
            }
          } else
            Object.entries(value)
              .filter(([key]) => !['span', 'origin'].includes(key))
              .forEach(([, child]) => rateWalk(child));
        }
        rateWalk(sequence);
        let cycle = Number(start.sub(reset).div(first.extent).floor()) + 1;
        let at = reset.add(first.extent.mul(new R(cycle - 1)));
        if (rateSteps.length) {
          cycle = 1;
          at = reset;
        }
        let advance = first.extent;
        for (
          let guard = 0;
          at.compare(end) < 0 && guard < 65536;
          guard++, cycle++, at = at.add(advance)
        ) {
          const value = cycle === 1 ? first : expand(at, cycle);
          if (!value) break;
          advance = value.extent;
          for (const { step, origin } of rateSteps) {
            const remaining = origin
              .add(step.mul(new R(at.sub(origin).div(step).floor() + 1n)))
              .sub(at);
            if (remaining.compare(advance) < 0) advance = remaining;
          }
          const shifted = offset(value, at);
          if (rateSteps.length)
            shifted.events = shifted.events
              .filter((e) => e.onset.compare(at.add(advance)) < 0)
              .map((e) => ({
                ...e,
                writtenSpan:
                  e.writtenSpan.compare(at.add(advance).sub(e.onset)) > 0
                    ? at.add(advance).sub(e.onset)
                    : e.writtenSpan,
              }));
          if (value.leadingHolds.length && lastPrevious && at.compare(start) >= 0) {
            for (const hold of value.leadingHolds)
              if (hold.conditions.every((c) => passes(c, at, reset, cycle))) {
                lastPrevious.writtenSpan = at
                  .add(hold.onset)
                  .add(hold.span)
                  .sub(lastPrevious.onset);
                lastPrevious.gate = lastPrevious.writtenSpan;
              }
          }
          for (const event of shifted.events)
            if (within(event.onset, start, end.sub(start))) {
              candidates.push({ event, fields, reset, cycle, kind, override });
              lastPrevious = event;
            }
        }
      }
      candidates.sort((a, b) => a.event.onset.compare(b.event.onset));
      for (const candidate of candidates) {
        const event = candidate.event,
          ctx = {
            reset: candidate.reset,
            part: partName,
            velocity: event.velocity,
            sectionStart: sectionAt(structure, event.onset)!.onset,
            phraseStart: context(event.onset).phraseStart,
          };
        for (const operation of event.operations)
          if (['velocity', 'accent'].includes(operation.name)) {
            const arg = operation.args[0];
            if (arg?.kind === 'sequence') {
              const value = sampler.sampleSequence(arg, event.onset, {
                ...ctx,
                velocity: event.velocity,
              });
              if (value !== undefined)
                event.velocity = operation.name === 'accent' ? event.velocity + value : value;
            }
          }
        for (const field of event.fields)
          if (field.tokens[0] === 'velocity') {
            const parsed = parseExpression(field.tokens.slice(1).join(' '));
            if (parsed.expression)
              event.velocity =
                sampler.sample(parsed.expression, event.onset, {
                  ...ctx,
                  velocity: event.velocity,
                }) ?? event.velocity;
          }
        for (const hold of event.holds) {
          if (
            !hold.conditions.every((c) => passes(c, hold.onset, candidate.reset, candidate.cycle))
          ) {
            const span = hold.onset.sub(event.onset);
            event.writtenSpan = span;
            if (event.gate.compare(span) > 0) event.gate = span;
            break;
          }
        }
      }
      const candidateFields = new Map(candidates.map((c) => [c.event.onset.toString(), c.fields]));
      function initialPitchAt(t: R): number | undefined {
        const fields = candidateFields.get(t.toString()),
          role = text(fields?.get('role')) || part.role;
        let register = registers[role];
        const range = text(fields?.get('range')).replace(/\s/g, '').split('..');
        if (range.length === 2)
          try {
            register = [
              range[0] ? resolvePitch(range[0]) : 0,
              range[1] ? resolvePitch(range[1]) : 127,
            ];
          } catch {}
        return register ? (register[0] + register[1]) / 2 : undefined;
      }
      const preliminary = resolvePitches(
        { ...emptyTimed('notes', structure.extent), events: candidates.map((c) => c.event) },
        (t) => keyAt(structure, t),
        harmony.chordAt,
        (t) => sectionAt(structure, t)?.modulation ?? 0,
        initialPitchAt,
      ).value.events;
      const kept: typeof candidates = [];
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i],
          event = { ...candidate.event, pitchNumbers: preliminary[i]?.pitchNumbers };
        let reason: string | undefined, measured: Record<string, unknown> | undefined;
        const gate = candidate.fields.get('play');
        if (gate) {
          const value = gate.value;
          if (
            value.kind !== 'sequence' &&
            !passes(
              value,
              event.onset.sub(event.onset.sub(sectionAt(structure, event.onset)!.onset).mod(bar)),
              candidate.reset,
            )
          )
            reason = 'play when';
        }
        for (const c of event.conditions) {
          const chance = c.tokens.join(' ').match(/^chance ([\d.]+)%?( fixed)?$/);
          if (chance) {
            const p = Number(chance[1]) / (c.tokens.join(' ').includes('%') ? 100 : 1),
              fixed = !!chance[2],
              u = generator([
                'mm2',
                structure.settings.seed,
                'chance',
                ...(fixed
                  ? []
                  : [
                      statement.name,
                      sectionAt(structure, event.onset)!.path,
                      candidate.cycle,
                      event.onset.toString(),
                    ]),
                event.source.literalText ?? JSON.stringify(event.source.literal),
                event.source.slot,
                event.source.ratchet,
                event.source.operationOrdinal ?? 0,
              ])();
            if (u >= p) {
              reason = 'chance';
              measured = { draw: u, probability: p, fixed };
            }
          } else if (!passes(c, event.onset, candidate.reset, candidate.cycle, event, preliminary))
            reason = 'condition';
        }
        if (reason) {
          part.suppressions.push({
            part: part.name,
            onset: event.onset,
            reason,
            source: event.source.span,
            path: sectionAt(structure, event.onset)!.path,
            measured,
          });
        } else kept.push(candidate);
      }
      const resolved = resolvePitches(
        { ...emptyTimed('notes', structure.extent), events: kept.map((c) => c.event) },
        (t) => keyAt(structure, t),
        harmony.chordAt,
        (t) => sectionAt(structure, t)?.modulation ?? 0,
        initialPitchAt,
      );
      diagnostics.push(...resolved.diagnostics);
      for (let i = 0; i < kept.length; i++) {
        const c = kept[i],
          event = resolved.value.events[i],
          section = sectionAt(structure, event.onset)!;
        let pitches = event.pitchNumbers ?? [];
        const role = text(c.fields.get('role')) || part.role,
          rangeText = text(c.fields.get('range')).replace(/\s/g, ''),
          range = rangeText.split('..'),
          defaultRange = registers[role];
        let register = defaultRange;
        if (rangeText.includes('..'))
          try {
            register = [
              range[0] ? resolvePitch(range[0]) : 0,
              range[1] ? resolvePitch(range[1]) : 127,
            ];
          } catch (error) {
            diagnostics.push(diagnostic('R003', String(error), c.fields.get('range')!.span));
          }
        const chord = harmony.chordAt(event.onset);
        if (c.kind === 'hits') pitches = [];
        else if (['roots', 'chords', 'arpeggio'].includes(c.kind)) {
          if (chord.root === null) continue;
          if (c.kind === 'roots') {
            const pc = chord.bass ?? chord.root,
              centre = initialPitchAt(event.onset) ?? 66;
            pitches = [pc + 12 * Math.ceil((centre - pc) / 12 - 0.5)];
          } else {
            voicing = voiceLead(
              chord,
              register ?? [48, 72],
              voicing,
              Number(text(c.fields.get('voices'))) || undefined,
            );
            pitches = voicing;
            if (c.kind === 'arpeggio') {
              const order = text(c.fields.get('order')).split(/\s+/).filter(Boolean),
                item = order.length
                  ? order[arpeggioIndex++ % order.length]
                  : String(arpeggioIndex++ % Math.max(1, voicing.length)),
                index = Number(item.replace(/[\^v]/g, ''));
              pitches =
                voicing[index] === undefined
                  ? []
                  : [voicing[index] + (item.includes('^') ? 12 : item.includes('v') ? -12 : 0)];
            }
          }
        }
        const octave = Number(text(c.fields.get('octave'))) || 0;
        pitches = pitches.map((p) => {
          const folded = register ? fold(p, register) : p;
          if (
            folded !== p &&
            !diagnostics.some(
              (d) =>
                d.code === 'P004' && d.span.line === event.source.span.line && d.path === part.name,
            )
          )
            diagnostics.push(
              diagnostic('P004', 'Pitch folded into the part register', event.source.span, {
                severity: 'warning',
                path: part.name,
                measured: { written: p, folded, range: register },
              }),
            );
          return folded + 12 * octave + (c.kind === 'roots' ? event.offset : 0);
        });
        let gate = event.gate;
        const length = text(c.fields.get('length')).replace(/\s/g, '');
        if (!event.gateSpec && !event.gateOverride && length === 'legato')
          gate = (kept[i + 1]?.event.onset ?? structure.extent).sub(event.onset);
        else if (!event.gateSpec && !event.gateOverride && length.endsWith('%'))
          gate = event.writtenSpan.mul(R.parse(length.slice(0, -1))).div(new R(100));
        else if (!event.gateSpec && !event.gateOverride && length)
          try {
            gate = parseDuration(text(c.fields.get('length')), { meter: structure.settings.meter });
          } catch {
            /* resolver reports invalid length */
          }
        if (event.onset.add(gate).compare(structure.extent) > 0)
          gate = structure.extent.sub(event.onset);
        let performed = event.onset;
        const swing = text(c.fields.get('swing')).match(/^([\d.]+)%?(?: on (.+))?$/);
        if (swing) {
          const grid = durationNumber(swing[2] ?? '1/16'),
            phase = event.onset.sub(c.reset).mod(grid.mul(new R(2)));
          if (phase.equals(grid))
            performed = performed.add(
              grid.mul(new R(2)).mul(R.parse(swing[1])).div(new R(100)).sub(grid),
            );
        }
        const cc = context(event.onset, c.reset, c.cycle),
          path = section.path;
        for (const [note, pitch] of (c.kind === 'hits' ? [null] : pitches).entries()) {
          const id = `${part.name}/${path}/${event.onset}/${i}/${note}`,
            output: Event = {
              id,
              part: part.name,
              nominalOnset: event.onset,
              performedOnset: performed,
              writtenSpan: event.writtenSpan,
              gate,
              pitch,
              velocity: event.velocity,
              generator: event.generator,
              paths: event.paths,
              group: event.group ?? (text(c.fields.get('group')) || undefined),
              locks: { ...event.locks },
              path,
              provenance: {
                ...(statement.template ? { template: statement.template } : {}),
                source: event.source,
                operations: event.operations,
                pitchResolution: event.pitchResolution,
                override: c.override,
                defaults: { role, register },
                fields: Object.fromEntries([...c.fields].map(([name, f]) => [name, f.span])),
                cycle: c.cycle,
                reset: c.reset.toString(),
              },
            };
          part.events.push(output);
          eventFields.set(id, {
            fields: c.fields,
            reset: c.reset,
            sectionStart: section.onset,
            phraseStart: cc.phraseStart ?? section.onset,
            incomingVelocity: event.velocity,
          });
        }
      }
      for (const s of resolution.normalized.statements)
        if (s.kind === 'silence') {
          const tokens = s.value.tokens,
            index = tokens.indexOf('for'),
            names = tokens.slice(1, index).filter((t) => t !== ','),
            duration = tokens.slice(index + 1).join(' '),
            parsed = duration.match(/^([\d/.]+)(?: (bars?|beats?))?$/);
          if (!parsed) continue;
          let span = durationNumber(parsed[1]);
          if (parsed[2]) span = span.mul(parsed[2].startsWith('bar') ? bar : new R(1, 4));
          for (const section of structure.sections.filter(
            (s) => names.includes(s.name) || names.includes(s.sectionName ?? ''),
          )) {
            const start = section.onset.sub(span);
            part.events = part.events.filter((e) => {
              if (within(e.nominalOnset, start, span)) {
                part.suppressions.push({
                  part: part.name,
                  onset: e.nominalOnset,
                  reason: 'silence',
                  source: s.span,
                  path: e.path,
                });
                return false;
              }
              if (
                e.nominalOnset.compare(start) < 0 &&
                e.nominalOnset.add(e.gate).compare(start) > 0
              )
                e.gate = start.sub(e.nominalOnset);
              return true;
            });
          }
        }
      if (!part.events.length && !controlOnlyParts.has(partName))
        diagnostics.push(
          diagnostic('P001', `Part ${part.name} never sounds`, statement.span, {
            severity: 'warning',
          }),
        );
      overrides.forEach((block, i) => {
        if (!used.has(i))
          diagnostics.push(
            diagnostic('P002', 'Override never applies', block.span, {
              severity: 'warning',
              path: part.name,
            }),
          );
      });
      for (const b of structure.bars) {
        const count = new Set(
          part.events
            .filter((e) => within(e.nominalOnset, b.onset, b.span))
            .map((e) => e.nominalOnset.toString()),
        ).size;
        if (count > attackLimit)
          diagnostics.push(
            diagnostic('D001', `Attack density exceeds ${attackLimit} per bar`, statement.span, {
              severity: attackLimitSeverity,
              path: b.path,
              measured: { attacks: count, maximum: attackLimit },
            }),
          );
      }
    }
  diagnostics.push(...sampler.diagnostics);
  return { parts, diagnostics, eventFields, regions };
}
