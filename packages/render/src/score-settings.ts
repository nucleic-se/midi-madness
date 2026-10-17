import { ScoreError } from '../../core/src/score-error.ts';
import { scoreLine } from '../../core/src/score-error.ts';
import type { SpatialSettings } from '../../synth/src/spatial.ts';
import { loadDataLanes } from '../../core/src/data.ts';
import type { SongIR } from '../../core/src/ir.ts';
import type { Span } from '../../core/src/diag.ts';
import { scoreContext } from '../../core/src/score-error.ts';
import { parse, parseDuration } from '../../core/src/index.ts';
import { expandTemplates } from '../../core/src/templates.ts';
import type { ParameterDomains } from '../../core/src/realize.ts';
import { effectParams, type EffectType } from '../../synth/src/processors.ts';
import { extractEffects, validateSends } from './fx-score.ts';
import { extractInserts, validateInserts } from './inserts.ts';
import { extractTuning } from './tuning.ts';
import { extractSounds, soundDomains } from './sounds.ts';
import { extractListener, listenerDomains, listenerPart, worldDomains } from './world-score.ts';
import type { EchoSettings } from '../../synth/src/effects.ts';
export const modulationDomains = {
  'level.db': [-60, 12],
  'lfo.hz': [0.01, 5000],
  'lfo.rate': [Math.log(0.01 / 0.05) / Math.log(40000), Math.log(5000 / 0.05) / Math.log(40000)],
  'lfo.pitch': [-2400, 2400],
  'lfo.cutoff': [-4, 4],
  'lfo.amp': [-1, 1],
  'lfo.pan': [-1, 1],
  'lfo.shape': [0, 1],
  'bend.range': [0, 24],
  'ring.hz': [0.01, 5000],
  'ring.ratio': [0.01, 32],
  'ring.mix': [0, 1],
  'comb.hz': [0.5, 5000],
  'comb.time': [0.0002, 2],
  'comb.mix': [0, 1],
  'comb.feedback': [-0.95, 0.95],
  'comb.depth': [0, 0.01],
  'comb.rate': [0.01, 20],
} as Record<string, readonly [number, number]>;
export function noteSeconds(text: string, bpm: number): number {
  const m = text.match(/^(\d+)\/(\d+)(\.|t)?$/);
  if (!m || !Number(m[2])) throw new RangeError(`Expected note value, got ${text}`);
  return (
    ((Number(m[1]) / Number(m[2])) * (m[3] === '.' ? 1.5 : m[3] === 't' ? 2 / 3 : 1) * 240) / bpm
  );
}
function frequency(text: string): number {
  const m = text.match(/^([\d.]+)(kHz|Hz)?$/);
  if (!m) throw new RangeError(`Expected frequency, got ${text}`);
  return Number(m[1]) * (m[2] === 'kHz' ? 1000 : 1);
}
function time(text: string, bpm: number): number {
  if (text.includes('/')) return noteSeconds(text, bpm);
  const m = text.match(/^([\d.]+)(ms|s)?$/);
  if (!m) throw new RangeError(`Expected time, got ${text}`);
  return Number(m[1]) / (m[2] === 'ms' ? 1000 : 1);
}
/** Narrow software-only literal/mix syntax; ordinary score grammar stays unchanged. */
export function prepareSoftwareScore(source: string, filename?: string) {
  let spaceSpan: Span = { line: 1, col: 1, endLine: 1, endCol: 1 };
  const space: SpatialSettings = { output: 'stereo', distance: false, air: false };
  source = source
    .split(/\r?\n/)
    .map((raw, sourceLineIndex) =>
      scoreLine(sourceLineIndex + 1, () => {
        const text = raw.replace(/\/\/.*$/, '').trim();
        if (!text.startsWith('space ')) return raw;
        spaceSpan = { line: sourceLineIndex + 1, col: 1, endLine: sourceLineIndex + 1, endCol: 1 };
        if (text === 'space stereo' || text === 'space binaural' || text === 'space ambisonic 1') {
          space.output = text.includes('binaural')
            ? 'binaural'
            : text.includes('ambisonic')
              ? 'ambisonic'
              : 'stereo';
        } else if (text.startsWith('space distance ')) {
          for (const setting of text.slice(6).split(',')) {
            const [key, value, extra] = setting.trim().split(/\s+/);
            if (extra) throw new RangeError(`Invalid spatial setting ${setting}`);
            if (key === 'distance' && value === 'inverse') space.distance = true;
            else if (key === 'air' && ['on', 'off'].includes(value)) space.air = value === 'on';
            else if (key === 'reverb' && /^[A-Za-z][\w-]*$/.test(value)) space.room = value;
            else throw new RangeError(`Unknown spatial setting ${setting}`);
          }
        } else
          throw new RangeError(
            'space supports stereo, binaural, ambisonic 1 or distance inverse, air on, reverb room',
          );
        return '';
      }),
    )
    .join('\n');
  const data = loadDataLanes(source, filename);
  const templates = expandTemplates(data.source);
  try {
    source = templates.source;
    const bpm = Number(source.match(/^\s*tempo\s+([\d.]+)/m)?.[1] ?? 120);
    const echo: EchoSettings = {};
    const fx = extractEffects(source, bpm);
    const listener = extractListener(fx.coreSource, fx.busParts);
    const inserted = extractInserts(listener.coreSource, bpm);
    const tuned = extractTuning(inserted.coreSource);
    const sounded = extractSounds(tuned.coreSource, bpm);
    let inMix = false;
    const cutBefore: { sections: string[]; seconds: number; span: Span }[] = [];
    const coreSource = sounded.coreSource
      .split(/\r?\n/)
      .map((raw, sourceLineIndex) =>
        scoreLine(sourceLineIndex + 1, () => {
          const line = raw.replace(/\/\/.*$/, ''),
            text = line.trim();
          const cut = text.match(/^silence before (.+) for (\S+)(?: (bars?|beats?))? and cut fx$/);
          if (cut) {
            const meter = source.match(/^\s*meter\s+(\d+)\/(\d+)/m);
            const duration = cut[3]
              ? parseDuration(`${cut[2]} ${cut[3]}`, {
                  meter: meter ? [Number(meter[1]), Number(meter[2])] : [4, 4],
                })
              : undefined;
            const sec = duration
              ? ((Number(duration.numerator) / Number(duration.denominator)) * 240) / bpm
              : noteSeconds(cut[2], bpm);
            if (!(sec > 0)) throw new RangeError('FX cut needs a positive duration');
            const authoredLine = templates.locations[sourceLineIndex]?.line ?? sourceLineIndex + 1;
            cutBefore.push({
              sections: cut[1].split(/\s*,\s*|\s+/),
              seconds: sec,
              span: { line: authoredLine, col: 1, endLine: authoredLine, endCol: 1 },
            });
            return raw.replace(/\s+and cut fx(?:\s*\/\/.*)?$/, '');
          }
          if (text === 'mix' && !/^\s/.test(line)) {
            inMix = true;
            return '';
          }
          if (inMix && text && !/^\s/.test(line)) inMix = false;
          if (inMix) {
            if (!text) return '';
            if (!text.startsWith('echo '))
              throw new RangeError('Early mix block supports echo only');
            for (const field of text.slice(5).split(',')) {
              const [key, value, extra] = field.trim().split(/\s+/);
              if (!value || extra) throw new RangeError(`Invalid echo setting ${field}`);
              if (key === 'time') echo.time = time(value, bpm);
              else if (key === 'width' || key === 'feedback')
                echo[key] = Number(value.replace('%', '')) / (value.endsWith('%') ? 100 : 1);
              else throw new RangeError(`Unsupported echo setting ${key}`);
            }
            if (echo.time !== undefined && (!(echo.time > 0) || echo.time > 10))
              throw new RangeError('Echo time must be >0..10 seconds');
            if (echo.width !== undefined && (echo.width < 0 || echo.width > 1))
              throw new RangeError('Echo width must be 0..1');
            if (echo.feedback !== undefined && (echo.feedback < 0 || echo.feedback > 0.95))
              throw new RangeError('Echo feedback must be 0..0.95');
            return '';
          }
          const nativeLevel = line.match(/^(\s+)level\s*=\s*([-+\d.]+)dB\s*$/);
          if (nativeLevel) {
            const value = Number(nativeLevel[2]);
            if (!Number.isFinite(value) || value < -60 || value > 12)
              throw new RangeError('Level must be -60..+12dB relative to the member/lane preset');
            return `${nativeLevel[1]}level.db = ${value}`;
          }
          const m = line.match(
            /^(\s+)(lfo\.shape|lfo\.sync|lfo\.rate|lfo\.pitch|lfo\.cutoff|bend\.range|ring\.sync|ring\.hz|comb\.sync|comb\.pitch|comb\.time)\s*(?:=\s*)?([^\s]+)\s*$/,
          );
          if (!m)
            return raw
              .replace(
                /^(\s+)(reverb|delay)\s*=/,
                (_, indent, key) => `${indent}send.${key === 'reverb' ? 'room' : 'echo'} =`,
              )
              .replace(
                /([,{]\s*)(reverb|delay)(\s+[-+\d])/g,
                (_, prefix, key, tail) =>
                  `${prefix}send.${key === 'reverb' ? 'room' : 'echo'}${tail}`,
              );
          let key = m[2],
            textValue = m[3],
            value: number;
          if (key === 'lfo.shape') {
            const shapes: Record<string, number> = {
              sine: 0,
              triangle: 0.25,
              square: 0.5,
              saw: 0.75,
              'sample-and-hold': 1,
              sh: 1,
            };
            if (!(textValue in shapes)) return raw;
            value = shapes[textValue];
          } else if (key.endsWith('.sync')) {
            const seconds = noteSeconds(textValue, bpm);
            key = key.replace(
              '.sync',
              key === 'comb.sync' ? '.time' : key === 'lfo.sync' ? '.rate' : '.hz',
            );
            value =
              key === 'comb.time'
                ? seconds
                : key === 'lfo.rate'
                  ? Math.log(1 / seconds / 0.05) / Math.log(40000)
                  : 1 / seconds;
          } else if (key === 'comb.pitch') {
            const p = textValue.match(/^([A-G])([#b]?)(-?\d+)$/);
            if (!p) throw new RangeError(`Expected absolute note, got ${textValue}`);
            const note =
              ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as Record<string, number>)[p[1]] +
              (p[2] === '#' ? 1 : p[2] === 'b' ? -1 : 0) +
              (Number(p[3]) + 1) * 12;
            value = 440 * 2 ** ((note - 69) / 12);
            value = 1 / value;
            key = 'comb.time';
          } else if (key === 'lfo.rate' && /Hz$/.test(textValue)) {
            value = Math.log(frequency(textValue) / 0.05) / Math.log(40000);
          } else if (key === 'ring.hz') value = frequency(textValue);
          else if (key === 'comb.time' && (/(?:ms|s)$/.test(textValue) || textValue.includes('/')))
            value = time(textValue, bpm);
          else if (
            ['lfo.pitch', 'lfo.cutoff', 'bend.range'].includes(key) &&
            /(?:ct|oct|st)$/.test(textValue)
          ) {
            const suffix = textValue.match(/(ct|oct|st)$/)![1];
            const cents =
              Number(textValue.replace(/(?:ct|oct|st)$/, '')) *
              (suffix === 'oct' ? 1200 : suffix === 'st' ? 100 : 1);
            value = key === 'lfo.pitch' ? cents : key === 'lfo.cutoff' ? cents / 1200 : cents / 100;
          } else return raw;
          if (!Number.isFinite(value)) throw new RangeError(`Invalid software value ${textValue}`);
          return `${m[1]}${key} = ${value}`;
        }),
      )
      .join('\n');
    const parsed = parse(coreSource);
    const partSpans = Object.fromEntries(
      parsed.ast.statements
        .filter((s) => s.kind === 'part')
        .map((s) => {
          const line = templates.locations[s.span.line - 1]?.line ?? s.span.line;
          return [s.name, { line, col: 1, endLine: line, endCol: 1 }];
        }),
    );
    const domains: ParameterDomains = Object.fromEntries(
      parsed.ast.statements
        .filter((s) => s.kind === 'part')
        .map((s) => [
          s.name,
          {
            'space.az': [-180, 180],
            'space.el': [-90, 90],
            'space.dist': [0.1, 100],
            ...worldDomains,
            ...modulationDomains,
            ...soundDomains,
            envamount: [-1, 1] as const,
            cents: [-2400, 2400] as const,
          },
        ]),
    );
    function effectDomain(type: EffectType, field: string): readonly [number, number, string?] {
      if (field === 'feedback') {
        const p = effectParams[type][field];
        return [p.min, p.max];
      }
      const p = effectParams[type][field];
      if (!p?.unit) return [0, 1];
      const display = (n: number) =>
        p.unit === 'time' ? (n < 1 ? `${n * 1000} ms` : `${n} s`) : `${n} Hz`;
      return [
        0,
        1,
        `${type}.${field} reads 0..1, where 0 = ${display(p.min)} and 1 = ${display(p.max)}; write ${p.unit === 'time' ? '6s for seconds' : '800Hz for hertz'}; shape endpoints accept the same native literals`,
      ];
    }
    for (const [part, stages] of Object.entries(inserted.inserts))
      for (const stage of stages)
        for (const field of Object.keys(stage.params))
          (domains[part] ??= {})[`insert.${stage.id}.${field}`] = effectDomain(stage.type, field);
    if (listener.found) Object.assign((domains[listenerPart] ??= {}), listenerDomains);
    for (const part of Object.keys(fx.busParts)) {
      if (part === listenerPart) continue;
      domains[part] ??= {};
      domains[part].return = [0, 1];
      const bus = fx.buses.find((b) => b.name === fx.busParts[part])!;
      for (const stage of bus.stages)
        for (const field of Object.keys(stage.params))
          domains[part][`${stage.id}.${field}`] = effectDomain(stage.type, field);
    }
    const defaultEcho = fx.buses.find((b) => b.name === 'echo')!;
    if (!defaultEcho.explicit) {
      const p = defaultEcho.stages[0].params;
      if (echo.time !== undefined) p.time = echo.time;
      if (echo.feedback !== undefined) p.feedback = echo.feedback;
      if (echo.width !== undefined) p.pingpong = echo.width;
    }
    return {
      coreSource,
      partSpans,
      space,
      spaceSpan,
      dataDependencies: data.dependencies,
      echo,
      domains,
      buses: fx.buses,
      busParts: fx.busParts,
      inserts: inserted.inserts,
      cutBefore,
      tuning: tuned.tuning,
      sounds: sounded.sounds,
      presetOverrides: sounded.overrides,
      templates,
    };
  } catch (error) {
    if (error instanceof ScoreError) {
      const start = templates.locations[error.span.line - 1];
      const end = templates.locations[error.span.endLine - 1];
      throw new ScoreError(error.message, {
        ...error.span,
        line: start?.line ?? error.span.line,
        endLine: end?.line ?? error.span.endLine,
      });
    }
    throw error;
  }
}

/** Score-dependent renderer checks shared by check and render. */
export function validateSoftwareScore(
  song: SongIR,
  prepared: ReturnType<typeof prepareSoftwareScore>,
) {
  validateSends(song.parts, prepared.buses, prepared.busParts, prepared.partSpans);
  validateInserts(song.parts, prepared.inserts, prepared.partSpans);
  scoreContext(prepared.spaceSpan, () => {
    if (prepared.space.room && !prepared.buses.some((b) => b.name === prepared.space.room))
      throw new RangeError(`Unknown spatial reverb bus ${prepared.space.room}`);
  });
  for (const part of song.parts)
    scoreContext(prepared.partSpans[part.name], () => {
      if (part.lane && part.events.some((e) => e.generator?.kind === 'grains' || e.paths?.length))
        throw new RangeError('Grains and per-note paths currently require a pitched synth part');
      for (const event of part.events)
        for (const path of event.paths ?? []) {
          if (path.name === 'pitch') continue;
          const domain =
            prepared.domains[part.name]?.[path.name] ?? (path.name === 'pan' ? [-1, 1] : [0, 1]);
          if (
            (path.from !== undefined && (path.from < domain[0] || path.from > domain[1])) ||
            path.to < domain[0] ||
            path.to > domain[1]
          )
            throw new RangeError(`Note path ${path.name} must stay in ${domain[0]}..${domain[1]}`);
        }
    });
  for (const cut of prepared.cutBefore)
    scoreContext(cut.span, () => {
      for (const name of cut.sections)
        if (!song.sections.some((s) => s.name === name || s.sectionName === name))
          throw new RangeError(`Unknown FX cut section ${name}`);
    });
}
