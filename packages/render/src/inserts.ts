import { mapShapeEndpoints } from './automation-literals.ts';
import type { Span } from '../../core/src/diag.ts';
import { ScoreError } from '../../core/src/score-error.ts';
import { scoreLine } from '../../core/src/score-error.ts';
import type { Stage } from '../../synth/src/buses.ts';
import {
  effectParams,
  normalizedEffectValue,
  type EffectType,
} from '../../synth/src/processors.ts';
import { noteSeconds } from './score-settings.ts';

const identifier = /^[A-Za-z][\w-]*$/;
export function settingValue(type: EffectType, field: string, value: string, bpm: number): number {
  const d = field === 'mix' || field === 'bypass' ? { min: 0, max: 1 } : effectParams[type][field];
  if (!d) throw new RangeError(`Unknown ${type} parameter ${field}`);
  let n: number;
  if ('choices' in d && d.choices?.includes(value)) n = d.choices.indexOf(value);
  else if ('unit' in d && d.unit === 'time' && value.includes('/')) n = noteSeconds(value, bpm);
  else if ('unit' in d && d.unit === 'hz' && value.includes('/')) n = 1 / noteSeconds(value, bpm);
  else if ('unit' in d && d.unit === 'hz' && /^[A-G][#b]?-?\d+$/.test(value)) {
    const m = value.match(/^([A-G])([#b]?)(-?\d+)$/)!;
    const note =
      ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as Record<string, number>)[m[1]] +
      (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) +
      (Number(m[3]) + 1) * 12;
    n = 440 * 2 ** ((note - 69) / 12);
  } else {
    const m = value.match(/^([-+\d.]+)(%|ms|s|Hz|kHz|oct)?$/);
    if (!m) throw new RangeError(`Invalid ${type}.${field}: ${value}`);
    n = Number(m[1]) * (m[2] === 'kHz' ? 1000 : m[2] === 'ms' ? 0.001 : m[2] === '%' ? 0.01 : 1);
    if (
      m[2] &&
      m[2] !== '%' &&
      !(
        ('unit' in d && d.unit === 'time' && ['ms', 's'].includes(m[2])) ||
        ('unit' in d && d.unit === 'hz' && ['Hz', 'kHz'].includes(m[2])) ||
        (field === 'depth' && ['autofilter', 'phaser'].includes(type) && m[2] === 'oct')
      )
    )
      throw new RangeError(`Wrong unit for ${type}.${field}: ${value}`);
  }
  if (!Number.isFinite(n) || n < d.min - 1e-12 || n > d.max + 1e-12)
    throw new RangeError(`${type}.${field} must be ${d.min}..${d.max}, got ${value}`);
  return Math.max(d.min, Math.min(d.max, n));
}
export function parseInsertStage(text: string, bpm: number, insert = true): Stage {
  const m = text.match(/^(\w+)(?:\s+as\s+([\w-]+))?(?:\s+(.*))?$/);
  if (!m || !Object.hasOwn(effectParams, m[1]))
    throw new RangeError(`Unknown effect stage ${text}`);
  const type = m[1] as EffectType;
  if (insert && type === 'reverb')
    throw new RangeError('Insert reverb is deferred; use a named reverb bus');
  const stage: Stage = {
    id: m[2] ?? type,
    type,
    tone: 'lp',
    params: Object.fromEntries(Object.entries(effectParams[type]).map(([k, d]) => [k, d.initial])),
  };
  if (!identifier.test(stage.id)) throw new RangeError(`Invalid stage name ${stage.id}`);
  if (type === 'delay') stage.params.time = 45 / bpm;
  if (type === 'gate') stage.params.rate = bpm / 15;
  if (insert) {
    stage.params.mix = ['delay'].includes(type)
      ? 0.25
      : ['chorus', 'comb', 'ring', 'phaser', 'flanger'].includes(type)
        ? 0.5
        : 1;
    stage.params.bypass = 0;
  }
  const seen = new Set<string>();
  for (let item of (m[3] ?? '').split(',').filter((s) => s.trim())) {
    item = item.trim();
    if (type === 'drive' && /^[-+\d.]+%?$/.test(item)) item = `amount ${item}`;
    const f = item.match(/^(\w+)\s+(.+)$/);
    if (!f) throw new RangeError(`Expected field and value: ${item}`);
    let field = f[1],
      value = f[2];
    if (field === 'width' && type === 'delay') field = 'pingpong';
    if ((type === 'comb' && field === 'pitch') || (type === 'flanger' && field === 'tune')) {
      const hz = settingValue('ring', 'hz', value, bpm);
      field = 'time';
      value = `${1 / hz}s`;
    }
    if (seen.has(field)) throw new RangeError(`Duplicate ${stage.id}.${field}`);
    seen.add(field);
    if (field === 'pattern' && type === 'gate') {
      const pattern = value.match(/^\|\s*([xXo.\s]+)\s*\|$/);
      if (!pattern)
        throw new RangeError('Gate pattern currently accepts a single | x . x . | literal');
      stage.pattern = pattern[1]
        .trim()
        .split(/\s+/)
        .map((s) => (s === '.' ? 0 : s === 'o' ? 0.5 : 1));
      continue;
    }
    if (field === 'tone' && type === 'delay') {
      const tone = value.match(/^(lp|bp)\s+(.+)$/);
      if (tone) {
        stage.tone = tone[1] as 'lp' | 'bp';
        value = tone[2];
      }
    }
    if (!insert && ['mix', 'bypass'].includes(field))
      throw new RangeError(
        `Bus ${type} stages are wet-only and have no ${field}; adjust the bus return/send, or use an insert`,
      );
    if (!(field in stage.params)) throw new RangeError(`Unknown ${type} setting ${field}`);
    stage.params[field] = settingValue(type, field, value, bpm);
  }
  return stage;
}
export function insertLiteral(stage: Stage, field: string, text: string, bpm: number): string {
  if (!(field in stage.params)) throw new RangeError(`Unknown ${stage.id}.${field}`);
  const shape = mapShapeEndpoints(text, (literal) =>
    /^[-+]?\d+(?:\.\d+)?$/.test(literal) ? literal : insertLiteral(stage, field, literal, bpm),
  );
  if (shape !== undefined) return shape;
  const value = text.trim();
  const per = value.match(/^(per\s+[^:]+:)\s*(.+)$/);
  if (per)
    return `${per[1]} ${per[2]
      .split(',')
      .map((v) => insertLiteral(stage, field, v.trim(), bpm))
      .join(', ')}`;
  const choices = effectParams[stage.type][field]?.choices;
  if (
    choices?.includes(value) ||
    /^[-+]?\d+(?:\.\d+)?(?:ms|s|Hz|kHz|oct)$/.test(value) ||
    /^\d+\/\d+(?:\.|t)?$/.test(value) ||
    /^[A-G][#b]?-?\d+$/.test(value) ||
    (['bits', 'voices', 'stages'].includes(field) && /^\d+$/.test(value))
  ) {
    return String(
      normalizedEffectValue(stage.type, field, settingValue(stage.type, field, value, bpm)),
    );
  }
  return value;
}
export function extractInserts(source: string, bpm: number) {
  const inserts: Record<string, Stage[]> = {};
  let part: string | undefined;
  const lines = source.split(/\r?\n/);
  const removed = lines.map((raw, sourceLineIndex) =>
    scoreLine(sourceLineIndex + 1, () => {
      const line = raw.replace(/\/\/.*$/, ''),
        text = line.trim();
      if (text && !/^\s/.test(line)) part = text.match(/^part\s+([\w-]+)$/)?.[1];
      const m = line.match(/^(\s+)insert\s*=\s*(.+)$/);
      if (!m) return raw;
      if (!part || m[1].length !== 2)
        throw new RangeError(
          'Declare one insert chain directly under its part; automate fields in when blocks',
        );
      if (inserts[part]) throw new RangeError(`Duplicate insert chain for ${part}`);
      const stages = m[2].split(/\s*->\s*/).map((s) => parseInsertStage(s, bpm));
      if (new Set(stages.map((s) => s.id)).size !== stages.length)
        throw new RangeError(`Name repeated insert stages with 'as': ${part}`);
      inserts[part] = stages;
      return '';
    }),
  );
  part = undefined;
  const coreSource = removed
    .map((raw, sourceLineIndex) =>
      scoreLine(sourceLineIndex + 1, () => {
        const line = raw.replace(/\/\/.*$/, ''),
          text = line.trim();
        if (text && !/^\s/.test(line)) part = text.match(/^part\s+([\w-]+)$/)?.[1];
        const m = line.match(/^(\s+)insert\.([\w-]+)\.([\w]+)\s*=\s*(.+)$/);
        if (!m) return raw;
        const stage = inserts[part ?? '']?.find((s) => s.id === m[2]);
        if (!stage) throw new RangeError(`Unknown insert stage ${part}.${m[2]}`);
        const field = stage.type === 'delay' && m[3] === 'width' ? 'pingpong' : m[3];
        return `${m[1]}insert.${stage.id}.${field} = ${insertLiteral(stage, field, m[4], bpm)}`;
      }),
    )
    .join('\n');
  return { inserts, coreSource };
}
export function validateInserts(
  parts: {
    name: string;
    lane?: string;
    controls: Record<string, unknown>;
    events: { locks: Record<string, number> }[];
  }[],
  inserts: Record<string, Stage[]>,
  locations: Record<string, Span> = {},
) {
  for (const part of parts) {
    try {
      const centsPoints = part.controls.cents;
      if (Array.isArray(centsPoints) && centsPoints.some((p) => p.source?.startsWith('expression')))
        throw new RangeError('Cents is a per-note lock; use bend for member automation');
      for (const name of new Set([
        ...Object.keys(part.controls),
        ...part.events.flatMap((e) => Object.keys(e.locks)),
      ])) {
        if (name === 'cents') continue;
        if (!name.startsWith('insert.')) continue;
        const [id, field, extra] = name.slice(7).split('.');
        const stage = inserts[part.name]?.find((s) => s.id === id);
        if (!stage || extra || !(field in stage.params))
          throw new RangeError(`Unknown insert parameter ${part.name}.${name}`);
      }
      for (const e of part.events) {
        const cents = e.locks.cents;
        if (cents !== undefined && (!Number.isFinite(cents) || Math.abs(cents) > 2400 || part.lane))
          throw new RangeError(
            'Cents locks require a pitched note and an offset within ±2400 cents',
          );
      }
    } catch (error) {
      if (error instanceof ScoreError || !(error instanceof RangeError)) throw error;
      throw new ScoreError(
        error.message,
        locations[part.name] ?? { line: 1, col: 1, endLine: 1, endCol: 1 },
      );
    }
  }
}
