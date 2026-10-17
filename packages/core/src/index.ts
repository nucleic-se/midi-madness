import { loadDataLanes } from './data.ts';
import { diagnostic } from './diag.ts';
import { checkExpectations } from './expect.ts';
import { realizeControls } from './realize.ts';
import { checkConditions } from './check-conditions.ts';
import { realizeParts } from './parts.ts';
/** Score parsing, resolution, realization and inspection APIs. */
import { Rational } from '@midi-madness/foundation/time';
export { Rational } from '@midi-madness/foundation/time';
export { parse, parseExpression } from './parser.ts';
export type { File, Statement, Expression, Sequence } from './ast.ts';
export type { Diagnostic, Span, Edit } from './diag.ts';
import { buildStructure } from './structure.ts';
import { installHarmony } from './harmony.ts';
export { buildStructure, keyAt, sectionAt } from './structure.ts';
export { installHarmony, voiceLead } from './harmony.ts';
import { parseChord, parseKey, pitchClass } from './pitch.ts';
export { parseChord, parseKey, resolvePitch, resolvePitches, shiftPitch } from './pitch.ts';
import { parse } from './parser.ts';
import { summary } from './diag.ts';
import { expandBinding } from './expand.ts';
export { expandBinding, expandSequence } from './expand.ts';
import { resolve } from './resolve.ts';
export { resolve } from './resolve.ts';
import { checkLiterals } from './check-literals.ts';
export { compileLiteral, euclid, parseDuration, isBinaryDuration } from './literals.ts';
export { sequenceTimed } from './timed.ts';
export type { TimedValue, LiteralEvent, TimedType } from './timed.ts';
export type CheckOptions = {
  filename?: string;
  templateContext?: import('./templates.ts').TemplateExpansion;
  parameterDomains?: import('./realize.ts').ParameterDomains;
  deferDeviceExpectations?: boolean;
  attackLimit?: number;
  attackLimitSeverity?: 'error' | 'warning';
  controlOnlyParts?: Set<string>;
};
export function check(source: string, options: CheckOptions = {}) {
  let dataDiagnostics: import('./diag.ts').Diagnostic[] = [];
  try {
    source = loadDataLanes(source, options.filename).source;
  } catch (error) {
    dataDiagnostics = [
      diagnostic('R003', `Automation data: ${(error as Error).message}`, {
        line: (error as { line?: number }).line ?? 1,
        col: 1,
        endLine: (error as { line?: number }).line ?? 1,
        endCol: 1,
      }),
    ];
  }
  const result = parse(source, options.templateContext);
  const resolution = resolve(result.ast);
  const local = checkLiterals(resolution.normalized);
  const expanded = new Map<string, import('./timed.ts').TimedValue>();
  const expansionDiagnostics: import('./diag.ts').Diagnostic[] = [];
  const song = result.ast.statements.find((s) => s.kind === 'song');
  const literal = song?.kind === 'song' ? song.fields.find((f) => f.name === 'literal') : undefined;
  if (literal && (literal.value.kind !== 'clause' || literal.value.tokens.join('') !== '1'))
    expansionDiagnostics.push(
      diagnostic('R003', 'Supported literal profile: literal 1', literal.span),
    );
  const meterText =
    song?.kind === 'song' ? song.fields.find((f) => f.name === 'meter')?.value : undefined;
  const meter =
    meterText?.kind === 'clause'
      ? (meterText.tokens[0].split('/').map(Number) as [number, number])
      : ([4, 4] as [number, number]);
  const occurrenceDependent = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(occurrenceDependent);
    if (!value || typeof value !== 'object')
      return (
        value === 'section' ||
        value === 'phrase' ||
        value === 'pulse' ||
        value === 'pulses' ||
        value === '__per'
      );
    return Object.entries(value).some(
      ([k, v]) => !['origin', 'span'].includes(k) && occurrenceDependent(v),
    );
  };
  for (const statement of resolution.normalized.statements)
    if (statement.kind === 'binding' && !occurrenceDependent(statement.value)) {
      const expansion = expandBinding(resolution, statement.name, { meter });
      expansionDiagnostics.push(...expansion.diagnostics);
      if (expansion.value) expanded.set(statement.name, expansion.value);
    }
  const keyField =
    song?.kind === 'song' ? song.fields.find((f) => f.name === 'key')?.value : undefined;
  let key = parseKey();
  if (keyField?.kind === 'clause') {
    try {
      key = parseKey(keyField.tokens.join(' '));
    } catch (error) {
      expansionDiagnostics.push({
        code: 'R003',
        severity: 'error',
        message: String(error),
        span: keyField.span,
        fixes: [],
        causes: [],
        help: 'R003',
      });
    }
  }
  for (const value of expanded.values()) {
    for (const chord of value.chords) {
      try {
        parseChord(chord.symbol, key);
      } catch (error) {
        expansionDiagnostics.push({
          code: 'H001',
          severity: 'error',
          message: String(error),
          span: chord.source,
          fixes: [],
          causes: [],
          help: 'chords',
        });
      }
    }
    for (const event of value.events)
      if (value.type === 'notes')
        for (const spelling of event.pitches) {
          try {
            pitchClass(spelling, key);
          } catch (error) {
            expansionDiagnostics.push({
              code: 'R003',
              severity: 'error',
              message: String(error),
              span: event.source.span,
              fixes: [],
              causes: [],
              help: 'pitches',
            });
          }
        }
  }
  // Ambiguous names cannot be realized safely: a section may otherwise be
  // expanded into a curve expression and generate errors at every control tick.
  const arranged =
    !resolution.diagnostics.some((d) => d.code === 'R004') &&
    result.ast.statements.some((s) => s.kind === 'form')
      ? buildStructure(resolution)
      : { structure: undefined, diagnostics: [] };
  const harmony = arranged.structure ? installHarmony(resolution, arranged.structure) : undefined;
  const realized =
    arranged.structure && harmony
      ? realizeParts(
          resolution,
          arranged.structure,
          harmony,
          options.attackLimit,
          options.attackLimitSeverity,
          options.controlOnlyParts,
        )
      : undefined;
  const controls =
    realized && arranged.structure
      ? realizeControls(resolution, arranged.structure, realized, options.parameterDomains)
      : undefined;
  expansionDiagnostics.push(...(realized?.diagnostics ?? []), ...(controls?.diagnostics ?? []));
  if (realized && arranged.structure)
    expansionDiagnostics.push(
      ...checkExpectations(resolution, arranged.structure, realized.parts, {
        deferDevice: options.deferDeviceExpectations,
      }),
    );
  expansionDiagnostics.push(...arranged.diagnostics, ...(harmony?.diagnostics ?? []));
  const unique = [
    ...dataDiagnostics,
    ...result.diagnostics,
    ...resolution.diagnostics,
    ...checkConditions(resolution),
    ...local.diagnostics,
    ...expansionDiagnostics,
  ].filter(
    (d, i, all) =>
      !all
        .slice(0, i)
        .some((p) => p.code === d.code && p.span.line === d.span.line && p.span.col === d.span.col),
  );
  const diagnostics = unique.sort((a, b) => a.span.line - b.span.line || a.span.col - b.span.col);
  return {
    ast: result.ast,
    resolution,
    expanded,
    structure: arranged.structure,
    harmony,
    parts: realized?.parts,
    eventFields: realized?.eventFields,
    signals: controls?.sampler,
    automation: controls?.automation,
    diagnostics,
    literals: local.literals,
    stage: realized ? 'realized' : arranged.structure ? 'structure' : ('fragment' as const),
    summary: summary(diagnostics),
  };
}

export type RealizationResult = ReturnType<typeof check> & {
  song: import('./ir.ts').SongIR | undefined;
};
export function realize(source: string, options?: RealizeOptions): RealizationResult {
  if (options?.from || options?.to || options?.part) return query(source, options);
  const result = check(source, options);
  const s = result.structure;
  return {
    ...result,
    song: s
      ? {
          title: s.settings.title,
          tempo: s.settings.tempo,
          meter: s.settings.meter,
          seed: s.settings.seed.toString(),
          extent: s.extent,
          bars: s.bars,
          sections: s.sections,
          parts: result.parts ?? [],
        }
      : undefined,
  };
}
export type RealizeOptions = CheckOptions & {
  from?: import('@midi-madness/foundation/time').Rational;
  to?: import('@midi-madness/foundation/time').Rational;
  part?: string;
};
export function query(source: string, options: RealizeOptions = {}): RealizationResult {
  const { from: _from, to: _to, part: _part, ...checks } = options;
  const result = realize(source, checks),
    song = result.song;
  if (!song) return result;
  const from = options.from ?? new Rational(0),
    to = options.to ?? song.extent;
  return {
    ...result,
    song: {
      ...song,
      parts: song.parts
        .filter((p) => !options.part || p.name === options.part)
        .map((p) => ({
          ...p,
          events: p.events.filter(
            (e) => e.nominalOnset.compare(to) < 0 && e.nominalOnset.add(e.gate).compare(from) > 0,
          ),
          suppressions: p.suppressions.filter(
            (s) => s.onset.compare(from) >= 0 && s.onset.compare(to) < 0,
          ),
          controls: Object.fromEntries(
            Object.entries(p.controls).map(([n, points]) => [
              n,
              points.filter(
                (point, i) =>
                  point.time.compare(to) < 0 &&
                  (point.time.compare(from) >= 0 ||
                    !points[i + 1] ||
                    points[i + 1].time.compare(from) > 0),
              ),
            ]),
          ),
        })),
    },
  };
}

export { roll, at, metrics, timeAt, musicalDiff } from './inspect.ts';

export { formatSource } from './format.ts';
export { loadScore, IncludeError, provenanceHash, describeSite, originOf } from './include.ts';
export type { LoadedScore, ScoreDependency, LineOrigin, IncludeSite } from './include.ts';

export { SCORE_FORMAT_VERSION } from './ast.ts';
