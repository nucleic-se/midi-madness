import { closeSync, openSync, writeSync } from 'node:fs';
import type { Frame, SongIR } from '../../core/src/ir.ts';
import type { Bus, BusEvent, Stage } from '../../synth/src/buses.ts';
import type { SynthEvent } from '../../synth/src/engine.ts';
import type { DrumControl, DrumEvent } from '../../synth/src/drums.ts';
import type { Mix, Preset } from '../../synth/src/presets.ts';
import type { SpatialSettings } from '../../synth/src/spatial.ts';
import type { ListenerLanes, PositionLanes } from '../../synth/src/world.ts';
import type { drumLaneModel, DrumEnvelopeRecord } from '../../synth/src/drums.ts';
import type { EnvelopeRecord } from '../../synth/src/engine.ts';
import type { Tuning } from './tuning.ts';
import type { PreviewInfo } from './preview.ts';

/** Exact backend inputs, rather than another interpretation of the source score. */
export type PerformanceTrack = {
  name: string;
  kind: string;
  role: string;
  preset: string;
  seed: number;
  mix: Mix;
  /** Backend defaults before automation; null controls restore these values. */
  initialControls?: { pan: number };
  /** World-frame tracks carry x/y/z lanes in metres; listener-frame tracks are head-locked
   * and positioned by space.az/el/dist relative to the listener pose (see SPATIAL.md). */
  space?: { frame: 'world'; position: PositionLanes } | { frame: 'listener' };
  /** Inputs for evaluating envelopes as the backend does: the resolved synth preset and
   * voice allocation, or the drum lane model. */
  resolved?: { preset: Preset; voiceCount: number } | ReturnType<typeof drumLaneModel>;
  /** The envelope values the backend actually produced, per note lifetime or drum hit,
   * as lanes in backend samples. Authoritative for retrigger, release and voice allocation. */
  envelopes?: EnvelopeRecord[] | DrumEnvelopeRecord[];
  lane?: string;
  events?: SynthEvent[];
  hits?: DrumEvent[];
  controls?: DrumControl[];
};

/** Version-1 export payload before JSON serialization.
 * Score rationals become fraction strings and BigInts become decimal strings.
 * Events retain backend sample coordinates and their ordering, including ties.
 * Serialized score context omits frame expressions and compiler provenance syntax.
 */
export type PerformanceData = {
  format: 'midi-madness-performance';
  version: 1;
  title: string;
  tempoBpm: number;
  meter: readonly [number, number];
  seed: string;
  scoreHash: string;
  rendererHash: string;
  /** Present only for explicitly approximate windowed rendering. */
  preview?: PreviewInfo;
  audio: {
    file: string;
    sampleRate: number;
    /** Audio seconds = (event.sample - originSample) / sampleRate. */
    originSample: number;
    frames: number;
    /** Backend sample corresponding to score time zero. */
    scoreOffsetSample: number;
    channels: 2 | 4;
  };
  /** Optional world-space data; absent in documents written before world space existed. */
  world?: {
    version: 1;
    units: 'm';
    axes: string;
    /** x/y/z in metres, yaw/pitch in degrees; a missing lane means 0. */
    listener: ListenerLanes;
  };
  tracks: PerformanceTrack[];
  /** Explicit reduced-export settings. Absent means the original full export. */
  capture?: { envelopes: 'full' | 'none'; parts: string[] };
  buses: Bus[];
  busControls: Record<string, BusEvent[]>;
  hats: number[];
  settings: {
    inserts: Record<string, Stage[]>;
    presetOverrides: Record<string, Partial<Preset>>;
    tuning: Tuning;
    space: SpatialSettings;
    cuts: number[];
  };
  selection: { solo: string[]; mute: string[]; members: string[] };
  score: SongIR;
};

type RuntimeFrame = Omit<Frame, 'expression' | 'children'> & { children: RuntimeFrame[] };
function runtimeFrame({ expression: _expression, children, ...frame }: Frame): RuntimeFrame {
  return { ...frame, children: children.map(runtimeFrame) };
}

/** Expanded events are authoritative; compiler syntax can dwarf their runtime data. */
function runtimeScore(score: SongIR) {
  return {
    ...score,
    sections: score.sections.map(runtimeFrame),
    parts: score.parts.map((part) => ({
      ...part,
      events: part.events.map(({ provenance, ...event }) => {
        const source = provenance.source;
        const { literalText: _literalText, ...location } =
          source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
        // Source locations/identifiers are enough to trace an expanded event. Operations,
        // override clauses and other compiler provenance may repeat entire syntax trees.
        return { ...event, provenance: { source: location } };
      }),
    })),
  };
}

function performancePayload(value: unknown): unknown {
  return value &&
    typeof value === 'object' &&
    'format' in value &&
    value.format === 'midi-madness-performance' &&
    'score' in value &&
    value.score
    ? { ...value, score: runtimeScore(value.score as SongIR) }
    : value;
}

const bigintAsString = (_key: string, item: unknown) =>
  typeof item === 'bigint' ? item.toString() : item;

/** Preserve backend inputs and exact rationals, projecting only compiler score context.
 * Projection happens before stringify so repeated ASTs/text never enter the JSON string.
 */
export function performanceJson(value: unknown): string {
  return JSON.stringify(performancePayload(value), bigintAsString, 2) + '\n';
}

/** Write `performanceJson(value)` to `path` in chunks. Dense scores produce performance data
 * larger than the engine's maximum string length, so the document is never held as one string.
 * The bytes are identical to `performanceJson`.
 */
export function writePerformanceJson(path: string, value: unknown): void {
  const fd = openSync(path, 'w');
  let chunk = '';
  const write = (text: string) => {
    chunk += text;
    if (chunk.length >= 1 << 20) {
      writeSync(fd, chunk);
      chunk = '';
    }
  };
  try {
    streamJson(performancePayload(value), write);
    write('\n');
    writeSync(fd, chunk);
  } finally {
    closeSync(fd);
  }
}

/** JSON.stringify(value, bigintAsString, 2), emitted piecewise. */
function streamJson(value: unknown, write: (text: string) => void): void {
  // Mirrors JSON.stringify's SerializeJSONProperty: toJSON, then the replacer, then the type.
  const prepare = (holder: unknown, key: string, item: unknown) => {
    if (
      item !== null &&
      (typeof item === 'object' || typeof item === 'bigint') &&
      typeof (item as { toJSON?: unknown }).toJSON === 'function'
    )
      item = (item as { toJSON: (key: string) => unknown }).toJSON(key);
    item = bigintAsString.call(holder, key, item);
    if (item instanceof Number) item = Number(item);
    else if (item instanceof String) item = String(item);
    else if (item instanceof Boolean) item = item.valueOf();
    return item;
  };
  const skipped = (item: unknown) =>
    item === undefined || typeof item === 'function' || typeof item === 'symbol';
  const visit = (item: unknown, indent: string): void => {
    if (item === null) return write('null');
    if (typeof item === 'boolean') return write(item ? 'true' : 'false');
    if (typeof item === 'number') return write(Number.isFinite(item) ? String(item) : 'null');
    if (typeof item === 'string') return write(JSON.stringify(item));
    if (typeof item === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
    const inner = indent + '  ';
    if (Array.isArray(item)) {
      if (item.length === 0) return write('[]');
      write('[\n');
      for (let i = 0; i < item.length; i++) {
        if (i) write(',\n');
        write(inner);
        const element = prepare(item, String(i), item[i]);
        if (skipped(element)) write('null');
        else visit(element, inner);
      }
      return write(`\n${indent}]`);
    }
    let first = true;
    for (const key of Object.keys(item as object)) {
      const member = prepare(item, key, (item as Record<string, unknown>)[key]);
      if (skipped(member)) continue;
      write(first ? '{\n' : ',\n');
      first = false;
      write(`${inner}${JSON.stringify(key)}: `);
      visit(member, inner);
    }
    write(first ? '{}' : `\n${indent}}`);
  };
  const root = prepare({ '': value }, '', value);
  if (!skipped(root)) visit(root, '');
}
