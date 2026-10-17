import { scoreLine } from '../../core/src/score-error.ts';
import { Rational as R, type RealizationResult } from '../../core/src/index.ts';
import type { PartIR } from '../../core/src/ir.ts';
import {
  listenerAxes,
  positionAxes,
  simplifyLane,
  type LanePoint,
  type ListenerAxis,
  type ListenerLanes,
  type PositionLanes,
} from '../../synth/src/world.ts';
import { fastShapeControl, constantControl } from './shape-rate.ts';

/** The listener block becomes a control-only part, registered with the bus parts. */
// Shares the fxbus__ prefix (fx-score's busPartPrefix) so bus-part filtering also covers it.
export const listenerPart = 'fxbus__listener';
export const listenerMarker = '$listener';
export const worldDomains = {
  'space.x': [-1000, 1000],
  'space.y': [-1000, 1000],
  'space.z': [-1000, 1000],
} as const;
export const listenerDomains = {
  'listener.x': [-1000, 1000],
  'listener.y': [-1000, 1000],
  'listener.z': [-1000, 1000],
  'listener.yaw': [-3600, 3600],
  'listener.pitch': [-90, 90],
} as const;
const worldNames = Object.keys(worldDomains),
  relativeNames = ['space.az', 'space.el', 'space.dist'];

/** Rewrite a top-level `listener` block into an automation-only part. */
export function extractListener(source: string, busParts: Record<string, string>) {
  if (listenerPart in busParts)
    throw new RangeError('A bus named listener would collide with the listener block');
  let active = false,
    found = false;
  const coreSource = source
    .split(/\r?\n/)
    .map((raw, i) =>
      scoreLine(i + 1, () => {
        const line = raw.replace(/\/\/.*$/, ''),
          text = line.trim();
        if (text && !/^\s/.test(line)) {
          active = text === 'listener';
          if (!active) return raw;
          if (found) throw new RangeError('Only one listener block is allowed');
          found = true;
          return `part ${listenerPart}`;
        }
        if (!active || !text || text.startsWith('when ') || /^restart\b/.test(text)) return raw;
        const m = line.match(/^(\s+)(x|y|z|yaw|pitch)\s*=\s*(.+)$/);
        if (!m)
          throw new RangeError(
            `Line ${i + 1}: the listener block accepts x, y, z, yaw and pitch automation (and restart)`,
          );
        return `${m[1]}listener.${m[2]} = ${m[3]}`;
      }),
    )
    .join('\n');
  if (found) busParts[listenerPart] = listenerMarker;
  return { coreSource, found };
}

/** World frame when any space.x/y/z appears; listener-relative otherwise. Mixing diagnoses. */
export function partFrame(part: PartIR): 'world' | 'listener' {
  const uses = (names: string[]) =>
    names.some((n) => n in part.controls) ||
    part.events.some(
      (e) =>
        names.some((n) => e.locks[n] !== undefined) || e.paths?.some((p) => names.includes(p.name)),
    );
  const world = uses(worldNames);
  if (world && uses(relativeNames))
    throw new RangeError(
      `${part.name}: use either world space.x/y/z or listener-relative space.az/el/dist, not both`,
    );
  return world ? 'world' : 'listener';
}

/** Sample one control into a lane on the renderer's automation grid plus its boundaries.
 * Jumps become a step point one sample before the boundary. Lanes start at backend sample 0.
 */
export function controlLane(
  realized: RealizationResult,
  part: PartIR,
  name: string,
  position: (r: R) => number,
  offset: number,
  endSample: number,
  sr: number,
  bpm: number,
  domain: readonly [number, number],
  tolerance: number,
): LanePoint[] {
  const controls = part.controls[name]?.filter((p) => !p.source.startsWith('lock:'));
  // Note locks alone leave only "absent" placeholders: the part has no automation to sample.
  if (!controls?.some((p) => p.source !== 'absent')) return [];
  const auto = realized.automation,
    formEnd = position(realized.song!.extent),
    startSample = Math.max(0, -offset),
    clamp = (v: number | null | undefined) =>
      v === null || v === undefined ? 0 : Math.max(domain[0], Math.min(domain[1], v));
  const points = new Map<number, LanePoint>();
  const distinct = new Set(
    controls.filter((p) => p.source.startsWith('expression')).map((p) => p.value),
  );
  const fast = fastShapeControl(realized, part.name, name, bpm);
  if (!auto || (distinct.size <= 1 && !fast && constantControl(realized, part.name, name))) {
    const chased = controls.findLast((p) => position(p.time) < startSample);
    if (chased) points.set(0, { sample: 0, value: clamp(chased.value), curve: 'step' });
    for (const p of controls) {
      const sample = position(p.time);
      if (sample >= startSample && sample < formEnd && sample <= endSample)
        points.set(sample + offset, {
          sample: sample + offset,
          value: clamp(p.value),
          curve: 'step',
        });
    }
  } else {
    const sampled = auto.sampled(
      part.name,
      name,
      new R(realized.song!.tempo.numerator, BigInt(sr * 240) * realized.song!.tempo.denominator),
    );
    const at = (sample: number) => clamp(sampled(Math.max(0, sample)));
    const boundaries = new Set<number>([
      ...controls.map((p) => position(p.time)),
      ...auto.boundaries(part.name, name).map(position),
    ]);
    const times = new Set(boundaries);
    const stride = Math.round(sr / (fast ? 3000 : 250));
    if (startSample) times.add(startSample);
    for (
      let sample = Math.ceil(startSample / stride) * stride;
      sample <= endSample;
      sample += stride
    )
      times.add(sample);
    for (const sample of [...times]
      .filter((t) => t >= startSample && t <= endSample && t < formEnd)
      .sort((a, b) => a - b)) {
      const value = at(sample);
      if (boundaries.has(sample) && sample > startSample + 1) {
        // A boundary inside a continuous ramp is not a jump: compare with the extrapolated slope.
        const before = at(sample - 1),
          expected = 2 * before - at(sample - 2);
        if (Math.abs(value - expected) > tolerance)
          points.set(sample - 1 + offset, {
            sample: sample - 1 + offset,
            value: before,
            curve: 'step',
          });
      }
      points.set(sample + offset, { sample: sample + offset, value, curve: 'linear' });
    }
  }
  const lane = [...points.values()].sort((a, b) => a.sample - b.sample);
  if (lane.length && lane[0].sample > 0) lane.unshift({ ...lane[0], sample: 0, curve: 'step' });
  return simplifyLane(lane, tolerance);
}

type LaneArgs = [
  realized: RealizationResult,
  position: (r: R) => number,
  offset: number,
  endSample: number,
  sr: number,
  bpm: number,
];
export function positionLanes(part: PartIR, ...args: LaneArgs): PositionLanes {
  const [realized, position, offset, endSample, sr, bpm] = args;
  const lanes: PositionLanes = {};
  for (const axis of positionAxes) {
    const name = `space.${axis}` as keyof typeof worldDomains;
    const lane = controlLane(
      realized,
      part,
      name,
      position,
      offset,
      endSample,
      sr,
      bpm,
      worldDomains[name],
      0.0001,
    );
    if (lane.length) lanes[axis] = lane;
  }
  return lanes;
}
export function listenerLanes(part: PartIR | undefined, ...args: LaneArgs): ListenerLanes {
  const [realized, position, offset, endSample, sr, bpm] = args;
  const lanes: ListenerLanes = {};
  if (!part) return lanes;
  for (const axis of listenerAxes) {
    const name = `listener.${axis}` as keyof typeof listenerDomains;
    const angle = (['yaw', 'pitch'] as ListenerAxis[]).includes(axis);
    const lane = controlLane(
      realized,
      part,
      name,
      position,
      offset,
      endSample,
      sr,
      bpm,
      listenerDomains[name],
      angle ? 0.001 : 0.0001,
    );
    if (lane.length) lanes[axis] = lane;
  }
  return lanes;
}
