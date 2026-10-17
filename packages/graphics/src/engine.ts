import { ControlLane, readCurve, type Curve } from '@midi-madness/foundation/curves';

/** Data and time only: this module runs without a DOM or graphics library. */
export interface EngineContext<D> {
  data: D;
}
export interface CollectionConfig<T = any, D = any> {
  data: keyof D | ((data: D) => T[]);
  start: (datum: T, context: EngineContext<D>) => number;
  duration?: (datum: T, context: EngineContext<D>) => number;
}
export interface SignalConfig<T = any, D = any> {
  data: keyof D | ((data: D) => T[]);
  time: (datum: T) => number;
  value: (datum: T) => number | null;
  interpolation?: Curve | 'step';
  before?: 'first' | 'default';
}
export interface EngineConfig<D> {
  collections: Record<string, CollectionConfig<any, D>>;
  signals?: Record<string, SignalConfig<any, D>>;
}
export interface TimedRecord<T = any> {
  datum: T;
  start: number;
  end: number;
}
export interface ActiveRecord<T = any> extends TimedRecord<T> {
  progress: number;
}
export interface EngineFrame<D = any> {
  data: D;
  time: number;
  active: Record<string, ActiveRecord[]>;
  signals: Record<string, number | null>;
}
/** A renderer is an independent consumer of the shared data and absolute time. */
export interface EngineRenderer<D> {
  load(engine: StructureEngine<D>): void;
  render(frame: EngineFrame<D>): void;
  dispose(): void;
}

export class StructureEngine<D> {
  readonly collections: Record<string, readonly TimedRecord[]> = {};
  private readonly signals: Record<string, { lane: ControlLane; before: 'first' | 'default' }> = {};
  constructor(
    readonly data: D,
    config: EngineConfig<D>,
  ) {
    const source = (selector: keyof D | ((data: D) => any[])) => {
      const items = typeof selector === 'function' ? selector(data) : data[selector];
      if (!Array.isArray(items)) throw new Error('Collection source must be an array');
      return items;
    };
    for (const [id, collection] of Object.entries(config.collections)) {
      this.collections[id] = source(collection.data)
        .map((datum) => {
          const start = collection.start(datum, { data });
          const duration = collection.duration?.(datum, { data }) ?? 0;
          if (
            !Number.isFinite(start) ||
            !Number.isFinite(duration) ||
            duration < 0 ||
            !Number.isFinite(start + duration)
          )
            throw new Error(`Invalid timing in ${id}`);
          return { datum, start, end: start + duration };
        })
        .sort((a, b) => a.start - b.start);
    }
    for (const [id, signal] of Object.entries(config.signals ?? {})) {
      const points = source(signal.data)
        .map((datum) => ({ time: signal.time(datum), value: signal.value(datum) }))
        .sort((a, b) => a.time - b.time);
      if (
        !points.length ||
        points.some(
          (p, i) =>
            !Number.isFinite(p.time) ||
            (p.value !== null && !Number.isFinite(p.value)) ||
            (i > 0 && p.time === points[i - 1].time),
        )
      )
        throw new Error(`Invalid signal ${id}`);
      const curve = readCurve(signal.interpolation ?? 'linear', true);
      this.signals[id] = {
        lane: new ControlLane(points.map((p) => ({ ...p, curve }))),
        before: signal.before ?? (curve === 'hold' ? 'default' : 'first'),
      };
    }
  }
  /** Half-open interval: adjacent events do not both fire at a shared boundary. */
  window(collection: string, from: number, to: number): readonly TimedRecord[] {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from)
      throw new Error('Invalid time window');
    if (!(collection in this.collections)) throw new Error(`Unknown collection ${collection}`);
    if (from === to) return [];
    return this.collections[collection].filter(
      (record) =>
        record.start < to &&
        (record.end > from || (record.start === record.end && record.start >= from)),
    );
  }
  /** Absolute-time evaluation makes seeking and rendering deterministic. Units belong to the caller. */
  frame(time: number): EngineFrame<D> {
    if (!Number.isFinite(time)) throw new Error('Time must be finite');
    const active = Object.fromEntries(
      Object.entries(this.collections).map(([id, records]) => [
        id,
        records
          .filter(
            (r) => r.start <= time && (r.end > time || (r.start === r.end && r.start === time)),
          )
          .map((r) => ({
            ...r,
            progress: r.end === r.start ? 1 : (time - r.start) / (r.end - r.start),
          })),
      ]),
    );
    const signals = Object.fromEntries(
      Object.entries(this.signals).map(([id, { lane, before }]) => [
        id,
        lane.sample(time, null, before),
      ]),
    );
    return { data: this.data, time, active, signals };
  }
}
