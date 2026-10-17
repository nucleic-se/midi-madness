export const CURVES = [
  'linear',
  'hold',
  'smoothstep',
  'ease-in',
  'ease-out',
  'exp',
  'log',
] as const;
export type Curve = (typeof CURVES)[number];

/** Translate external vocabulary at import boundaries. Internal lanes use hold. */
export function readCurve(value: unknown, allowStep = false): Curve {
  if (allowStep && value === 'step') return 'hold';
  if (typeof value !== 'string' || !(CURVES as readonly string[]).includes(value))
    throw new RangeError(`Unknown curve interpolation: ${String(value)}`);
  return value as Curve;
}

/** Weights apply to value-independent easing; exp/log require actual endpoints. */
export function curveWeight(curve: string, fraction: number): number {
  const mode = readCurve(curve);
  if (!Number.isFinite(fraction)) throw new RangeError('Curve progress must be finite');
  const t = Math.min(1, Math.max(0, fraction));
  if (mode === 'exp' || mode === 'log')
    throw new RangeError('Native exponential/logarithmic curves require endpoints');
  if (t === 1) return 1;
  if (mode === 'hold') return 0;
  if (mode === 'smoothstep') return t * t * (3 - 2 * t);
  if (mode === 'ease-in') return t * t;
  if (mode === 'ease-out') return 1 - (1 - t) ** 2;
  return t;
}

/** Interpolate in native units; apply pitch scale/offset after interpolation. */
export function interpolate(
  from: number,
  to: number,
  progress: number,
  curve: string = 'linear',
): number {
  const mode = readCurve(curve);
  if (![from, to, progress].every(Number.isFinite))
    throw new RangeError('Curve inputs must be finite');
  const t = Math.max(0, Math.min(1, progress));
  if (mode === 'exp' || mode === 'log') {
    if (from === 0 || to === 0 || from / to <= 0)
      throw new RangeError(`${mode} endpoints must be nonzero and have the same sign`);
    if (mode === 'exp') return from * (to / from) ** t;
    if (from !== to)
      return from + ((to - from) * Math.log1p((to / from - 1) * t)) / Math.log(to / from);
    return from;
  }
  return from + (to - from) * curveWeight(mode, t);
}

export interface PointAccess<T> {
  time(point: T): number;
  value(point: T): number | null;
  curve(point: T): string;
}

/** Index of the last point at/before time; ties resolve in authored/backend order.
 * Import validation rejects duplicate authored times; backend adapters may resolve
 * ordered simultaneous writes before preparing a lane.
 */
export function laneIndex<T>(points: readonly T[], time: number, access: PointAccess<T>): number {
  let lo = 0,
    hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (access.time(points[mid]!) <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Segment evaluation shared by random access, prepared lanes and sequential DSP cursors. */
export function sampleSegment<T>(
  points: readonly T[],
  index: number,
  time: number,
  fallback: number | null,
  access: PointAccess<T>,
): number | null {
  if (index < 0) return fallback;
  const a = points[index]!;
  const value = access.value(a);
  if (value === null) return fallback;
  const b = points[index + 1];
  // A reset never becomes an interpolation endpoint. Duplicate backend writes
  // are resolved by laneIndex or a cursor before this function is called.
  if (!b || access.value(b) === null || access.curve(a) === 'hold') return value;
  const duration = access.time(b) - access.time(a);
  if (duration <= 0) return value;
  return interpolate(value, access.value(b)!, (time - access.time(a)) / duration, access.curve(a));
}

export function sampleLane<T>(
  points: readonly T[],
  time: number,
  fallback: number | null,
  access: PointAccess<T>,
  before: 'first' | 'default' = 'default',
): number | null {
  if (!Number.isFinite(time)) throw new RangeError('Lane time must be finite');
  const index = laneIndex(points, time, access);
  if (index < 0 && before === 'first' && points.length) return access.value(points[0]!) ?? fallback;
  return sampleSegment(points, index, time, fallback, access);
}

export interface ControlPoint {
  readonly time: number;
  readonly value: number | null;
  readonly curve?: Curve;
}
const timeAccess: PointAccess<ControlPoint> = {
  time: (p) => p.time,
  value: (p) => p.value,
  curve: (p) => p.curve ?? 'hold',
};

/** Immutable validated lane. Null resets to the supplied source default. */
export class ControlLane {
  readonly points: readonly ControlPoint[];
  constructor(points: readonly ControlPoint[]) {
    this.points = Object.freeze(
      points
        .map((p) => {
          if (!Number.isFinite(p.time) || (p.value !== null && !Number.isFinite(p.value)))
            throw new RangeError('Lane points must be finite');
          if (p.curve !== undefined) readCurve(p.curve);
          return Object.freeze({ ...p });
        })
        .sort((a, b) => a.time - b.time),
    );
    for (let i = 1; i < this.points.length; i++) {
      const a = this.points[i - 1]!,
        b = this.points[i]!;
      if (a.time === b.time) throw new RangeError('Duplicate control time; resolve event ordering');
      if (a.value !== null && b.value !== null) interpolate(a.value, b.value, 0, a.curve ?? 'hold');
    }
  }
  sample(
    time: number,
    fallback: number | null,
    before: 'first' | 'default' = 'default',
  ): number | null {
    return sampleLane(this.points, time, fallback, timeAccess, before);
  }
  value(time: number, fallback: number): number {
    if (!Number.isFinite(fallback)) throw new RangeError('Lane default must be finite');
    return sampleLane(this.points, time, fallback, timeAccess)!;
  }
}

/** Beat coordinates are an authored-data convenience; the evaluator is unit-independent. */
export interface BeatPoint {
  beat: number;
  value: number;
  curve: string;
}
const beatAccess: PointAccess<BeatPoint> = {
  time: (p) => p.beat,
  value: (p) => p.value,
  curve: (p) => p.curve,
};
export function sampleBeatCurve(points: readonly BeatPoint[], beat: number): number {
  if (!points.length) throw new RangeError('Beat curve has no points.');
  return sampleLane(points, beat, null, beatAccess, 'first')!;
}

export function loopTime(
  time: number,
  period: number,
  origin = 0,
  negative: 'clamp' | 'wrap' = 'clamp',
): number {
  if (![time, period, origin].every(Number.isFinite) || period <= 0)
    throw new RangeError('Loop needs finite time/origin and positive period');
  const elapsed = negative === 'clamp' ? Math.max(0, time - origin) : time - origin;
  const phase = elapsed % period;
  return phase < 0 ? phase + period : phase;
}
