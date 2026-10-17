import { laneIndex, sampleSegment, type PointAccess } from '@midi-madness/foundation/curves';
/** World-space geometry shared by audio rendering and the performance export.
 * Pure functions only: no DSP state, so graphics can evaluate exactly what audio used.
 *
 * Right-handed, Three.js-compatible axes: +x right,
 * +y up, -z forward. Yaw is in degrees, 0 faces -z, positive turns clockwise seen
 * from above (toward +x). Pitch is in degrees, positive looks up. There is no roll.
 */
export type LaneCurve = 'linear' | 'step';
/** `curve` describes the segment that starts at this point. */
export type LanePoint = { sample: number; value: number; curve: LaneCurve };
export type PositionAxis = 'x' | 'y' | 'z';
export type ListenerAxis = PositionAxis | 'yaw' | 'pitch';
export type PositionLanes = Partial<Record<PositionAxis, LanePoint[]>>;
export type ListenerLanes = Partial<Record<ListenerAxis, LanePoint[]>>;
export type ListenerPose = { x: number; y: number; z: number; yaw: number; pitch: number };
export const positionAxes: readonly PositionAxis[] = ['x', 'y', 'z'];
export const listenerAxes: readonly ListenerAxis[] = ['x', 'y', 'z', 'yaw', 'pitch'];
export const defaultPose: Readonly<ListenerPose> = Object.freeze({
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
});

const laneAccess: PointAccess<LanePoint> = {
  time: (point) => point.sample,
  value: (point) => point.value,
  curve: (point) => (point.curve === 'step' ? 'hold' : 'linear'),
};
/** Random-access lane value. Before the first point the default applies; after the last it holds. */
export function laneValue(points: readonly LanePoint[] | undefined, sample: number, fallback = 0) {
  if (!points?.length) return fallback;
  return sampleSegment(
    points,
    laneIndex(points, sample, laneAccess),
    sample,
    fallback,
    laneAccess,
  )!;
}
/** Sequential evaluation for render loops. Samples must not decrease. */
export class LaneCursor {
  private index = -1;
  private readonly points: readonly LanePoint[] | undefined;
  private readonly fallback: number;
  constructor(points: readonly LanePoint[] | undefined, fallback = 0) {
    this.points = points;
    this.fallback = fallback;
  }
  at(sample: number): number {
    const points = this.points;
    if (!points?.length) return this.fallback;
    while (this.index + 1 < points.length && points[this.index + 1].sample <= sample) this.index++;
    return sampleSegment(points, this.index, sample, this.fallback, laneAccess)!;
  }
}
/** Sequential listener pose for render loops. The returned basis is reused between calls. */
export class PoseCursor {
  private readonly cursors: Record<ListenerAxis, LaneCursor>;
  private readonly basis = listenerBasis(defaultPose);
  constructor(lanes: ListenerLanes = {}) {
    this.cursors = Object.fromEntries(
      listenerAxes.map((axis) => [axis, new LaneCursor(lanes[axis])]),
    ) as Record<ListenerAxis, LaneCursor>;
  }
  at(sample: number): Readonly<ListenerBasis> {
    const c = this.cursors,
      b = this.basis;
    b.x = c.x.at(sample);
    b.y = c.y.at(sample);
    b.z = c.z.at(sample);
    const yaw = c.yaw.at(sample),
      pitch = c.pitch.at(sample);
    if (yaw !== b.yaw || pitch !== b.pitch) {
      b.yaw = yaw;
      b.pitch = pitch;
      b.sinYaw = Math.sin((yaw * Math.PI) / 180);
      b.cosYaw = Math.cos((yaw * Math.PI) / 180);
      b.sinPitch = Math.sin((pitch * Math.PI) / 180);
      b.cosPitch = Math.cos((pitch * Math.PI) / 180);
    }
    return b;
  }
}
export function listenerPose(lanes: ListenerLanes | undefined, sample: number): ListenerPose {
  return {
    x: laneValue(lanes?.x, sample),
    y: laneValue(lanes?.y, sample),
    z: laneValue(lanes?.z, sample),
    yaw: laneValue(lanes?.yaw, sample),
    pitch: laneValue(lanes?.pitch, sample),
  };
}

/** A pose with its trigonometry computed once, for many sources at one sample. */
export type ListenerBasis = ListenerPose & {
  sinYaw: number;
  cosYaw: number;
  sinPitch: number;
  cosPitch: number;
};
export function listenerBasis(pose: ListenerPose): ListenerBasis {
  const yaw = (pose.yaw * Math.PI) / 180,
    pitch = (pose.pitch * Math.PI) / 180;
  return {
    ...pose,
    sinYaw: Math.sin(yaw),
    cosYaw: Math.cos(yaw),
    sinPitch: Math.sin(pitch),
    cosPitch: Math.cos(pitch),
  };
}
export type Relative = { azimuth: number; elevation: number; distance: number };
/** World point → listener-relative azimuth/elevation (degrees) and distance (metres).
 * Azimuth 0 is straight ahead, positive to the right; elevation is positive upward.
 */
export function relativeToListener(
  x: number,
  y: number,
  z: number,
  basis: ListenerBasis,
  out: Relative = { azimuth: 0, elevation: 0, distance: 0 },
): Relative {
  const dx = x - basis.x,
    dy = y - basis.y,
    dz = z - basis.z;
  const right = dx * basis.cosYaw + dz * basis.sinYaw,
    level = dx * basis.sinYaw - dz * basis.cosYaw;
  const forward = level * basis.cosPitch + dy * basis.sinPitch,
    up = dy * basis.cosPitch - level * basis.sinPitch;
  const distance = Math.hypot(right, up, forward);
  out.distance = distance;
  out.azimuth = distance === 0 ? 0 : (Math.atan2(right, forward) * 180) / Math.PI;
  out.elevation =
    distance === 0 ? 0 : (Math.asin(Math.max(-1, Math.min(1, up / distance))) * 180) / Math.PI;
  return out;
}
/** Listener-relative coordinates → world point; the inverse of `relativeToListener`.
 * Head-locked (listener-frame) tracks use this to report where they are in the world.
 */
export function worldFromRelative(
  azimuth: number,
  elevation: number,
  distance: number,
  basis: ListenerBasis,
): [number, number, number] {
  const az = (azimuth * Math.PI) / 180,
    el = (elevation * Math.PI) / 180;
  const right = distance * Math.sin(az) * Math.cos(el),
    forward = distance * Math.cos(az) * Math.cos(el),
    up = distance * Math.sin(el);
  const level = forward * basis.cosPitch - up * basis.sinPitch,
    dy = forward * basis.sinPitch + up * basis.cosPitch;
  return [
    basis.x + right * basis.cosYaw + level * basis.sinYaw,
    basis.y + dy,
    basis.z + right * basis.sinYaw - level * basis.cosYaw,
  ];
}

/** Remove interior points while every removed point stays within `tolerance` of the line that
 * replaces it. Step points and the points after them are kept, so jumps stay exact.
 * Linear runs use a slope cone: a segment from an anchor may end at a point only if its slope
 * lies within the band every intermediate point allows, so error never accumulates.
 */
export function simplifyLane(points: readonly LanePoint[], tolerance: number): LanePoint[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  const out: LanePoint[] = [];
  let anchor = 0;
  while (anchor < points.length - 1) {
    const a = points[anchor];
    out.push({ ...a });
    if (a.curve === 'step') {
      anchor++;
      continue;
    }
    let lo = -Infinity,
      hi = Infinity,
      end = anchor + 1;
    for (let j = anchor + 1; j < points.length; j++) {
      const p = points[j],
        dt = p.sample - a.sample;
      if (dt <= 0) break;
      const slope = (p.value - a.value) / dt;
      if (slope < lo || slope > hi) break;
      end = j;
      // A step point ends the run: nothing after it can share this segment.
      if (p.curve === 'step') break;
      lo = Math.max(lo, (p.value - tolerance - a.value) / dt);
      hi = Math.min(hi, (p.value + tolerance - a.value) / dt);
      if (lo > hi) break;
    }
    anchor = end;
  }
  if (anchor === points.length - 1) out.push({ ...points[anchor] });
  return out;
}
