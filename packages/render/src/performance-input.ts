import { Rational as R, realize, type RealizationResult } from '../../core/src/index.ts';
import type { PartIR, SongIR } from '../../core/src/ir.ts';
import type { LoadedScore } from '../../core/src/include.ts';
import { mapScoreDiagnostic } from '../../core/src/score-diagnostics.ts';
import { ScoreDiagnosticsError } from '../../core/src/score-error.ts';
import { generatedEvents } from '../../core/src/note-generators.ts';
import { configuredPreset } from '../../synth/src/presets.ts';
import { loadSoftwareSetup } from './setup.ts';
import { prepareSoftwareScore, validateSoftwareScore } from './score-settings.ts';
import { softwareWarnings } from './warnings.ts';
import { tuningCents } from './tuning.ts';
import { scheduleNotes } from './notes.ts';

/** Shared compilation for software rendering and hardware-free DAW export. No synthesis. */
export function preparePerformance(
  source: string,
  filename: string,
  options: { setup?: string; score?: LoadedScore } = {},
) {
  const setup = loadSoftwareSetup(options.setup);
  const prepared = prepareSoftwareScore(source, filename);
  const realized = realize(prepared.coreSource, {
    templateContext: prepared.templates,
    deferDeviceExpectations: true,
    parameterDomains: prepared.domains,
    attackLimit: 256,
    attackLimitSeverity: 'warning',
    controlOnlyParts: new Set(Object.keys(prepared.busParts)),
  });
  if (realized.summary.errors || !realized.song)
    throw new ScoreDiagnosticsError(realized.diagnostics);
  if (options.score)
    realized.diagnostics = realized.diagnostics.map((d) => mapScoreDiagnostic(d, options.score!));
  realized.diagnostics = realized.diagnostics.filter(
    (d) => !(d.code === 'P001' && d.message.includes('fxbus__')),
  );
  validateSoftwareScore(realized.song, prepared);
  realized.diagnostics.push(
    ...softwareWarnings(
      realized,
      setup,
      prepared.sounds,
      prepared.presetOverrides,
      prepared.tuning,
    ),
  );
  const song = realized.song;
  const secPerWhole = 240 / song.tempo.toNumber();
  for (const part of song.parts)
    part.events = part.events.flatMap((e) => generatedEvents(e, secPerWhole, song.seed));
  return { setup, prepared, realized, song };
}

/** Same sample grid and 10 ms preroll allocation for render and export. */
export function performanceClock(song: SongIR, sr: number) {
  const position = (r: R) => Math.round(r.toNumber() * (240 / song.tempo.toNumber()) * sr);
  let minSample = 0,
    last = position(song.extent);
  for (const part of song.parts)
    for (const e of part.events) {
      minSample = Math.min(minSample, position(e.performedOnset));
      last = Math.max(last, position(e.performedOnset.add(e.gate)));
    }
  const offset = Math.ceil(-minSample / (sr * 0.01)) * Math.round(sr * 0.01);
  return { position, offset, last };
}
export function schedulePartHits(
  part: PartIR,
  position: (r: R) => number,
  offset: number,
  end: number,
) {
  return part.events
    .filter((e) => e.velocity > 0 && position(e.performedOnset) < end)
    .map((e) => ({
      sample: position(e.performedOnset) + offset,
      velocity: e.velocity,
      locks: e.locks,
    }))
    .sort((a, b) => a.sample - b.sample);
}
export function schedulePartNotes(
  part: PartIR,
  preset: string,
  prepared: ReturnType<typeof prepareSoftwareScore>,
  realized: RealizationResult,
  position: (r: R) => number,
  offset: number,
  end: number,
) {
  return scheduleNotes(
    part,
    configuredPreset(preset, prepared.presetOverrides[part.name]).mono,
    position,
    offset,
    end,
    (e) =>
      tuningCents(
        prepared.tuning,
        e.pitch!,
        realized.harmony?.chordAt(e.nominalOnset).root ?? null,
      ),
  );
}
