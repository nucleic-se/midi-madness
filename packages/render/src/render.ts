import {
  preparePerformance,
  performanceClock,
  schedulePartNotes,
  schedulePartHits,
} from './performance-input.ts';
import { scheduleControls } from './schedule-controls.ts';
import type { StageGain } from '../../synth/src/metering.ts';
import { scoreContext } from '../../core/src/score-error.ts';
import { provenanceHash, type LoadedScore, type ScoreDependency } from '../../core/src/include.ts';
import { writeGroupStems } from './group-stems.ts';
import type { Stereo } from '../../synth/src/buses.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Rational as R, timeAt } from '../../core/src/index.ts';
import type { PartIR } from '../../core/src/ir.ts';
import {
  buffers,
  memberPreset,
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
  type DrumEnvelopeRecord,
} from '../../synth/src/drums.ts';
import { busBuffers, renderBuses, type BusEvent } from '../../synth/src/buses.ts';
import { busField } from './fx-score.ts';
import { bindSoftware } from './setup.ts';
import { writeWav, writeAmbisonicWav } from './wav.ts';
import { createAnalysis } from './analysis.ts';
import { createPartStems } from './part-stems.ts';
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
  /** Optional filename prefix for exported part/bus stems. */
  stemPrefix?: string;
  /** Observe the same backend inputs written to the versioned sidecar. */
  capturePerformance?: (data: PerformanceData) => void;
  stemsBy?: 'group' | 'part';
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
  const started = performance.now();
  const { setup, prepared, realized, song } = preparePerformance(source, filename, options);
  const dependencies: ScoreDependency[] = options.score?.files ?? [
    {
      path: resolve(filename),
      hash: createHash('sha256').update(source).digest('hex'),
      kind: 'score',
    },
    ...prepared.dataDependencies.map((d) => ({ ...d, kind: 'data' as const })),
  ];
  const scoreDigest = provenanceHash(dependencies);
  if (prepared.space.output === 'ambisonic' && options.stemsBy)
    throw new RangeError('Stems currently require stereo or binaural output');
  const sr = setup.sampleRate,
    bpm = number(song.tempo),
    secPerWhole = 240 / bpm;
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
  const { offset, last } = performanceClock(song, sr);
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
  const partStems =
    options.stemsBy === 'part' && !options.internalPass
      ? createPartStems(destination, sr, outputFrom, 'part', options.stemPrefix)
      : undefined;
  const partCapture = partStems
    ? { left: new Float32Array(frames), right: new Float32Array(frames) }
    : undefined;
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
    if (partCapture) {
      partCapture.left.fill(0);
      partCapture.right.fill(0);
      memberAudio.partCapture = partCapture;
    }
    if (part.lane) {
      const hits = schedulePartHits(part, position, offset, endSample);
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
          measureFrom: outputFrom,
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
        ...schedulePartNotes(part, binding.preset, prepared, realized, position, offset, endSample),
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
            measureFrom: outputFrom,
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
    if (partStems && partCapture) partStems.member(part.name, partCapture);
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
      measureFrom: outputFrom,
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
    const performanceData = {
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
    } satisfies PerformanceData;
    options.capturePerformance?.(performanceData);
    writePerformanceJson(performancePath, performanceData);
  }
  const busStems = partStems
    ? createPartStems(destination, sr, outputFrom, 'bus', options.stemPrefix)
    : undefined;
  if (busStems) for (const bus of prepared.buses) busStems.member(bus.name, audio.buses![bus.name]);
  const busStemResult = busStems?.finish(outputEnd);
  const partStemResult = partStems?.finish(outputEnd);
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
    partStems: partStemResult,
    busStems: busStemResult,
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
    stageGainMeasurement: {
      fromSample: outputFrom,
      toSample: frames,
      sampleRate: sr,
      description:
        'Unweighted stereo RMS/peak before and after each stage, including insert mix/bypass; bus stages precede return faders/ducking. Includes allocated tail beyond final crop. Silence floor -200 dBFS; gainDb is null if either side is silent. Not LUFS or a constant gain setting.',
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
  const stageText = (stages: StageGain[]) =>
    stages
      .map(
        (s) =>
          `\n  ${s.id} (${s.type}): RMS ${s.input.rmsDb.toFixed(1)} -> ${s.output.rmsDb.toFixed(1)} dBFS, gain ${s.gainDb === null ? 'undefined (silent input/output)' : `${s.gainDb >= 0 ? '+' : ''}${s.gainDb.toFixed(1)} dB`}`,
      )
      .join('');
  const text =
    `${song.title}\n${seconds.toFixed(2)} s · peak ${(20 * Math.log10(Math.max(1e-10, report.peak))).toFixed(2)} dBFS · rendered in ${report.elapsedSeconds.toFixed(2)} s\n` +
    Object.entries(reports)
      .map(
        ([name, p]) =>
          `${name}: ${p.notes} notes, ${p.slides} slides, ${p.accents} accents, peak ${(20 * Math.log10(Math.max(1e-10, p.peak))).toFixed(1)} dBFS` +
          stageText(p.insertStages ?? []),
      )
      .join('\n') +
    '\n' +
    Object.entries(busReports)
      .map(
        ([name, b]) =>
          `Bus ${name}: RMS ${b.rmsDb.toFixed(1)} dBFS, peak ${(20 * Math.log10(Math.max(1e-10, b.peak))).toFixed(1)} dBFS, tail ${b.tailSeconds.toFixed(2)} s` +
          stageText(b.stages),
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
