import { mapShapeEndpoints } from './automation-literals.ts';
import type { Span } from '../../core/src/diag.ts';
import { ScoreError } from '../../core/src/score-error.ts';
import { scoreLine } from '../../core/src/score-error.ts';
import { busOrder, type Bus, type Stage } from '../../synth/src/buses.ts';
import { noteSeconds } from './score-settings.ts';
import { parseInsertStage, insertLiteral } from './inserts.ts';

const identifier = /^[A-Za-z][\w-]*$/;
export const busPartPrefix = 'fxbus__';
function fraction(text: string): number {
  const v = Number(text.replace('%', '')) / (text.endsWith('%') ? 100 : 1);
  if (!Number.isFinite(v) || v < 0 || v > 1)
    throw new RangeError(`Expected 0..1 or percent, got ${text}`);
  return v;
}
function seconds(text: string, bpm: number): number {
  if (text.includes('/')) return noteSeconds(text, bpm);
  const m = text.match(/^([\d.]+)(ms|s)?$/);
  if (!m) throw new RangeError(`Expected time, got ${text}`);
  return Number(m[1]) / (m[2] === 'ms' ? 1000 : 1);
}
function hz(text: string): number {
  const m = text.match(/^([\d.]+)(Hz|kHz)?$/);
  if (!m) throw new RangeError(`Expected Hz, got ${text}`);
  return Number(m[1]) * (m[2] === 'kHz' ? 1000 : 1);
}
export function defaultStage(type: 'delay' | 'reverb', id: string = type, bpm = 120): Stage {
  return {
    id,
    type,
    tone: 'lp',
    params:
      type === 'delay'
        ? { time: (60 / bpm) * 0.75, feedback: 0.35, tone: 4000, pingpong: 0.6 }
        : { decay: 2.2, predelay: 0.025, size: 0.7, damping: 6000, mod: 0 },
  };
}
function validate(stage: Stage) {
  const ranges: Record<string, [number, number]> = {
    time: [0.001, 10],
    feedback: [0, 0.98],
    tone: [20, 20000],
    pingpong: [0, 1],
    decay: [0.05, 30],
    predelay: [0, 2],
    size: [0, 1],
    damping: [20, 20000],
    mod: [0, 1],
  };
  for (const [name, value] of Object.entries(stage.params)) {
    const range = ranges[name];
    if (!Number.isFinite(value) || value < range[0] || value > range[1])
      throw new RangeError(`${stage.id}.${name} must be ${range[0]}..${range[1]}, got ${value}`);
  }
}
function parseStage(text: string, bpm: number): Stage {
  if (!/^(delay|reverb)\b/.test(text)) return parseInsertStage(text, bpm, false);
  const m = text.match(/^(delay|reverb)(?:\s+as\s+([\w-]+))?(?:\s+(.*))?$/);
  if (!m) throw new RangeError(`First effects deliverable supports delay/reverb stages: ${text}`);
  const type = m[1] as 'delay' | 'reverb',
    stage = defaultStage(type, m[2] ?? type, bpm);
  if (!identifier.test(stage.id)) throw new RangeError(`Invalid stage name ${stage.id}`);
  const seen = new Set<string>();
  for (const item of (m[3] ?? '').split(',').filter((s) => s.trim())) {
    const tokens = item.trim().split(/\s+/),
      field = tokens.shift()!;
    let key = field === 'width' ? 'pingpong' : field;
    if (!(key in stage.params)) throw new RangeError(`Unknown ${type} setting ${field}`);
    if (seen.has(key)) throw new RangeError(`Duplicate stage setting ${field}`);
    seen.add(key);
    if (key === 'tone' && (tokens[0] === 'lp' || tokens[0] === 'bp'))
      stage.tone = tokens.shift()! as 'lp' | 'bp';
    if (tokens.length !== 1) throw new RangeError(`Expected one value for ${field}`);
    const v = tokens[0];
    stage.params[key] = ['time', 'decay', 'predelay'].includes(key)
      ? seconds(v, bpm)
      : ['tone', 'damping'].includes(key)
        ? hz(v)
        : fraction(v);
    if (key === 'feedback') stage.params[key] = Math.min(0.98, stage.params[key]);
  }
  validate(stage);
  return stage;
}
function parseBus(name: string, chain: string, bpm: number): Bus {
  if (!identifier.test(name)) throw new RangeError(`Invalid bus name ${name}`);
  const bus: Bus = { name, stages: [], sends: [], explicit: true };
  let terminal = false;
  for (const text of chain.split(/\s*->\s*/)) {
    const send = text.match(/^send\s+([\w-]+)\s+(\S+)$/);
    if (send) {
      terminal = true;
      bus.sends.push({ bus: send[1], gain: fraction(send[2]) ** 2 });
      continue;
    }
    if (terminal) throw new RangeError('Bus-to-bus sends must follow the effect chain');
    const stage = parseStage(text, bpm);
    if (bus.stages.some((s) => s.id === stage.id))
      throw new RangeError(`Name repeated stages using 'as': bus ${name}, stage ${stage.id}`);
    bus.stages.push(stage);
  }
  if (!bus.stages.length) throw new RangeError(`Bus ${name} needs an effect`);
  return bus;
}
export function busField(bus: Bus, name: string): { stage: string; field: string } {
  if (name === 'return') return { stage: '$bus', field: 'return' };
  const dot = name.indexOf('.');
  if (dot >= 0) {
    const id = name.slice(0, dot),
      rawField = name.slice(dot + 1);
    const stage = bus.stages.find((s) => s.id === id);
    const field = rawField === 'width' && stage?.type === 'delay' ? 'pingpong' : rawField;
    if (!stage || !(field in stage.params))
      throw new RangeError(`Unknown bus parameter ${bus.name}.${name}`);
    return { stage: id, field };
  }
  const candidates = bus.stages.filter((s) => name in s.params);
  if (candidates.length !== 1)
    throw new RangeError(
      `Bus ${bus.name}: ${name} ${candidates.length ? 'is ambiguous' : 'is unknown'}; candidates: ${candidates.map((s) => `${s.id}.${name}`).join(', ') || 'none'}`,
    );
  return { stage: candidates[0].id, field: name };
}
function automationLiteral(field: string, text: string, bpm: number): string {
  const shape = mapShapeEndpoints(text, (literal) => automationLiteral(field, literal, bpm));
  if (shape !== undefined) return shape;
  const value = text.trim();
  const per = value.match(/^(per\s+[^:]+:)\s*(.+)$/);
  if (per)
    return `${per[1]} ${per[2]
      .split(',')
      .map((v) => automationLiteral(field, v.trim(), bpm))
      .join(', ')}`;
  if (value === 'off') return '0';
  if (
    ['time', 'decay', 'predelay'].includes(field) &&
    (/^(?:\d+)\/\d+(?:\.|t)?$/.test(value) || /^[\d.]+(?:ms|s)$/.test(value))
  ) {
    const t = seconds(value, bpm);
    if (field === 'time') {
      if (t < 0.001 || t > 10) throw new RangeError('Delay time must be 1ms..10s');
      return String(Math.log(t / 0.001) / Math.log(10000));
    }
    if (field === 'decay') {
      if (t < 0.05 || t > 30) throw new RangeError('Reverb decay must be 50ms..30s');
      return String(Math.log(t / 0.05) / Math.log(600));
    }
    if (t < 0 || t > 2) throw new RangeError('Predelay must be 0..2s');
    return String((t / 2) ** (1 / 3));
  }
  if (['tone', 'damping'].includes(field) && /^[\d.]+(?:Hz|kHz)$/.test(value)) {
    const frequency = hz(value);
    if (frequency < 20 || frequency > 20000) throw new RangeError('Tone must be 20Hz..20kHz');
    return String(Math.log(frequency / 20) / Math.log(1000));
  }
  return text;
}
export function extractEffects(source: string, bpm: number) {
  const buses: Bus[] = [
    { name: 'room', stages: [defaultStage('reverb', 'reverb', bpm)], sends: [] },
    { name: 'echo', stages: [defaultStage('delay', 'delay', bpm)], sends: [] },
  ];
  const lines = source.split(/\r?\n/),
    declared = new Set<string>();
  let inFx = false;
  const removed = lines.map((raw, i) =>
    scoreLine(i + 1, () => {
      const line = raw.replace(/\/\/.*$/, ''),
        text = line.trim();
      if (text === 'fx' && !/^\s/.test(line)) {
        inFx = true;
        return '';
      }
      if (inFx && text && !/^\s/.test(line)) inFx = false;
      if (!inFx) return raw;
      if (!text) return '';
      const m = text.match(/^bus\s+([\w-]+)\s*=\s*(.+)$/);
      if (!m) throw new RangeError(`Line ${i + 1}: expected bus NAME = delay/reverb chain`);
      if (declared.has(m[1])) throw new RangeError(`Duplicate bus ${m[1]}`);
      declared.add(m[1]);
      const bus = parseBus(m[1], m[2], bpm),
        index = buses.findIndex((b) => b.name === bus.name);
      if (index >= 0) buses[index] = bus;
      else buses.push(bus);
      return '';
    }),
  );
  scoreLine(Math.max(1, lines.findIndex((line) => /^\s*bus\s+\S+\s*=/.test(line)) + 1), () =>
    busOrder(buses),
  );
  const busParts: Record<string, string> = {};
  let active: Bus | undefined;
  const coreSource = removed
    .map((raw, i) =>
      scoreLine(i + 1, () => {
        const line = raw.replace(/\/\/.*$/, ''),
          text = line.trim();
        if (text && !/^\s/.test(line)) {
          active = undefined;
          const m = text.match(/^bus\s+([\w-]+)$/);
          if (m) {
            active = buses.find((b) => b.name === m[1]);
            if (!active) throw new RangeError(`Unknown bus ${m[1]}`);
            const part = busPartPrefix + m[1];
            if (part in busParts)
              throw new RangeError(`Duplicate automation block for bus ${m[1]}`);
            busParts[part] = m[1];
            return `part ${part}`;
          }
          if (text.startsWith(`part ${busPartPrefix}`))
            throw new RangeError(`${busPartPrefix} is reserved for effects automation`);
        }
        if (!active) return raw;
        if (!text || text.startsWith('when ')) return raw;
        const duck = text.match(/^duck from ([\w-]+) ([\d.]+)dB release (\S+)$/);
        if (duck) {
          if (active.duck) throw new RangeError(`Duplicate duck setting for ${active.name}`);
          const depthDb = Number(duck[2]),
            release = seconds(duck[3], bpm);
          if (depthDb > 48 || release <= 0 || release > 30)
            throw new RangeError('Duck depth must be 0..48dB and release >0..30s');
          active.duck = { part: duck[1], depthDb, release };
          // A duck-only block still needs an indented control to form a valid
          // control-only part. Do not override an explicitly written return.
          let end = i + 1;
          while (end < removed.length && (!removed[end].trim() || /^\s/.test(removed[end]))) end++;
          let start = i - 1;
          while (start >= 0 && (!removed[start].trim() || /^\s/.test(removed[start]))) start--;
          const explicitReturn = removed
            .slice(start + 1, end)
            .some((s) => /^\s{2}return\s*=/.test(s));
          return explicitReturn ? '' : '  return = 1';
        }
        const m = line.match(/^(\s+)([\w.-]+)\s*=\s*(.+)$/);
        if (!m)
          throw new RangeError(`Line ${i + 1}: bus automation expects parameter = expression`);
        const target = busField(active, m[2]),
          name = target.stage === '$bus' ? 'return' : `${target.stage}.${target.field}`;
        const stage = active.stages.find((s) => s.id === target.stage);
        const value =
          stage && !['delay', 'reverb'].includes(stage.type)
            ? insertLiteral(stage, target.field, m[3], bpm)
            : automationLiteral(target.field, m[3], bpm);
        return `${m[1]}${name} = ${value}`;
      }),
    )
    .join('\n');
  return { coreSource, buses, busParts };
}
export function validateSends(
  parts: {
    name: string;
    controls: Record<string, unknown>;
    events: { locks: Record<string, number> }[];
  }[],
  buses: Bus[],
  busParts: Record<string, string>,
  locations: Record<string, Span> = {},
) {
  const names = new Set(buses.map((b) => b.name));
  for (const part of parts) {
    try {
      if (part.name in busParts) continue;
      for (const key of new Set([
        ...Object.keys(part.controls),
        ...part.events.flatMap((e) => Object.keys(e.locks)),
      ])) {
        if (!key.startsWith('send.')) continue;
        const name = key.slice(5).replace(/\.pre$/, '');
        if (!names.has(name)) throw new RangeError(`${part.name}: send to unknown bus ${name}`);
      }
      for (const e of part.events)
        for (const key of Object.keys(e.locks))
          if (key.startsWith('send.') && key.endsWith('.pre'))
            throw new RangeError('Pre/post routing is a member setting, not a note lock');
    } catch (error) {
      if (error instanceof ScoreError || !(error instanceof RangeError)) throw error;
      throw new ScoreError(
        error.message,
        locations[part.name] ?? { line: 1, col: 1, endLine: 1, endCol: 1 },
      );
    }
  }
  for (const bus of buses)
    if (bus.duck && !parts.some((p) => p.name === bus.duck!.part && !(p.name in busParts)))
      throw new ScoreError(
        `Unknown duck source ${bus.duck.part}`,
        locations[busPartPrefix + bus.name] ?? { line: 1, col: 1, endLine: 1, endCol: 1 },
      );
}
