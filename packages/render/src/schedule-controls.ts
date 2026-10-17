import { Rational as R, type RealizationResult } from '../../core/src/index.ts';
import type { PartIR } from '../../core/src/ir.ts';
import { voiceControl, type SynthEvent } from '../../synth/src/engine.ts';
import { fastShapeControl, constantControl } from './shape-rate.ts';
import { soundDomains } from './sounds.ts';
import { modulationDomains } from './score-settings.ts';
import { worldDomains } from './world-score.ts';

export function scheduleControls(
  realized: RealizationResult,
  part: PartIR,
  position: (r: R) => number,
  offset: number,
  endSample: number,
  sr: number,
  bpm: number,
  domains: Record<string, readonly [number, number, string?]> = {},
  omit: readonly string[] = [],
): (SynthEvent & { type: 'set' })[] {
  const out: (SynthEvent & { type: 'set' })[] = [],
    auto = realized.automation,
    formEnd = position(realized.song!.extent),
    startSample = Math.max(0, -offset);
  for (const [name, points] of Object.entries(part.controls)) {
    if (name === 'cents' || omit.includes(name)) continue;
    // Fast shapes get a 3 kHz grid, including streams that alias to a constant in the coarse IR.
    const fast = fastShapeControl(realized, part.name, name, bpm);
    const phaseAnchor =
      ['lfo.rate', 'lfo.hz'].includes(name) && constantControl(realized, part.name, name);
    const memberPoints =
      name === 'pan' || name.startsWith('send.') || voiceControl(name)
        ? points.filter((p) => !p.source.startsWith('lock:'))
        : points;
    const distinct = new Set(
      memberPoints.filter((p) => p.source.startsWith('expression')).map((p) => p.value),
    );
    if (!auto || (distinct.size <= 1 && !fast && constantControl(realized, part.name, name))) {
      const chased = memberPoints.findLast((p) => position(p.time) < startSample);
      if (chased) out.push({ sample: 0, type: 'set', name, value: chased.value });
      for (const p of memberPoints)
        if (
          position(p.time) >= startSample &&
          position(p.time) < formEnd &&
          position(p.time) <= endSample
        )
          out.push({ sample: position(p.time) + offset, type: 'set', name, value: p.value });
      continue;
    }
    const times = new Set<number>(points.map((p) => position(p.time)));
    for (const t of auto.boundaries(part.name, name)) times.add(position(t));
    const stride = Math.round(sr / (fast ? 3000 : 250));
    if (startSample) times.add(startSample);
    for (
      let sample = Math.ceil(startSample / stride) * stride;
      sample <= endSample;
      sample += stride
    )
      times.add(sample);
    const locks = (
      name === 'pan' || name.startsWith('send.') || voiceControl(name) ? [] : part.events
    )
      .filter((e) => e.locks[name] !== undefined)
      .sort((a, b) => a.nominalOnset.compare(b.nominalOnset));
    const tick = new R(
        realized.song!.tempo.numerator,
        BigInt(sr * 240) * realized.song!.tempo.denominator,
      ),
      at = auto.sampled(part.name, name, tick);
    const ceiling = (time: R) => -Number(time.div(tick).negate().floor());
    const lockRanges = locks.map((e) => ({
      start: ceiling(e.nominalOnset),
      end: ceiling(e.nominalOnset.add(e.gate)),
      value: e.locks[name],
    }));
    let last: number | null | undefined;
    for (const sample of [...times]
      .filter((t) => t >= startSample && t <= endSample && t < formEnd)
      .sort((a, b) => a - b)) {
      let v = at(sample);
      const lock = lockRanges.findLast((e) => sample >= e.start && sample < e.end);
      if (lock) v = lock.value;
      const domain = domains[name] ?? preparedDomain(name);
      const value = v === undefined ? null : Math.max(domain[0], Math.min(domain[1], v));
      if (
        value !== last &&
        (value === null || last === null || last === undefined || Math.abs(value - last) > 0.0001)
      ) {
        out.push({
          sample: sample + offset,
          type: 'set',
          name,
          value,
          phaseAnchor,
        });
        last = value;
      }
    }
  }
  return out.sort((a, b) => a.sample - b.sample);
}

function preparedDomain(name: string): readonly [number, number] {
  if (name in worldDomains) return worldDomains[name as keyof typeof worldDomains];
  if (name === 'space.az') return [-180, 180];
  if (name === 'space.el') return [-90, 90];
  if (name === 'space.dist') return [0.1, 100];
  if (name.endsWith('.feedback')) return [-0.95, 0.98];
  return (
    soundDomains[name] ??
    modulationDomains[name] ??
    (['pan', 'bend', 'envamount', 'tune'].includes(name) ? [-1, 1] : [0, 1])
  );
}
