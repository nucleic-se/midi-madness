import { ScoreDiagnosticsError, scoreContext } from '../../core/src/score-error.ts';
import { mapScoreDiagnostic } from '../../core/src/score-diagnostics.ts';
import { provenanceHash, type LoadedScore, type ScoreDependency } from '../../core/src/include.ts';
import { writeGroupStems } from './group-stems.ts';
import type { Stereo } from '../../synth/src/buses.ts';
import { generatedEvents } from '../../core/src/note-generators.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Rational as R, realize, timeAt, type RealizationResult } from '../../core/src/index.ts';
import type { PartIR } from '../../core/src/ir.ts';
import {
  buffers,
  memberPreset,
  voiceControl,
  renderMember,
  seedHash,
  type SynthEvent,
  type MemberReport,
  type EnvelopeRecord,
} from '../../synth/src/engine.ts';
import {
  defaultDrumPan,
  drumLaneModel,
  renderDrum,
  type DrumControl,
  type DrumEnvelopeRecord,
} from '../../synth/src/drums.ts';
import { busBuffers, renderBuses, type BusEvent } from '../../synth/src/buses.ts';
import { busField } from './fx-score.ts';
import { configuredPreset } from '../../synth/src/presets.ts';
import { loadSoftwareSetup, bindSoftware, type SoftwareSetup } from './setup.ts';
import { writeWav, writeAmbisonicWav } from './wav.ts';
import { scheduleNotes } from './notes.ts';
import {
  prepareSoftwareScore,
  validateSoftwareScore,
  modulationDomains,
} from './score-settings.ts';
import { fastShapeControl, constantControl } from './shape-rate.ts';
import { tuningCents } from './tuning.ts';
import { createAnalysis } from './analysis.ts';
import { softwareWarnings } from './warnings.ts';
import { soundDomains } from './sounds.ts';
import { rendererHash } from './fingerprint.ts';
import {
  writePerformanceJson,
  type PerformanceData,
  type PerformanceTrack,
} from './performance.ts';
import {
  listenerLanes,
  listenerPart,
  listenerMarker,
  partFrame,
  positionLanes,
  worldDomains,
} from './world-score.ts';
const number = (r: R) => Number(r.numerator) / Number(r.denominator);
export type RenderOptions = {
  /** Dependency provenance supplied by file-reading entry points. */
  score?: LoadedScore;
  stemsBy?: 'group';
  /** Internal stem passes share the parent timeline and do not write files. */
  internalGroup?: string;
  internalPass?: boolean;
  captureAudio?: (audio: Stereo) => void;
  setup?: string;
  out?: string;
  from?: string;
  bars?: string;
  noAnalysis?: boolean;
  analysis?: boolean;
  solo?: string;
  mute?: string;
  tail?: number;
  progress?: (text: string) => void;
};
export function renderSong(source: string, filename: string, options: RenderOptions = {}) {
  const fingerprint = rendererHash(options.setup);
  const started = performance.now(),
    setup = loadSoftwareSetup(options.setup);
  const prepared = prepareSoftwareScore(source, filename);
  const dependencies: ScoreDependency[] = options.score?.files ?? [
    {
      path: resolve(filename),
      hash: createHash('sha256').update(source).digest('hex'),
      kind: 'score',
    },
    ...prepared.dataDependencies.map((d) => ({ ...d, kind: 'data' as const })),
  ];
  const scoreDigest = provenanceHash(dependencies);
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
  if (prepared.space.output === 'ambisonic' && options.stemsBy)
    throw new RangeError('Grouped stems currently require stereo or binaural output');
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
  const song = realized.song,
    sr = setup.sampleRate,
    bpm = number(song.tempo),
    secPerWhole = 240 / bpm;
  for (const part of song.parts) {
    part.events = part.events.flatMap((e) => generatedEvents(e, secPerWhole, song.seed));
  }
  const position = (r: R) => Math.round(number(r) * secPerWhole * sr);
  const members = song.parts.filter((p) => !(p.name in prepared.busParts));
  const selected = (text?: string) =>
    text
      ? text
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const solo = selected(options.solo),
    mute = selected(options.mute);
  for (const name of [...solo, ...mute])
    if (!members.some((p) => p.name === name))
      throw new RangeError(
        `Unknown member ${name}; available: ${members.map((p) => p.name).join(', ')}`,
      );
  const included = new Set(
    members
      .filter((p) => (!solo.length || solo.includes(p.name)) && !mute.includes(p.name))
      .map((p) => p.name),
  );
  let minSample = 0,
    last = position(song.extent);
  for (const part of song.parts)
    for (const e of part.events) {
      minSample = Math.min(minSample, position(e.performedOnset));
      last = Math.max(last, position(e.performedOnset.add(e.gate)));
    }
  const offset = Math.ceil(-minSample / (sr * 0.01)) * Math.round(sr * 0.01);
  const allCuts = prepared.cutBefore
    .flatMap((c) =>
      song.sections
        .filter((s) => c.sections.includes(s.name) || c.sections.includes(s.sectionName ?? ''))
        .map((s) => Math.max(0, position(s.onset) + offset - Math.round(c.seconds * sr))),
    )
    .sort((a, b) => a - b);
  const fromR = options.from
    ? /^\d+$/.test(options.from)
      ? timeAt(song, options.from, true)
      : (song.sections.find((s) => s.name === options.from || s.label === options.from)?.onset ??
        timeAt(song, options.from))
    : new R(0);
  const bars = options.bars === undefined ? undefined : Number(options.bars);
  if (bars !== undefined && (!Number.isInteger(bars) || bars < 1))
    throw new RangeError('--bars must be a positive integer');
  const toR = bars === undefined ? song.extent : fromR.add(new R(...song.meter).mul(new R(bars)));
  if (fromR.compare(new R(0)) < 0 || fromR.compare(song.extent) >= 0)
    throw new RangeError('Excerpt starts outside the song');
  const endSample = Math.min(last, position(toR)),
    frames = offset + endSample + Math.round(sr * (options.tail ?? 12));
  const cuts = allCuts.filter((s) => s <= offset + endSample);
  const destination = options.out
    ? resolve(options.out)
    : resolve('renders', basename(filename, '.mm'), 'mix.wav');
  mkdirSync(dirname(destination), { recursive: true });
  const outputFrom = options.from ? offset + position(fromR) : 0;
  const sections = song.sections.map((s) => ({
    name: `${s.name} (${s.path})`,
    from: position(s.onset) + offset,
    to: position(s.onset.add(s.extent)) + offset,
  }));
  const barRegions = song.bars
    .filter((b) => position(b.onset.add(b.span)) > outputFrom && position(b.onset) < endSample)
    .map((b) => ({
      name: `bar ${b.number}`,
      from: Math.max(outputFrom, position(b.onset) + offset),
      to: Math.min(endSample + offset, position(b.onset.add(b.span)) + offset),
    }));
  const analysis =
    options.analysis && !options.noAnalysis
      ? createAnalysis(
          destination,
          sr,
          outputFrom,
          sections
            .filter((s) => s.to > outputFrom && s.from < endSample + offset)
            .map((s) => ({
              ...s,
              from: Math.max(outputFrom, s.from),
              to: Math.min(endSample + offset, s.to),
            })),
          barRegions,
        )
      : undefined;
  const audio = buffers(frames),
    reports: Record<string, MemberReport & { preset: string; lane?: string }> = {};
  if (prepared.space.output === 'ambisonic')
    audio.ambisonic = Array.from({ length: 4 }, () => new Float32Array(frames));
  audio.buses = busBuffers(prepared.buses, frames);
  const busControls: Record<string, BusEvent[]> = {};
  const performanceTracks: PerformanceTrack[] = [];
  if (options.internalGroup !== undefined)
    for (const part of song.parts)
      part.events = part.events.filter((e) => (e.group ?? part.name) === options.internalGroup);
  const hats = song.parts
    .filter((p) => p.lane === 'hat')
    .filter((p) => included.has(p.name))
    .flatMap((p) =>
      p.events
        .filter((e) => e.velocity > 0 && position(e.performedOnset) < endSample)
        .map((e) => position(e.performedOnset) + offset),
    )
    .sort((a, b) => a - b);
  const laneArgs = [realized, position, offset, endSample, sr, bpm] as const;
  const listener = listenerLanes(
    song.parts.find((p) => p.name === listenerPart),
    ...laneArgs,
  );
  for (const part of song.parts) {
    if (prepared.busParts[part.name] === listenerMarker) continue;
    if (part.name in prepared.busParts) {
      const name = prepared.busParts[part.name],
        bus = prepared.buses.find((b) => b.name === name)!;
      busControls[name] = scheduleControls(
        realized,
        part,
        position,
        offset,
        endSample,
        sr,
        bpm,
        prepared.domains[part.name],
      )
        .filter((e) => e.sample < position(song.extent) + offset)
        .map((e) => ({ ...busField(bus, e.name), sample: e.sample, value: e.value }));
      continue;
    }
    if (!included.has(part.name)) continue;
    const binding = scoreContext(
        prepared.partSpans[part.name] ?? { line: 1, col: 1, endLine: 1, endCol: 1 },
        () =>
          bindSoftware(
            setup,
            part,
            prepared.sounds[part.name],
            prepared.presetOverrides[part.name],
          ),
      ),
      seed = seedHash(`${song.seed}/${part.name}`);
    options.progress?.(`Rendering ${part.name}`);
    const frame = partFrame(part);
    const world =
      frame === 'world' ? { position: positionLanes(part, ...laneArgs), listener } : undefined;
    // World positions travel as lanes, evaluated per sample, rather than as set events.
    const controls = scheduleControls(
      realized,
      part,
      position,
      offset,
      endSample,
      sr,
      bpm,
      prepared.domains[part.name],
    ).filter((e) => !(world && e.name in worldDomains));
    const space: PerformanceTrack['space'] = world
      ? { frame: 'world', position: world.position }
      : { frame: 'listener' };
    const memberAudio = analysis
      ? { ...audio, left: new Float32Array(frames), right: new Float32Array(frames) }
      : audio;
    if (part.lane) {
      const hits = part.events
        .filter((e) => e.velocity > 0 && position(e.performedOnset) < endSample)
        .map((e) => ({
          sample: position(e.performedOnset) + offset,
          velocity: e.velocity,
          locks: e.locks,
        }))
        .sort((a, b) => a.sample - b.sample);
      const drumControls = controls.map((e) => ({
        sample: e.sample,
        name: e.name,
        value: e.value,
      }));
      const drumEnvelopes: DrumEnvelopeRecord[] = [];
      performanceTracks.push({
        name: part.name,
        kind: part.kind,
        role: part.role,
        preset: '808-909',
        lane: part.lane,
        seed,
        mix: binding.mix,
        initialControls: { pan: defaultDrumPan(part.lane) },
        space,
        resolved: drumLaneModel(part.lane),
        envelopes: drumEnvelopes,
        hits,
        controls: drumControls,
      });
      reports[part.name] = {
        ...renderDrum(part.lane, hits, drumControls, hats, sr, seed, memberAudio, {
          inserts: prepared.inserts[part.name],
          cuts,
          offset,
          space: prepared.space,
          world,
          envelopes: drumEnvelopes,
        }),
        preset: '808-909',
        lane: part.lane,
      };
    } else {
      const events: SynthEvent[] = [
        ...controls,
        ...scheduleNotes(
          part,
          configuredPreset(binding.preset, prepared.presetOverrides[part.name]).mono,
          position,
          offset,
          endSample,
          (e) =>
            tuningCents(
              prepared.tuning,
              e.pitch!,
              realized.harmony?.chordAt(e.nominalOnset).root ?? null,
            ),
        ),
      ];
      const order = { set: 0, off: 1, on: 2 };
      events.sort((a, b) => a.sample - b.sample || order[a.type] - order[b.type]);
      const grainCapacity = part.events.some((e) => e.grain) ? 256 : undefined;
      const envelopes: EnvelopeRecord[] = [];
      performanceTracks.push({
        name: part.name,
        kind: part.kind,
        role: part.role,
        preset: binding.preset,
        seed,
        mix: binding.mix,
        space,
        resolved: memberPreset(binding.preset, prepared.presetOverrides[part.name], grainCapacity),
        envelopes,
        events,
      });
      reports[part.name] = {
        ...renderMember(
          part.name,
          binding.preset,
          binding.mix,
          events,
          sr,
          seed,
          memberAudio,
          offset,
          {
            inserts: prepared.inserts[part.name],
            cuts,
            preset: prepared.presetOverrides[part.name],
            space: prepared.space,
            grainCapacity,
            world,
            envelopes,
          },
        ),
        preset: binding.preset,
      };
    }
    if (analysis) {
      analysis.member(part.name, memberAudio);
      for (let i = 0; i < frames; i++) {
        audio.left[i] += memberAudio.left[i];
        audio.right[i] += memberAudio.right[i];
      }
    }
  }
  const spatialDry = audio.ambisonic
    ? { left: audio.left.slice(), right: audio.right.slice() }
    : undefined;
  options.progress?.('Rendering effect buses');
  const mix = renderBuses(
    audio,
    prepared.buses,
    busControls,
    sr,
    song.sections.map((s) => ({
      name: s.name,
      from: position(s.onset) + offset,
      to: position(s.onset.add(s.extent)) + offset,
    })),
    offset + endSample,
    {
      cuts,
      triggers: Object.fromEntries(
        members
          .filter((p) => included.has(p.name))
          .map((p) => [
            p.name,
            p.events
              .filter((e) => e.velocity > 0 && position(e.performedOnset) < endSample)
              .map((e) => ({ sample: position(e.performedOnset) + offset, velocity: e.velocity }))
              .sort((a, b) => a.sample - b.sample),
          ]),
      ),
    },
  );
  let spatialPeak: number | undefined;
  if (audio.ambisonic && spatialDry) {
    spatialPeak = 0;
    for (let i = 0; i < frames; i++) {
      // Bus returns are diffuse (omnidirectional); directional dry voices retain Y,Z,X.
      audio.ambisonic[0][i] +=
        (audio.left[i] + audio.right[i] - (spatialDry.left[i] + spatialDry.right[i])) *
        Math.SQRT1_2;
      const peak = Math.max(...audio.ambisonic.map((c) => Math.abs(c[i])));
      const gain = Math.min(1, 0.95 / Math.max(1e-12, peak));
      for (const channel of audio.ambisonic) channel[i] *= gain;
      spatialPeak = Math.max(spatialPeak, peak * gain);
    }
  }
  // All frames are already rendered: retain late echoes across quiet gaps.
  let lastAudible = offset + endSample - 1;
  for (let i = offset + endSample; i < frames; i++)
    if (
      Math.max(
        Math.abs(audio.left[i]),
        Math.abs(audio.right[i]),
        mix.tailPeak[i],
        ...(audio.ambisonic?.map((c) => Math.abs(c[i])) ?? []),
      ) >= 0.0000316228
    )
      lastAudible = i;
  const outputEnd = mix.pendingAtLimit
    ? frames
    : Math.min(frames, Math.max(offset + endSample, lastAudible + 1) + Math.round(sr * 0.2));
  options.captureAudio?.(audio);
  let groupStems: ReturnType<typeof writeGroupStems> | undefined;
  if (options.stemsBy === 'group' && !options.internalPass) {
    const names = [
      ...new Set(
        members
          .filter((p) => included.has(p.name))
          .flatMap((p) => p.events.map((e) => e.group ?? p.name)),
      ),
    ];
    const groups = new Map<string, Stereo>();
    for (const name of names) {
      options.progress?.(`Rendering stem group ${name}`);
      renderSong(source, filename, {
        ...options,
        stemsBy: undefined,
        analysis: false,
        noAnalysis: true,
        internalPass: true,
        internalGroup: name,
        captureAudio: (audio) => {
          groups.set(name, audio);
        },
      });
    }
    groupStems = writeGroupStems(destination, audio, groups, sr, outputFrom, outputEnd);
  }
  // Retire old provenance before replacing audio, including report-free renders
  // and failures during WAV writing or analysis.
  const performancePath = destination.replace(/\.[^/.]+$/, '') + '.events.json';
  if (!options.internalPass)
    for (const name of ['report.json', 'report.txt'])
      rmSync(resolve(dirname(destination), name), { force: true });
  if (!options.internalPass) {
    // Never leave old performance data beside newly replaced or failed audio.
    rmSync(performancePath, { force: true });
    if (audio.ambisonic) writeAmbisonicWav(destination, audio.ambisonic, sr, outputFrom, outputEnd);
    else writeWav(destination, audio.left, audio.right, sr, outputFrom, outputEnd);
    writePerformanceJson(performancePath, {
      format: 'midi-madness-performance',
      version: 1,
      title: song.title,
      tempoBpm: bpm,
      meter: song.meter,
      seed: song.seed,
      scoreHash: scoreDigest,
      rendererHash: fingerprint,
      // All backend event samples are retained verbatim. WAV time = (sample - originSample) / sampleRate.
      audio: {
        file: basename(destination),
        sampleRate: sr,
        originSample: outputFrom,
        frames: outputEnd - outputFrom,
        scoreOffsetSample: offset,
        channels: audio.ambisonic ? 4 : 2,
      },
      world: {
        version: 1,
        units: 'm',
        axes: '+x right, +y up, -z forward; yaw degrees clockwise from above toward +x; pitch degrees up',
        listener,
      },
      tracks: performanceTracks,
      buses: prepared.buses,
      busControls,
      hats,
      settings: {
        inserts: prepared.inserts,
        presetOverrides: prepared.presetOverrides,
        tuning: prepared.tuning,
        space: prepared.space,
        cuts,
      },
      selection: { solo, mute, members: [...included] },
      // Generated core events plus bars/sections retain score intent alongside synth articulation.
      score: song,
    } satisfies PerformanceData);
  }
  const analysisResult = analysis?.finish(audio, outputEnd, song.title);
  const warnings = Object.entries(reports).flatMap(([name, p]) => [
    ...(p.notes && p.peak < 0.000001 ? [`${name}: scheduled notes rendered silent`] : []),
    ...p.ignored.map((c) => `${name}: ignored parameter ${c}`),
  ]);
  warnings.push(...mix.warnings);
  const diagnosticCounts = new Map<string, { text: string; count: number }>();
  for (const d of realized.diagnostics)
    if (d.severity === 'warning' || d.code === 'P004') {
      const part = d.path?.split('/form/')[0] ?? 'score';
      const key = `${d.code}/${part}/${d.message}`;
      const item = diagnosticCounts.get(key);
      if (item) item.count++;
      else
        diagnosticCounts.set(key, {
          text: `${d.code} ${part}: ${d.message}${d.code === 'P004' ? '; set role or range explicitly to keep the intended register' : ''}`,
          count: 1,
        });
    }
  warnings.push(
    ...[...diagnosticCounts.values()].map(
      (d) => d.text + (d.count > 1 ? ` (${d.count} occurrences)` : ''),
    ),
  );
  const busReports = Object.fromEntries(
    Object.entries(mix.reports).filter(
      ([name, b]) =>
        b.peak > 1e-10 ||
        !['room', 'echo'].includes(name) ||
        prepared.buses.find((bus) => bus.name === name)?.explicit,
    ),
  );
  if (
    outputEnd === frames &&
    Math.max(Math.abs(audio.left[frames - 1]), Math.abs(audio.right[frames - 1])) > 0.001
  )
    warnings.push('Tail limit reached while audio remained above -60 dBFS');
  const seconds = (outputEnd - outputFrom) / sr;
  const report = {
    space: prepared.space,
    groupStems,
    engine: 'band-draft-0.4',
    rendererHash: fingerprint,
    fullRender: !options.from && !options.bars && !options.solo && !options.mute,
    selection: { solo, mute, members: [...included] },
    inserts: prepared.inserts,
    presetOverrides: prepared.presetOverrides,
    tuning: prepared.tuning,
    fxCuts: cuts.map((s) => s / sr),
    analysis: analysisResult,
    source: resolve(filename),
    dataDependencies: prepared.dataDependencies,
    dependencies,
    scoreHash: scoreDigest,
    seed: song.seed,
    sampleRate: sr,
    durationSeconds: seconds,
    peak: spatialPeak ?? mix.peak,
    channels: audio.ambisonic ? 4 : 2,
    preLimiterPeak: mix.beforePeak,
    timeline: {
      prerollSec: offset / sr,
      bar1Sample: options.from ? null : offset,
      from: fromR.toString(),
    },
    members: reports,
    buses: busReports,
    effectGraph: prepared.buses,
    suspicions: Object.entries(busReports)
      .filter(([, b]) => b.lowStereoRatio > 0.1)
      .map(
        ([name, b]) =>
          `Bus ${name}: substantial low-frequency stereo energy (${Math.round(b.lowStereoRatio * 100)}% of return energy); may be intentional`,
      ),
    limiterSamples: mix.limitedSamples,
    safety: {
      kind: 'instantaneous stereo-linked peak clamp',
      ceiling: 0.95,
      reducedSamples: mix.limitedSamples,
    },
    warnings,
    elapsedSeconds: (performance.now() - started) / 1000,
    automationHz: { base: 250, fastShapes: 3000 },
    echo: prepared.echo,
    diagnostics: realized.diagnostics,
    draft: true,
  };
  const text =
    `${song.title}\n${seconds.toFixed(2)} s · peak ${(20 * Math.log10(Math.max(1e-10, report.peak))).toFixed(2)} dBFS · rendered in ${report.elapsedSeconds.toFixed(2)} s\n` +
    Object.entries(reports)
      .map(
        ([name, p]) =>
          `${name}: ${p.notes} notes, ${p.slides} slides, ${p.accents} accents, peak ${(20 * Math.log10(Math.max(1e-10, p.peak))).toFixed(1)} dBFS`,
      )
      .join('\n') +
    '\n' +
    Object.entries(busReports)
      .map(
        ([name, b]) =>
          `Bus ${name}: RMS ${b.rmsDb.toFixed(1)} dBFS, peak ${(20 * Math.log10(Math.max(1e-10, b.peak))).toFixed(1)} dBFS, tail ${b.tailSeconds.toFixed(2)} s`,
      )
      .join('\n') +
    `\nMaster safety ceiling (instantaneous peak clamp): ${mix.limitedSamples} samples reduced\n` +
    report.suspicions.join('\n') +
    '\n' +
    (warnings.length ? warnings.join('\n') : 'No silent members or ignored controls.') +
    (analysisResult ? `\nAnalysis: ${analysisResult.page}` : '') +
    '\n';
  if (!options.noAnalysis && !options.internalPass) {
    writeFileSync(
      resolve(dirname(destination), 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    writeFileSync(resolve(dirname(destination), 'report.txt'), text);
  }
  return {
    destination,
    performancePath: options.internalPass ? undefined : performancePath,
    report,
    text,
  };
}
function scheduleControls(
  realized: RealizationResult,
  part: PartIR,
  position: (r: R) => number,
  offset: number,
  endSample: number,
  sr: number,
  bpm: number,
  domains: Record<string, readonly [number, number, string?]> = {},
): (SynthEvent & { type: 'set' })[] {
  const out: (SynthEvent & { type: 'set' })[] = [],
    auto = realized.automation,
    formEnd = position(realized.song!.extent);
  for (const [name, points] of Object.entries(part.controls)) {
    if (name === 'cents') continue;
    // Fast shapes get a 3 kHz grid, including streams that alias to a constant in the coarse IR.
    const fast = fastShapeControl(realized, part.name, name, bpm);
    const phaseAnchor =
      ['lfo.rate', 'lfo.hz'].includes(name) && constantControl(realized, part.name, name);
    const memberPoints =
      name === 'pan' || name.startsWith('send.') || voiceControl(name)
        ? points.filter((p) => !p.source.startsWith('lock:'))
        : points;
    const distinct = new Set(
      memberPoints.filter((p) => p.source.startsWith('expression')).map((p) => p.value),
    );
    if (!auto || (distinct.size <= 1 && !fast && constantControl(realized, part.name, name))) {
      for (const p of memberPoints)
        if (position(p.time) < formEnd && position(p.time) <= endSample)
          out.push({ sample: position(p.time) + offset, type: 'set', name, value: p.value });
      continue;
    }
    const times = new Set<number>(points.map((p) => position(p.time)));
    for (const t of auto.boundaries(part.name, name)) times.add(position(t));
    const stride = Math.round(sr / (fast ? 3000 : 250));
    for (let sample = 0; sample <= endSample; sample += stride) times.add(sample);
    const locks = (
      name === 'pan' || name.startsWith('send.') || voiceControl(name) ? [] : part.events
    )
      .filter((e) => e.locks[name] !== undefined)
      .sort((a, b) => a.nominalOnset.compare(b.nominalOnset));
    let last: number | null | undefined;
    for (const sample of [...times]
      .filter((t) => t <= endSample && t < formEnd)
      .sort((a, b) => a - b)) {
      const time = new R(
        BigInt(sample) * realized.song!.tempo.numerator,
        BigInt(sr * 240) * realized.song!.tempo.denominator,
      );
      let v = auto.at(part.name, name, time);
      const lock = locks.findLast(
        (e) => time.compare(e.nominalOnset) >= 0 && time.compare(e.nominalOnset.add(e.gate)) < 0,
      );
      if (lock) v = lock.locks[name];
      const domain = domains[name] ?? preparedDomain(name);
      const value = v === undefined ? null : Math.max(domain[0], Math.min(domain[1], v));
      if (
        value !== last &&
        (value === null || last === null || last === undefined || Math.abs(value - last) > 0.0001)
      ) {
        out.push({
          sample: sample + offset,
          type: 'set',
          name,
          value,
          phaseAnchor,
        });
        last = value;
      }
    }
  }
  return out.sort((a, b) => a.sample - b.sample);
}

function preparedDomain(name: string): readonly [number, number] {
  if (name in worldDomains) return worldDomains[name as keyof typeof worldDomains];
  if (name === 'space.az') return [-180, 180];
  if (name === 'space.el') return [-90, 90];
  if (name === 'space.dist') return [0.1, 100];
  if (name.endsWith('.feedback')) return [-0.95, 0.98];
  return (
    soundDomains[name] ??
    modulationDomains[name] ??
    (['pan', 'bend', 'envamount', 'tune'].includes(name) ? [-1, 1] : [0, 1])
  );
}
