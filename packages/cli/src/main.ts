import { scoreContext } from '../../core/src/score-error.ts';
import { ScoreDiagnosticsError, ScoreError } from '../../core/src/score-error.ts';
import { engine } from './version.ts';
import { mapScoreDiagnostic } from '../../core/src/score-diagnostics.ts';
import { loadScore, IncludeError, type LoadedScore } from '../../core/src/include.ts';
import { encode, quantize } from '../../midi/src/controls.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import { articulation, sharedChannels, portMetrics } from '../../midi/src/inspect.ts';
import { compileMidi } from '../../midi/src/compile.ts';
import { implicitRig } from '../../midi/src/config.ts';
import { compileNotes, tick } from '../../midi/src/notes.ts';
import { writeMidi } from '../../midi/src/smf.ts';
import { loadRig, domains, rigSummary } from './commands/setup.ts';
import {
  accept,
  accepted,
  revisionSource,
  digests,
  hash,
  frozenSource,
} from './commands/snapshot.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  check,
  realize,
  query,
  roll,
  at,
  metrics,
  timeAt,
  musicalDiff,
  formatSource,
} from '../../core/src/index.ts';
import { curveAt } from '../../core/src/curves.ts';
import { harmonyRoll, positionAt, noteName } from '../../core/src/inspect.ts';
import { diagnostic, summary, type Diagnostic } from '../../core/src/diag.ts';
import { help, schema } from './commands/help.ts';
const args = process.argv.slice(2),
  command = args[0] ?? '',
  file = ['ports', 'panic'].includes(command) ? '' : (args[1] ?? ''),
  json = args.includes('--json'),
  quiet = args.includes('--quiet');
const commands = [
  'check',
  'expand',
  'roll',
  'explain',
  'at',
  'metrics',
  'query',
  'help',
  'schema',
  'fix',
  'accept',
  'diff',
  'format',
  'export',
  'render',
  'video',
  'pack',
  'ports',
  'play',
  'panic',
  'feedback',
];
const valueFlags = new Set([
  '--part',
  '--bars',
  '--bar',
  '--from',
  '--to',
  '--since',
  '--setup',
  '--midi',
  '--midi-dir',
  '--bend-range',
  '--clock',
  '--out',
  '--tail',
  '--width',
  '--height',
  '--fps',
  '--stems-by',
  '--events-envelopes',
  '--events-parts',
  '--warmup-bars',
  '--solo',
  '--mute',
  '--at',
]);
const allowed = new Set([
  ...valueFlags,
  '--json',
  '--quiet',
  '--loop',
  '--all',
  '--no-analysis',
  '--analysis',
  '--harmony',
  '--positions',
  '--cc',
  '--preview',
]);
const commandFlags: Record<string, readonly string[]> = {
  check: ['--setup'],
  expand: ['--to'],
  roll: ['--setup', '--part', '--bars', '--harmony'],
  explain: ['--setup', '--part', '--bar', '--positions'],
  at: ['--setup'],
  metrics: ['--setup', '--all'],
  query: ['--setup', '--part', '--from', '--to'],
  help: file === 'alias' ? ['--setup'] : [],
  schema: [],
  fix: ['--setup'],
  accept: ['--setup'],
  diff: ['--setup', '--since'],
  format: ['--setup'],
  export: ['--setup', '--midi', '--midi-dir', '--cc', '--bend-range'],
  pack: ['--setup', '--out', '--tail', '--cc', '--bend-range'],
  video: ['--setup', '--from', '--bars', '--out', '--tail', '--width', '--height', '--fps'],
  render: [
    '--setup',
    '--from',
    '--bars',
    '--out',
    '--tail',
    '--solo',
    '--mute',
    '--stems-by',
    '--events-envelopes',
    '--events-parts',
    '--preview',
    '--warmup-bars',
    '--analysis',
    '--no-analysis',
  ],
  ports: [],
  play: ['--setup', '--from', '--bars', '--loop', '--clock'],
  panic: ['--setup'],
  feedback: ['--at'],
};
function validateOptions() {
  const supported = new Set(['--json', '--quiet', ...(commandFlags[command] ?? [])]);
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (!flag.startsWith('--')) continue;
    if (!allowed.has(flag)) throw new RangeError(`Unknown option ${flag}`);
    if (!supported.has(flag)) throw new RangeError(`${flag} is not supported by ${command}`);
    if (seen.has(flag)) throw new RangeError(`Duplicate option ${flag}`);
    seen.add(flag);
    if (valueFlags.has(flag)) {
      if (!args[i + 1] || args[i + 1].startsWith('--'))
        throw new RangeError(`Missing value for ${flag}`);
      i++;
    }
  }
  if (command === 'render') {
    if (args.includes('--preview') && (!option('--from') || !option('--bars')))
      throw new RangeError('--preview requires --from and --bars');
    if (option('--warmup-bars') !== undefined) {
      if (!args.includes('--preview')) throw new RangeError('--warmup-bars requires --preview');
      const value = Number(option('--warmup-bars'));
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError('--warmup-bars must be a nonnegative safe integer');
    }
  }
  if (command === 'expand' && option('--to') && option('--to') !== 'section')
    throw new RangeError('--to supports section');
  if (option('--clock') && !['send', 'off'].includes(option('--clock')!))
    throw new RangeError('--clock must be send or off');
  if (['render', 'pack', 'video'].includes(command)) {
    if (option('--events-envelopes') && !['full', 'none'].includes(option('--events-envelopes')!))
      throw new RangeError('--events-envelopes must be full or none');
    if (
      option('--events-parts') !== undefined &&
      option('--events-parts')!
        .split(',')
        .some((name) => !name.trim())
    )
      throw new RangeError('--events-parts must be a nonempty comma-separated list of part names');
    const tail = option('--tail');
    if (
      tail !== undefined &&
      (!Number.isFinite(Number(tail)) || Number(tail) < 0 || Number(tail) > 120)
    )
      throw new RangeError('--tail must be 0..120 seconds');
    if (option('--stems-by') && !['group', 'part'].includes(option('--stems-by')!))
      throw new RangeError('--stems-by supports group or part');
    if (option('--bars') && !/^[1-9]\d*$/.test(option('--bars')!))
      throw new RangeError('--bars must be a positive integer');
  }
  if (
    ['play', 'roll'].includes(command) &&
    option('--bars') &&
    !/^[1-9]\d*(?:\.\.[1-9]\d*)?$/.test(option('--bars')!)
  )
    throw new RangeError('--bars must be a bar number or A..B range');
  if (['play', 'roll'].includes(command) && option('--bars')) {
    const [first, last] = option('--bars')!.split('..').map(Number);
    if (last !== undefined && last < first)
      throw new RangeError('--bars range ends before it starts');
  }
  if (option('--bar') && !/^[1-9]\d*$/.test(option('--bar')!))
    throw new RangeError('--bar must be a positive integer');
  if (command === 'play' && option('--from') && option('--bars'))
    throw new RangeError('Use either --from or --bars for playback');
}
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0
    ? undefined
    : ['--from', '--at'].includes(name) && args[index + 1] === 'bar'
      ? `bar ${args[index + 2]}`
      : args[index + 1];
}
let loadedScore: LoadedScore | undefined;
let validationTarget: 'core' | 'software' | 'midi' = 'core';
function output(result: unknown, diagnostics: Diagnostic[] = [], source = '', human?: string) {
  diagnostics = diagnostics.map((d) => {
    const mapped = loadedScore ? mapScoreDiagnostic(d, loadedScore) : d;
    return mapped.file === loadedScore?.files[0].path
      ? { ...mapped, file, span: { ...mapped.span, file } }
      : mapped;
  });
  if (command === 'check' && loadedScore && result && typeof result === 'object') {
    result = {
      ...result,
      validation: {
        target: validationTarget,
        software: validationTarget === 'software',
      },
      dependencies: loadedScore.files,
      scoreHash: loadedScore.hash,
    };
  }
  const grouped = new Map<string, Diagnostic>();
  for (const d of diagnostics) {
    const adaptation = ['D002', 'D003'].includes(d.code),
      key = adaptation ? `${d.code}/${d.path?.split('/form/')[0]}/${d.message}` : JSON.stringify(d);
    const prior = grouped.get(key);
    if (prior && adaptation)
      prior.measured = {
        ...prior.measured,
        count: Number(prior.measured?.count ?? 1) + Number(d.measured?.count ?? 1),
      };
    else if (!prior)
      grouped.set(key, {
        ...d,
        path: adaptation ? d.path?.split('/form/')[0] : d.path,
        measured: d.measured ? { ...d.measured } : undefined,
      });
  }
  diagnostics = [...grouped.values()];
  const counts = summary(diagnostics);
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: '1',
          command,
          file,
          engine,
          result,
          diagnostics: diagnostics.map((d) => ({ ...d, file: d.file ?? file })),
          summary: counts,
        },
        (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      ),
    );
    return;
  }
  for (const d of diagnostics) {
    console.log(
      `${d.severity}[${d.code}]: ${d.message}\n  --> ${d.file ?? file}:${d.span.line}:${d.span.col}${d.path ? ` (${d.path})` : ''}${(d.includedFrom ?? []).map((p) => `, included from ${p.file}:${p.line}`).join('')}`,
    );
    let diagnosticSource = source;
    if (d.file)
      try {
        diagnosticSource = readFileSync(d.file, 'utf8');
      } catch {
        diagnosticSource = '';
      }
    const line = diagnosticSource.split('\n')[d.span.line - 1];
    if (line !== undefined)
      console.log(
        ` ${d.span.line} | ${line}\n   | ${' '.repeat(Math.max(0, d.span.col - 1))}${'^'.repeat(Math.max(1, d.span.endLine === d.span.line ? d.span.endCol - d.span.col : line.length - d.span.col + 2))}`,
      );
    if (d.measured) console.log(`   = measured: ${JSON.stringify(d.measured)}`);
    for (const fix of d.fixes)
      console.log(
        `   = fix: ${fix.title}${fix.edits.length === 1 ? ` → ${fix.edits[0].insert}` : ''}`,
      );
    console.log(`   = help: mm help ${d.help}`);
  }
  if (!quiet) {
    if (human) {
      if (command === 'check')
        console.log(`${counts.errors} errors, ${counts.warnings} warnings, ${counts.infos} infos`);
      console.log(human);
    } else if (command === 'check')
      console.log(`${counts.errors} errors, ${counts.warnings} warnings, ${counts.infos} infos`);
    else if (result) console.log(JSON.stringify(result, null, 2));
  }
}
function failure(message: string, kind = 'usage') {
  process.exitCode = 2;
  if (json) output({ failure: kind, message });
  else console.error(message);
}
function sourceLabel(value: unknown): string {
  const source = value as {
    span?: { line: number; col: number; file?: string };
    slot?: number[];
    ratchet?: number;
  };
  return source?.span
    ? `${source.span.file ?? 'line '}${source.span.file ? ':' : ''}${source.span.line}:${source.span.col}, slot ${source.slot?.join('.') ?? '-'}`
    : 'generated';
}
function renderDiff(diff: ReturnType<typeof musicalDiff>): string {
  return diff.parts.length
    ? diff.parts
        .map(
          (p) =>
            `${p.name}: ${p.changed.length} changed events, ${p.moved.length} moved${p.controlsChanged ? ', controls changed' : ''}`,
        )
        .join('\n')
    : 'No musical changes';
}
async function run() {
  if (!commands.includes(command))
    throw new RangeError(`Usage: mm <${commands.join('|')}> <song.mm> [--json]`);
  validateOptions();
  if (command === 'ports') {
    const live = await import('./commands/live.ts');
    const names = live.ports();
    output({ outputs: names }, [], '', names.join('\n'));
    return;
  }
  if (command === 'panic') {
    const setup = option('--setup');
    if (!setup) throw new RangeError('Usage: mm panic --setup studio.setup');
    const live = await import('./commands/live.ts'),
      r = live.panicFile(setup);
    process.exitCode = summary(r.diagnostics).errors ? 1 : 0;
    output(r.result, r.diagnostics, '', `Panic: ${r.result.sent} messages sent`);
    return;
  }
  if (command === 'help') {
    if (file === 'sound') {
      const { preset, presetNames } = await import('../../synth/src/presets.ts');
      const name = args[2] && !args[2].startsWith('--') ? args[2] : undefined;
      const result = name ? { sound: name, preset: preset(name) } : { sounds: presetNames() };
      output(
        result,
        [],
        '',
        name
          ? JSON.stringify(result, null, 2)
          : `Software sounds: ${presetNames().join(', ')}\nUse sound <name> directly under a score part. mm help sound <name> prints its resolved fields.`,
      );
      return;
    }
    if (file === 'alias') {
      const alias = args[2],
        setup = option('--setup');
      if (!alias || alias.startsWith('--') || !/^[A-Za-z_][\w-]*$/.test(alias) || !setup)
        throw new RangeError('Usage: mm help alias <name> --setup studio.setup');
      const rig = loadRig(setup, `mm 1\npart ${alias}\n  role front\n`),
        bound = rig.parts[0];
      if (rig.diagnostics.some((d) => d.severity === 'error') || !bound) {
        process.exitCode = 1;
        output({ alias }, rig.diagnostics);
        return;
      }
      const parameters = Object.values(bound.instrument.params).map((p) => ({
        name: p.name,
        kind: p.kind,
        address: p.address,
        bits: p.bits,
        domain: p.bipolar ? [-1, 1] : [0, 1],
        rate: p.rate,
        default: bound.baselines[p.name],
      }));
      output(
        { alias, ...rigSummary(rig)[0], voices: bound.instrument.voices, parameters },
        rig.diagnostics,
        '',
        `${alias} → ${bound.instrument.id}, ${bound.port.name}, ch ${bound.channel} (${bound.instrument.voices})${bound.instrument.transpose ? `, transpose ${bound.instrument.transpose > 0 ? '+' : ''}${bound.instrument.transpose}` : ''}\n${parameters.length ? parameters.map((p) => `  ${p.name}: ${p.kind} ${p.address.join('/')} (${p.bits}-bit), domain ${p.domain.join('..')}${p.default === undefined ? '' : `, default ${p.default}`}`).join('\n') : '  No mapped parameters; notes only.'}`,
      );
      return;
    }
    const result = help(file.startsWith('--') ? '' : file);
    output(result, [], '', result.text);
    return;
  }
  if (command === 'schema') {
    if (!file || file.startsWith('-')) throw new RangeError('Usage: mm schema <command>');
    output(schema(file));
    return;
  }
  if (!file || file.startsWith('-')) throw new RangeError(`Usage: mm ${command} <song.mm>`);
  loadedScore = loadScore(file);
  if (command === 'expand' && !option('--to')) {
    if (json)
      output({
        source: loadedScore.source,
        dependencies: loadedScore.files,
        scoreHash: loadedScore.hash,
      });
    else if (!quiet)
      process.stdout.write(
        loadedScore.source.endsWith('\n') ? loadedScore.source : loadedScore.source + '\n',
      );
    return;
  }
  if (command === 'feedback') {
    const { readFeedback, recordFeedback } = await import('./commands/feedback.ts');
    const source = loadedScore.source;
    const text = args[2] && !args[2].startsWith('--') ? args[2] : undefined;
    if (!text) {
      const ledger = readFeedback(file),
        current = hash(frozenSource(loadedScore));
      const entries = ledger.entries.map((e) => ({
        ...e,
        currentVersion: e.sourceHash === current,
      }));
      output(
        { ...ledger, entries },
        [],
        '',
        entries.length
          ? entries
              .map(
                (e) =>
                  `#${e.id} [${e.currentVersion ? 'current' : e.sourceHash.slice(0, 8)}] ${e.position ? `bar ${e.position.bar} (${e.position.path})` : 'whole song'}: ${e.text}`,
              )
              .join('\n')
          : 'No listening feedback recorded.',
      );
      return;
    }
    const { prepareSoftwareScore } = await import('../../render/src/score-settings.ts');
    const prepared = prepareSoftwareScore(source, file);
    const r = realize(prepared.coreSource, {
      templateContext: prepared.templates,
      parameterDomains: prepared.domains,
      deferDeviceExpectations: true,
      controlOnlyParts: new Set(Object.keys(prepared.busParts)),
      attackLimit: 256,
      attackLimitSeverity: 'warning',
    });
    if (r.summary.errors || !r.song) {
      process.exitCode = 1;
      output({ logged: false }, r.diagnostics, source);
      return;
    }
    const logged = recordFeedback(
      file,
      frozenSource(loadedScore),
      r.song,
      text,
      option('--at'),
      loadedScore.files,
    );
    const p = logged.entry.position;
    output(
      logged,
      [],
      '',
      `Logged #${logged.entry.id} against version ${logged.entry.sourceHash.slice(0, 8)}${p ? `\n${p.requested} → bar ${p.bar}, ${p.path}\nSounding: ${p.parts.join(', ') || 'none'}` : '\nWhole-song feedback'}`,
    );
    return;
  }
  if (command === 'pack' || (command === 'export' && option('--midi-dir'))) {
    if (option('--midi')) throw new RangeError('--midi and --midi-dir are mutually exclusive');
    const bendRange =
      option('--bend-range') === undefined ? undefined : Number(option('--bend-range'));
    if (
      bendRange !== undefined &&
      (!Number.isInteger(bendRange) || bendRange < 1 || bendRange > 96)
    )
      throw new RangeError('--bend-range must be an integer 1..96 semitones');
    const { prepareMidiPerformance, exportPartMidi, midiStemPrefix } =
      await import('../../render/src/daw-midi.ts');
    if (command === 'pack') {
      if (!option('--out'))
        throw new RangeError('Usage: mm pack song.mm --out pack-directory [--cc]');
      const { packSong } = await import('../../render/src/pack.ts');
      const packed = packSong(loadedScore.source, file, {
        score: loadedScore,
        out: option('--out')!,
        setup: option('--setup'),
        tail: option('--tail') === undefined ? undefined : Number(option('--tail')),
        cc: args.includes('--cc'),
        bendRange,
        progress: !json && !quiet ? (text) => process.stderr.write(`${text}\n`) : undefined,
      });
      output(
        { packed: true, ...packed },
        [],
        '',
        `Pack: ${packed.directory} (${packed.parts} parts)`,
      );
    } else {
      const { performance, diagnostics } = prepareMidiPerformance(loadedScore.source, file, {
        setup: option('--setup'),
      });
      const exported = exportPartMidi(performance, option('--midi-dir')!, {
        cc: args.includes('--cc'),
        bendRange,
        prefix: midiStemPrefix(file),
      });
      output(
        { exported: true, directory: option('--midi-dir'), ...exported },
        diagnostics,
        '',
        `Exported ${exported.files.length} part MIDI files to ${option('--midi-dir')}`,
      );
    }
    return;
  }
  if (command === 'export' && (args.includes('--cc') || option('--bend-range')))
    throw new RangeError('--cc and --bend-range require --midi-dir');
  if (command === 'video') {
    const { renderVideo } = await import('./commands/video.ts');
    const result = await renderVideo(loadedScore, file, {
      out: option('--out'),
      setup: option('--setup'),
      from: option('--from'),
      bars: option('--bars'),
      tail: option('--tail') === undefined ? undefined : Number(option('--tail')),
      width: option('--width') === undefined ? undefined : Number(option('--width')),
      height: option('--height') === undefined ? undefined : Number(option('--height')),
      fps: option('--fps') === undefined ? undefined : Number(option('--fps')),
      progress: !json && !quiet ? (text) => process.stderr.write(`${text}\n`) : undefined,
    });
    output(
      { rendered: true, ...result },
      [],
      '',
      `MP4: ${result.destination}\nWAV: ${result.audio}\nEvents: ${result.performancePath}`,
    );
    return;
  }
  if (command === 'render') {
    const { renderSong } = await import('../../render/src/render.ts');
    const tail = option('--tail') === undefined ? undefined : Number(option('--tail'));
    if (tail !== undefined && (!Number.isFinite(tail) || tail < 0 || tail > 120))
      throw new RangeError('--tail must be 0..120 seconds');
    if (option('--stems-by') && !['group', 'part'].includes(option('--stems-by')!))
      throw new RangeError('--stems-by supports group or part');
    const rendered = renderSong(loadedScore.source, file, {
      score: loadedScore,
      stemsBy: option('--stems-by') as 'group' | 'part' | undefined,
      eventEnvelopes: option('--events-envelopes') as 'full' | 'none' | undefined,
      eventParts: option('--events-parts')
        ?.split(',')
        .map((name) => name.trim()),
      setup: option('--setup'),
      out: option('--out'),
      from: option('--from'),
      bars: option('--bars'),
      preview: args.includes('--preview'),
      warmupBars:
        option('--warmup-bars') === undefined ? undefined : Number(option('--warmup-bars')),
      tail,
      noAnalysis: args.includes('--no-analysis'),
      analysis: args.includes('--analysis'),
      solo: option('--solo'),
      mute: option('--mute'),
      progress: !json && !quiet ? (text) => process.stderr.write(`${text}\n`) : undefined,
    });
    output({ rendered: true, ...rendered }, [], '', `${rendered.text}WAV: ${rendered.destination}`);
    return;
  }
  if (
    command === 'check' &&
    option('--setup') &&
    /\bengine\s+\w+\s*=\s*software\b/.test(readFileSync(option('--setup')!, 'utf8'))
  ) {
    validationTarget = 'software';
    const { loadSoftwareSetup, bindSoftware, softwareArticulation } =
      await import('../../render/src/setup.ts');
    const software = loadSoftwareSetup(option('--setup'));
    const { prepareSoftwareScore, validateSoftwareScore } =
      await import('../../render/src/score-settings.ts');
    const prepared = prepareSoftwareScore(loadedScore.source, file);
    const checked = realize(prepared.coreSource, {
      templateContext: prepared.templates,
      deferDeviceExpectations: true,
      parameterDomains: prepared.domains,
      attackLimit: 256,
      attackLimitSeverity: 'warning',
      controlOnlyParts: new Set(Object.keys(prepared.busParts)),
    });
    if (checked.song) {
      validateSoftwareScore(checked.song, prepared);
      for (const part of checked.song.parts)
        if (!(part.name in prepared.busParts))
          scoreContext(
            prepared.partSpans[part.name] ?? { line: 1, col: 1, endLine: 1, endCol: 1 },
            () =>
              bindSoftware(
                software,
                part,
                prepared.sounds[part.name],
                prepared.presetOverrides[part.name],
              ),
          );
    }
    process.exitCode = checked.summary.errors ? 1 : 0;
    if (checked.song) {
      const { softwareWarnings } = await import('../../render/src/warnings.ts');
      checked.diagnostics.push(
        ...softwareWarnings(
          checked,
          software,
          prepared.sounds,
          prepared.presetOverrides,
          prepared.tuning,
        ),
      );
    }
    const articulations = checked.song
      ? softwareArticulation(
          checked.song.parts.filter((p) => !(p.name in prepared.busParts)),
          software,
          prepared.sounds,
          prepared.presetOverrides,
        )
      : [];
    output(
      { stage: checked.stage, articulation: articulations },
      checked.diagnostics,
      loadedScore.source,
      articulations.map((p) => `${p.part}: ${p.notes} notes, ${p.slides} slides`).join('\n'),
    );
    return;
  }
  if (command === 'check' && option('--setup')) validationTarget = 'midi';
  const source = loadedScore.source,
    rig = option('--setup') ? loadRig(option('--setup')!, source) : undefined,
    result = realize(source, {
      filename: file,
      parameterDomains: rig ? domains(rig) : undefined,
      deferDeviceExpectations: !!rig,
    }),
    song = result.song;
  if (command === 'check' && !option('--setup')) {
    const lines = source.split(/\r?\n/);
    const line = lines.findIndex((raw) =>
      /^(?:\s+(?:sound|insert|mono|unison|tuning)\b|fx\s*$|bus\s+|listener\s*$|\s*space\s+|\s*(?:lfo|lfo2|modenv|osc1|osc2|filter|pluck|formant|drum|insert)\.)/.test(
        raw.replace(/\/\/.*$/, ''),
      ),
    );
    if (line >= 0)
      result.diagnostics.push(
        diagnostic(
          'I005',
          'Software settings have not been validated; use check --setup setups/band/band.setup',
          { line: line + 1, col: 1, endLine: line + 1, endCol: 1 },
          { severity: 'warning', help: 'render' },
        ),
      );
  }
  let inspectionMidi: ReturnType<typeof compileMidi> | undefined;
  if (rig) {
    result.diagnostics.push(...rig.diagnostics);
    if (song && ['check', 'explain', 'metrics'].includes(command)) {
      inspectionMidi = compileMidi(result, rig);
      result.diagnostics.push(...inspectionMidi.diagnostics);
    }
    result.diagnostics = result.diagnostics.filter(
      (d, i, all) =>
        !all
          .slice(0, i)
          .some(
            (p) =>
              p.code === d.code &&
              p.severity === d.severity &&
              p.message === d.message &&
              p.path === d.path &&
              p.span.line === d.span.line &&
              p.span.col === d.span.col,
          ),
    );
    result.summary = summary(result.diagnostics);
  }
  process.exitCode = result.summary.errors ? 1 : 0;
  if (command === 'play') {
    if (!rig) throw new RangeError('Live playback requires --setup');
    if (!song) {
      process.exitCode = 1;
      output({ played: false }, result.diagnostics, source);
      return;
    }
    const clock = option('--clock') ? option('--clock') === 'send' : rig.parts[0]?.port.clock,
      compiled = compileMidi(result, rig, { clock }),
      diagnostics = [...result.diagnostics, ...compiled.diagnostics];
    if (summary(diagnostics).errors) {
      process.exitCode = 1;
      output({ played: false }, diagnostics, source);
      return;
    }
    const live = await import('./commands/live.ts'),
      played = await live.playFile(result, compiled, {
        from: option('--from'),
        bars: option('--bars'),
        loop: args.includes('--loop'),
        clock: option('--clock'),
        json,
        quiet,
      });
    process.exitCode = played.stopped ? 130 : 0;
    output(
      { ...played, port: rig.parts[0]?.port.name },
      diagnostics,
      source,
      played.stopped ? 'Playback stopped' : 'Playback complete',
    );
    return;
  }
  if (command === 'export') {
    const destination = option('--midi');
    if (!destination)
      throw new RangeError('Usage: mm export <song> [--setup <setup>] --midi out.mid');
    if (!song) {
      process.exitCode = 1;
      output({ exported: false }, result.diagnostics, source);
      return;
    }
    const compiled = compileMidi(result, rig ?? implicitRig(song.parts)),
      diagnostics = [...result.diagnostics, ...compiled.diagnostics];
    if (summary(diagnostics).errors) {
      process.exitCode = 1;
      output({ exported: false }, diagnostics, source);
      return;
    }
    const bytes = writeMidi(compiled);
    writeFileSync(destination, bytes);
    output(
      {
        exported: true,
        destination,
        bytes: bytes.length,
        notes: compiled.notes.length,
        bindings: rigSummary(compiled.rig),
        adaptations: compiled.adaptations,
      },
      diagnostics,
      source,
      `Exported ${compiled.notes.length} notes to ${destination}`,
    );
    return;
  }
  if (command === 'accept') {
    if (!song || result.summary.errors) {
      process.exitCode = 1;
      output({ accepted: false }, result.diagnostics, source);
      return;
    }
    const metadata = accept(file, source, song, loadedScore);
    output(
      { accepted: true, ...metadata },
      result.diagnostics,
      source,
      `Accepted exact source for ${file} (dirty: ${metadata.dirty})`,
    );
    return;
  }
  if (command === 'format') {
    if (result.summary.errors) {
      output({ formatted: false }, result.diagnostics, source);
      return;
    }
    const original = readFileSync(file, 'utf8');
    const formatted = formatSource(original);
    writeFileSync(file, formatted);
    output(
      { formatted: true, changed: formatted !== original },
      result.diagnostics,
      source,
      `Formatted ${file}`,
    );
    return;
  }
  if (command === 'diff') {
    const since = option('--since');
    let previous: string, metadata: ReturnType<typeof accepted>['metadata'] | undefined;
    if (since === 'accepted') {
      const snapshot = accepted(file);
      previous = snapshot.source;
      metadata = snapshot.metadata;
    } else if (since) previous = revisionSource(file, since);
    else {
      const other = args[2];
      if (!other || other.startsWith('--'))
        throw new RangeError(
          'Usage: mm diff <before> <after> or mm diff <song> --since accepted|<revision>',
        );
      previous = source;
      const nextLoaded = loadScore(other),
        nextSource = nextLoaded.source,
        next = realize(nextSource, { filename: other });
      next.diagnostics = next.diagnostics.map((d) => mapScoreDiagnostic(d, nextLoaded));
      if (!song || !next.song) {
        process.exitCode = 1;
        output(
          { unavailable: 'Both scores need a form' },
          [...result.diagnostics, ...next.diagnostics],
          source,
        );
        return;
      }
      const diff = musicalDiff(song, next.song);
      output(diff, [...result.diagnostics, ...next.diagnostics], source, renderDiff(diff));
      process.exitCode = next.summary.errors || result.summary.errors ? 1 : 0;
      return;
    }
    const old = realize(previous);
    if (!song || !old.song) {
      process.exitCode = 1;
      output(
        { unavailable: 'Both scores need a form' },
        [...result.diagnostics, ...old.diagnostics],
        source,
      );
      return;
    }
    const diagnostics = [...result.diagnostics, ...old.diagnostics];
    if (
      metadata &&
      metadata.sourceHash === hash(frozenSource(loadedScore)) &&
      JSON.stringify(metadata.parts) !== JSON.stringify(digests(song))
    )
      diagnostics.push(
        diagnostic(
          'L003',
          'Accepted event digests differ under the current engine',
          result.ast.span,
          { severity: 'warning' },
        ),
      );
    const diff = musicalDiff(old.song, song);
    output({ ...diff, accepted: metadata }, diagnostics, source, renderDiff(diff));
    return;
  }
  if (command === 'check') {
    const slides = inspectionMidi ? articulation(inspectionMidi) : undefined,
      sharing = rig ? sharedChannels(rig) : undefined;
    output(
      {
        bindings: rig ? rigSummary(rig) : undefined,
        articulation: slides,
        sharedChannels: sharing,
        stage: song ? 'realized' : result.stage,
        statements: result.ast.statements.length,
        parts: song?.parts.map((p) => ({ name: p.name, events: p.events.length })),
        extent: song?.extent,
      },
      result.diagnostics,
      source,
      rig
        ? `${(slides ?? []).map((p) => `${p.part} ch ${p.channel}: ${p.slides} slides, ${p.unwrittenSlides} unwritten`).join('\n')}\n${(sharing ?? []).map((g) => (g.kind === 'drum-kit' ? `ch ${g.channel}: drum kit (${g.laneCount} lanes), ${g.instrument} (${g.port})` : `Shared channel ${g.channel}: ${g.parts.join(', ')} (${g.port})`)).join('\n')}`
        : undefined,
    );
    return;
  }
  if (command === 'fix') {
    output(
      { fixes: result.diagnostics.flatMap((d) => d.fixes.map((f) => ({ code: d.code, ...f }))) },
      result.diagnostics,
      source,
    );
    return;
  }
  if (!song) {
    output(
      { unavailable: 'Song needs a form' },
      [...result.diagnostics, diagnostic('R003', 'Inspection requires a form', result.ast.span)],
      source,
    );
    process.exitCode = 1;
    return;
  }
  if (command === 'expand') {
    output(
      { extent: song.extent, sections: song.sections, bars: song.bars },
      result.diagnostics,
      source,
      song.sections.map((s) => `${s.path.padEnd(25)} ${s.onset} + ${s.extent}`).join('\n'),
    );
    return;
  }
  if (command === 'metrics') {
    const data = metrics(song).map((s) => ({
      ...s,
      parts: args.includes('--all') ? s.parts : s.parts.filter((p) => p.onsets > 0),
    }));
    const durationSeconds =
        ((Number(song.extent.numerator) / Number(song.extent.denominator)) * 240) /
        (Number(song.tempo.numerator) / Number(song.tempo.denominator)),
      rounded = Math.round(durationSeconds),
      duration = `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`,
      ports = inspectionMidi ? portMetrics(inspectionMidi) : undefined;
    output(
      { durationSeconds, duration, sections: data, ports },
      result.diagnostics,
      source,
      `Duration ${duration} (${durationSeconds.toFixed(1)} seconds)\n${(ports ?? []).map((p) => `${p.port} (${p.rate} bytes/s):\n${p.sections.map((s) => `  ${s.path}: average ${s.averagePercent.toFixed(1)}%, peak ${s.peakPercent.toFixed(1)}%, headroom ${s.headroomPercent.toFixed(1)}%`).join('\n')}`).join('\n')}\n` +
        data
          .map(
            (s) =>
              `${s.path} (${s.extent})\n${s.parts.map((p) => `  ${p.name.padEnd(12)} ${String(p.onsets).padStart(5)} onsets  ${p.onsetsPerBar.toFixed(2)}/bar  range ${p.range?.map(noteName).join('..') ?? 'drums/rest'}`).join('\n')}`,
          )
          .join('\n'),
    );
    return;
  }
  if (command === 'roll') {
    const limits = (option('--bars') ?? '1..8').split('..').map(Number);
    const harmony = args.includes('--harmony')
      ? harmonyRoll(result.structure!, result.harmony!, limits[0], limits[1] ?? limits[0])
      : undefined;
    const text = [
      harmony
        ? 'Harmony/key\n' +
          harmony
            .map(
              (row) =>
                `  bar ${row.bar}  ${row.changes.map((c) => `beat ${c.beat}: ${c.chord ?? '(no declared harmony)'} [${c.key}]`).join('; ')}`,
            )
            .join('\n')
        : '',
      roll(song, option('--part'), limits[0], limits[1] ?? limits[0]),
    ]
      .filter(Boolean)
      .join('\n');
    output(
      { part: option('--part'), bars: limits, harmony, text },
      result.diagnostics,
      source,
      text,
    );
    return;
  }
  if (command === 'query') {
    const from = timeAt(song, option('--from') ?? '0/1'),
      to = timeAt(song, option('--to') ?? song.extent.toString());
    if (from.compare(to) > 0) throw new RangeError('Query start must precede end');
    const window = query(source, { from, to, part: option('--part') });
    output({ from, to, song: window.song }, result.diagnostics, source);
    return;
  }
  if (command === 'at') {
    const selector =
        args
          .slice(2)
          .filter((a) => !a.startsWith('--'))
          .join(' ') || 'bar 1',
      time = timeAt(song, selector, true),
      data = at(song, time);
    output(
      data,
      result.diagnostics,
      source,
      `${data.path ?? 'outside form'}  bar ${data.bar ?? '-'}, section bar ${data.sectionBar ?? '-'}, beat ${data.beat ?? '-'}\n${data.sounding.map((p) => `  ${p.part}: ${p.events.map((e) => (e.pitch === null ? 'x' : noteName(e.pitch))).join(' ')}`).join('\n')}`,
    );
    return;
  }
  if (command === 'explain') {
    const midi = inspectionMidi;
    const selector = args[2]?.startsWith('--') ? '' : (args[2] ?? ''),
      matches = song.sections.filter((s) => s.path === selector || s.name === selector);
    if (selector && matches.length > 1) {
      process.exitCode = 1;
      output(
        { candidates: matches.map((s) => s.path) },
        [
          ...result.diagnostics,
          diagnostic('R004', 'Selector matches multiple occurrences', result.ast.span, {
            measured: { candidates: matches.map((s) => s.path) },
          }),
        ],
        source,
      );
      return;
    }
    const selectedBar = option('--bar'),
      time = selectedBar
        ? timeAt(song, `bar ${selectedBar}`)
        : (matches[0]?.onset ?? song.bars[0].onset),
      b =
        song.bars.find((b) => b.onset.equals(time)) ??
        song.bars.find((b) => b.onset.compare(time) <= 0 && b.onset.add(b.span).compare(time) > 0)!,
      end = b.onset.add(b.span),
      chord = result.harmony!.chordAt(time),
      curves = Object.fromEntries(
        result.ast.statements
          .filter((s) => s.kind === 'curve')
          .map((c) => [c.name, curveAt(result.resolution, result.structure!, c.name, time)]),
      );
    const parts = song.parts
      .filter((p) => !option('--part') || p.name === option('--part'))
      .map((p) => ({
        name: p.name,
        events: p.events
          .filter(
            (e) => e.nominalOnset.compare(end) < 0 && e.nominalOnset.add(e.gate).compare(time) > 0,
          )
          .map((e) =>
            args.includes('--positions')
              ? { ...e, position: positionAt(song, e.nominalOnset) }
              : { ...e, position: undefined },
          ),
        suppressed: p.suppressions.filter(
          (s) => s.onset.compare(time) >= 0 && s.onset.compare(end) < 0,
        ),
      }));
    const parameters = midi?.rig.parts
      .filter((bound) => !option('--part') || bound.part === option('--part'))
      .map((bound) => {
        const part = song.parts.find((p) => p.name === bound.part)!;
        const names = new Set([
          ...Object.keys(part.controls),
          ...part.events.flatMap((e) => Object.keys(e.locks)),
          ...Object.keys(bound.baselines),
        ]);
        function sample(name: string, at: R) {
          const param = bound.instrument.params[name];
          if (!param) return null;
          const lock = midi!.notes
            .filter(
              (n) =>
                n.event.part === bound.part &&
                n.event.locks[name] !== undefined &&
                n.start <= tick(at) &&
                n.end > tick(at),
            )
            .sort((a, b) =>
              a.start > b.start ? -1 : a.start < b.start ? 1 : a.order - b.order,
            )[0];
          const value =
            lock?.event.locks[name] ??
            result.automation?.at(bound.part, name, at) ??
            bound.baselines[name];
          return value === undefined
            ? null
            : {
                normalized: value,
                wire: quantize(param, value),
                messages: encode(bound, param, value),
              };
        }
        return {
          part: bound.part,
          channel: bound.channel,
          values: [...names].map((name) => ({
            name,
            start: sample(name, time),
            end: sample(name, end.sub(new R(1, 1000000000))),
          })),
        };
      });
    const messages = midi?.messages.filter(
        (m) => m.tick >= tick(time) + midi.offset && m.tick < tick(end) + midi.offset,
      ),
      device = midi
        ? { offset: midi.offset, adaptations: midi.adaptations, parameters, messages }
        : undefined;
    output(
      { bar: b, chord, curves, parts, bindings: rig ? rigSummary(rig) : undefined, midi: device },
      result.diagnostics,
      source,
      `${
        rig
          ? rigSummary(rig)
              .map((b) => `${b.part} → ${b.instrument}, ${b.port}, ch ${b.channel}`)
              .join('\n') + '\n'
          : ''
      }bar ${b.number} (${b.path}, section bar ${b.sectionBar})\n  harmony ${chord.symbol} (${chord.tones.join(' ')})\n  curves ${JSON.stringify(curves)}\n${(parameters ?? []).map((p) => `  ${p.part} ch ${p.channel}: ${p.values.map((v) => `${v.name} ${v.start?.normalized ?? '?'}→${v.end?.normalized ?? '?'} (wire ${v.start?.wire ?? '?'}→${v.end?.wire ?? '?'})`).join(', ')}`).join('\n')}\n${parts.map((p) => `  ${p.name.padEnd(12)} ${p.events.map((e) => `${e.pitch === null ? 'x' : noteName(e.pitch)}@${e.nominalOnset}${e.position?.bar ? ` (bar ${e.position.bar}, beat ${e.position.beat})` : ''} gate ${e.gate} source ${sourceLabel(e.provenance.source)}${Array.isArray(e.provenance.operations) && e.provenance.operations.length ? ` via ${e.provenance.operations.map((o) => o.name).join('.')}` : ''}`).join('\n                 ') || 'rest'}${p.suppressed.length ? `\n    suppressed: ${p.suppressed.map((s) => `${s.reason}@${s.onset}${s.measured ? ` ${JSON.stringify(s.measured)}` : ''}`).join(', ')}` : ''}`).join('\n')}`,
    );
  }
}
try {
  await run();
} catch (error) {
  if (error instanceof IncludeError) {
    process.exitCode = 1;
    output({ loaded: false }, [
      diagnostic(
        'S001',
        error.message,
        { file: error.file, line: error.line, col: 1, endLine: error.line, endCol: 1 },
        { includedFrom: error.from },
      ),
    ]);
  } else if (error instanceof ScoreDiagnosticsError) {
    process.exitCode = 1;
    output({ valid: false }, error.diagnostics, loadedScore?.source ?? '');
  } else if (error instanceof ScoreError) {
    process.exitCode = 1;
    output(
      { valid: false },
      [diagnostic('R003', error.message, error.span)],
      loadedScore?.source ?? '',
    );
  } else if (loadedScore && error instanceof Error && 'line' in error) {
    process.exitCode = 1;
    const line = Number(error.line);
    output(
      { loaded: false },
      [
        diagnostic('R003', `Automation data: ${error.message}`, {
          line,
          col: 1,
          endLine: line,
          endCol: 1,
        }),
      ],
      loadedScore.source,
    );
  } else
    failure(
      error instanceof Error ? error.message : String(error),
      error instanceof RangeError ? 'usage' : 'io',
    );
}
