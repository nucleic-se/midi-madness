import { diagnostic, type Diagnostic, type Span } from '../../core/src/diag.ts';
import { Rational as R } from '@midi-madness/foundation/time';
export type Parameter = {
  name: string;
  kind: 'cc' | 'nrpn' | 'pitchbend' | 'alias';
  address: number[];
  bits: 7 | 14;
  min: number;
  max: number;
  bipolar: boolean;
  rate: number;
  default?: number;
  target?: string;
  span: Span;
};
export type Instrument = {
  id: string;
  name: string;
  voices: 'mono' | 'poly' | 'drums';
  cap?: number;
  range: readonly [number, number];
  transpose: number;
  legato: boolean;
  latency: R;
  program?: { controllers: number[]; base: 0 | 1 };
  banks: Record<string, number[]>;
  lead: R;
  params: Record<string, Parameter>;
  lanes: Record<string, number>;
  laneMode: 'note-map' | 'channel-per-track';
  span: Span;
};
export type Port = { id: string; name: string; rate: number; clock: boolean; span: Span };
export type Binding = {
  selector: string;
  instrument: string;
  port: string;
  channel?: number;
  program?: string;
  overrides: Partial<Instrument>;
  sets: Record<string, number>;
  lanes: Record<string, { channel?: number; note?: number }>;
  span: Span;
};
export type Setup = {
  id: string;
  ports: Record<string, Port>;
  libraries: string[];
  bindings: Binding[];
  span: Span;
};
export type Bound = {
  part: string;
  instrument: Instrument;
  port: Port;
  channel: number;
  note?: number;
  program?: { bank: number[]; pc: number };
  baselines: Record<string, number>;
  startupKeys?: string[];
  span: Span;
};
export type Rig = { setup: Setup; parts: Bound[]; diagnostics: Diagnostic[]; implicit: boolean };
type Line = { indent: number; tokens: string[]; span: Span };
const span: Span = { line: 1, col: 1, endLine: 1, endCol: 1 };
function base(id: string, s = span): Instrument {
  return {
    id,
    name: id,
    voices: 'poly',
    range: [0, 127],
    transpose: 0,
    legato: false,
    latency: new R(0),
    banks: {},
    lead: new R(500),
    params: {},
    lanes: {},
    laneMode: 'note-map',
    span: s,
  };
}
function scan(source: string, file?: string): Line[] {
  return source.split(/\r?\n/).flatMap((raw, i) => {
    let text = '',
      quote = false,
      escape = false;
    for (let j = 0; j < raw.length; j++) {
      const c = raw[j];
      if (!quote && (c === '#' || (c === '/' && raw[j + 1] === '/'))) break;
      text += c;
      if (c === '"' && !escape) quote = !quote;
      escape = c === '\\' && !escape;
    }
    if (!text.trim()) return [];
    const indent = text.match(/^\s*/)![0].length,
      tokens = (text.trim().match(/"(?:\\.|[^"\\])*"|[^\s]+/g) ?? []).map((t) =>
        t.startsWith('"') ? JSON.parse(t) : t,
      );
    return [
      {
        indent,
        tokens,
        span: {
          file,
          line: i + 1,
          col: indent + 1,
          endLine: i + 1,
          endCol: text.trimEnd().length + 1,
        },
      },
    ];
  });
}
function integer(text: string | undefined, low: number, high: number): number {
  const n = Number(text);
  if (!text || !Number.isInteger(n) || n < low || n > high)
    throw new RangeError(`Expected integer ${low}..${high}, got ${text}`);
  return n;
}
function scalar(text: string | undefined): number {
  if (!text || !/^[-+]?\d+(\.\d+)?$/.test(text))
    throw new RangeError(`Expected finite decimal, got ${text}`);
  return Number(text);
}
function ms(text: string | undefined): R {
  if (!text?.endsWith('ms')) throw new RangeError('Expected milliseconds, e.g. 500ms');
  const value = R.parse(text.slice(0, -2));
  if (value.compare(new R(0)) < 0) throw new RangeError('Milliseconds must be nonnegative');
  return value;
}
function attributes(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of tokens) {
    const index = token.indexOf(':');
    if (index < 0) out[token] = 'true';
    else {
      const key = token.slice(0, index);
      if (key in out) throw new RangeError(`Duplicate option ${key}`);
      out[key] = token.slice(index + 1);
    }
  }
  return out;
}
function only(attrs: Record<string, string>, keys: string[]): void {
  for (const key of Object.keys(attrs))
    if (!keys.includes(key)) throw new RangeError(`Unknown option ${key}`);
}
function field(target: Partial<Instrument>, line: Line, seen: Set<string>): void {
  const [key, ...tokens] = line.tokens,
    id = key === 'param' || key === 'lane' ? `${key}:${tokens[0]}` : key;
  if (seen.has(id)) throw new RangeError(`Duplicate ${id}`);
  seen.add(id);
  if (key === 'name') {
    target.name = tokens.join(' ');
    return;
  }
  if (key === 'voices') {
    if (!['mono', 'poly', 'drums'].includes(tokens[0]))
      throw new RangeError('voices must be mono, poly or drums');
    target.voices = tokens[0] as Instrument['voices'];
    target.cap = tokens[1] ? integer(tokens[1], 1, 128) : undefined;
    return;
  }
  if (key === 'range') {
    const match = tokens.join('').match(/^(\d+)-(\d+)$/);
    if (!match) throw new RangeError('Range is LOW-HIGH');
    const low = integer(match[1], 0, 127),
      high = integer(match[2], low, 127);
    target.range = [low, high];
    return;
  }
  if (key === 'transpose') {
    if (tokens.length !== 1) throw new RangeError('transpose requires one semitone offset');
    target.transpose = integer(tokens[0], -127, 127);
    return;
  }
  if (key === 'glide') {
    if (tokens[0] !== 'legato') throw new RangeError('Only glide legato is supported');
    target.legato = true;
    return;
  }
  if (key === 'latency' || key === 'program-lead') {
    target[key === 'latency' ? 'latency' : 'lead'] = ms(tokens[0]);
    return;
  }
  if (key === 'program') {
    const a = attributes(tokens);
    only(a, ['bank', 'select', 'base']);
    if (a.select !== 'pc') throw new RangeError('program requires select:pc');
    const controllers =
      a.bank === 'cc0+cc32'
        ? [0, 32]
        : a.bank === 'cc0'
          ? [0]
          : a.bank === 'cc32'
            ? [32]
            : !a.bank
              ? []
              : undefined;
    if (!controllers) throw new RangeError('Invalid bank controller');
    target.program = { controllers, base: integer(a.base ?? '1', 0, 1) as 0 | 1 };
    return;
  }
  if (key === 'banks') {
    target.banks = {};
    for (const token of tokens) {
      const index = token.indexOf(':'),
        name = token.slice(0, index);
      if (index < 1 || name in target.banks) throw new RangeError('Invalid or duplicate bank');
      target.banks[name] = token
        .slice(index + 1)
        .split('/')
        .map((n) => integer(n, 0, 127));
    }
    return;
  }
  if (key === 'lanes') {
    if (!['note-map', 'channel-per-track'].includes(tokens[0]))
      throw new RangeError('Invalid lane mode');
    target.laneMode = tokens[0] as Instrument['laneMode'];
    return;
  }
  if (key === 'lane') {
    const a = attributes(tokens.slice(1));
    only(a, ['note']);
    (target.lanes ??= {})[tokens[0]] = integer(a.note, 0, 127);
    return;
  }
  if (key === 'param') {
    const name = tokens[0],
      a = attributes(tokens.slice(1));
    only(a, [
      'cc',
      'lsb',
      'nrpn',
      'bits',
      'pitchbend',
      'as',
      'min',
      'max',
      'bipolar',
      'rate',
      'default',
    ]);
    const encodings = ['cc', 'nrpn', 'pitchbend', 'as'].filter((k) => k in a);
    if (encodings.length !== 1)
      throw new RangeError('Parameter needs one CC, NRPN, pitchbend or alias mapping');
    const kind = encodings[0] === 'as' ? 'alias' : (encodings[0] as Parameter['kind']),
      bits: 7 | 14 =
        kind === 'pitchbend' || a.lsb ? 14 : integer(a.bits ?? '7', 7, 14) === 14 ? 14 : 7;
    if (a.bits && !['7', '14'].includes(a.bits)) throw new RangeError('bits must be 7 or 14');
    const address =
      kind === 'cc'
        ? [integer(a.cc, 0, 119), ...(a.lsb ? [integer(a.lsb, 0, 119)] : [])]
        : kind === 'nrpn'
          ? a.nrpn.split('/').map((n) => integer(n, 0, 127))
          : [];
    if (kind === 'nrpn' && address.length !== 2) throw new RangeError('NRPN address is MSB/LSB');
    if (kind === 'cc' && address.some((n) => [0, 32].includes(n)))
      throw new RangeError('Bank controllers belong in program declaration');
    const bipolar = a.bipolar === 'true' || kind === 'pitchbend',
      maxValue = bits === 14 ? 16383 : 127,
      min = a.min ? integer(a.min, 0, maxValue) : 0,
      max = a.max ? integer(a.max, min, maxValue) : maxValue,
      rate = a.rate ? scalar(a.rate) : bits === 14 ? 50 : 100;
    if (rate <= 0) throw new RangeError('Parameter rate must be positive');
    const value = a.default === undefined ? undefined : scalar(a.default);
    if (value !== undefined && (value < (bipolar ? -1 : 0) || value > 1))
      throw new RangeError('Default outside normalized parameter domain');
    (target.params ??= {})[name] = {
      name,
      kind,
      address,
      bits,
      min,
      max,
      bipolar,
      rate,
      default: value,
      target: a.as,
      span: line.span,
    };
    return;
  }
  throw new RangeError(`Unknown/unsupported instrument field ${key}`);
}
function failure(error: unknown, s: Span, file = s.file): Diagnostic {
  return diagnostic('R003', error instanceof Error ? error.message : String(error), s, { file });
}
export function parseInstrument(
  source: string,
  file?: string,
): { instrument?: Instrument; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  let lines: Line[];
  try {
    lines = scan(source, file);
  } catch (error) {
    return { diagnostics: [failure(error, span, file)] };
  }
  const first = lines[0];
  if (first?.tokens[0] !== 'instrument' || !first.tokens[1])
    return { diagnostics: [failure('instrument header required', first?.span ?? span, file)] };
  const instrument = base(first.tokens[1], first.span),
    seen = new Set<string>();
  for (const line of lines.slice(1))
    try {
      if (line.indent === 0) throw new RangeError('Instrument fields must be indented');
      field(instrument, line, seen);
    } catch (error) {
      diagnostics.push(failure(error, line.span, file));
    }
  return { instrument, diagnostics };
}
export function parseSetup(
  source: string,
  file?: string,
): { setup?: Setup; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  let lines: Line[];
  try {
    lines = scan(source, file);
  } catch (error) {
    return { diagnostics: [failure(error, span, file)] };
  }
  const first = lines[0];
  if (first?.tokens[0] !== 'setup' || !first.tokens[1])
    return { diagnostics: [failure('setup header required', first?.span ?? span, file)] };
  const setup: Setup = {
    id: first.tokens[1],
    ports: {},
    libraries: [],
    bindings: [],
    span: first.span,
  };
  let binding: Binding | undefined,
    seen = new Set<string>();
  for (const line of lines.slice(1))
    try {
      if (line.indent === 0) throw new RangeError('Setup fields must be indented');
      const t = line.tokens;
      if (line.indent > 2) {
        if (!binding) throw new RangeError('Nested field needs a binding');
        if (t[0] === 'set') {
          if (t[1] in binding.sets) throw new RangeError('Duplicate startup value');
          binding.sets[t[1]] = scalar(t[2]);
        } else if (t[0] === 'lane') {
          const a = attributes(t.slice(2));
          only(a, ['ch', 'note']);
          if (t[1] in binding.lanes) throw new RangeError('Duplicate lane override');
          binding.lanes[t[1]] = {
            channel: a.ch ? integer(a.ch, 1, 16) : undefined,
            note: a.note ? integer(a.note, 0, 127) : undefined,
          };
        } else field(binding.overrides, line, seen);
        continue;
      }
      binding = undefined;
      if (t[0] === 'port') {
        if (t[2] !== '=' || !t[3] || t[1] in setup.ports)
          throw new RangeError('Invalid/duplicate port');
        const a = attributes(t.slice(4));
        only(a, ['clock', 'rate']);
        if (a.clock && !['send', 'off'].includes(a.clock))
          throw new RangeError('clock must be send/off');
        const rate = a.rate ? scalar(a.rate) : 3125;
        if (rate <= 0) throw new RangeError('Port rate must be positive');
        setup.ports[t[1]] = {
          id: t[1],
          name: t[3],
          rate,
          clock: a.clock !== 'off',
          span: line.span,
        };
      } else if (t[0] === 'library') setup.libraries.push(...t.slice(1));
      else {
        if (t[1] !== '=' || !t[2])
          throw new RangeError('Expected alias = instrument port:NAME ch:N');
        const a = attributes(t.slice(3));
        only(a, ['port', 'ch', 'program']);
        binding = {
          selector: t[0],
          instrument: t[2],
          port: a.port,
          channel: a.ch ? integer(a.ch, 1, 16) : undefined,
          program: a.program,
          overrides: {},
          sets: {},
          lanes: {},
          span: line.span,
        };
        if (!binding.port) throw new RangeError('Binding needs port');
        setup.bindings.push(binding);
        seen = new Set();
      }
    } catch (error) {
      diagnostics.push(failure(error, line.span, file));
    }
  return { setup, diagnostics };
}
function parameters(
  params: Record<string, Parameter>,
  diagnostics: Diagnostic[],
): Record<string, Parameter> {
  const resolved: Record<string, Parameter> = {};
  function visit(name: string, stack: string[]): Parameter | undefined {
    if (resolved[name]) return resolved[name];
    const p = params[name];
    if (!p) {
      diagnostics.push(diagnostic('R001', `Missing parameter alias ${name}`, span));
      return;
    }
    if (stack.includes(name)) {
      diagnostics.push(
        diagnostic('R002', `Parameter alias cycle: ${[...stack, name].join(' → ')}`, p.span),
      );
      return;
    }
    if (p.kind !== 'alias') return (resolved[name] = p);
    const target = visit(p.target!, [...stack, name]);
    if (target)
      return (resolved[name] = {
        ...target,
        name,
        default: p.default ?? target.default,
        span: p.span,
      });
  }
  for (const name of Object.keys(params)) visit(name, []);
  return resolved;
}
export function resolveRig(
  setup: Setup,
  library: Record<string, Instrument>,
  parts: { name: string; role: string; lane?: string }[],
): Rig {
  const diagnostics: Diagnostic[] = [],
    bound: Bound[] = [];
  for (const part of parts) {
    const priority = (b: Binding) =>
        b.selector === part.name
          ? 3
          : b.selector === `lane:${part.lane}`
            ? 2
            : b.selector === `role:${part.role}`
              ? 1
              : b.selector === '*'
                ? 0
                : -1,
      matches = setup.bindings
        .filter((b) => priority(b) >= 0)
        .sort((a, b) => priority(b) - priority(a));
    if (!matches.length) {
      diagnostics.push(
        diagnostic('I002', `Part ${part.name} has no binding`, setup.span, { path: part.name }),
      );
      continue;
    }
    const b = matches[0];
    if (matches[1] && priority(matches[1]) === priority(b)) {
      diagnostics.push(diagnostic('R004', `Ambiguous binding for ${part.name}`, b.span));
      continue;
    }
    const source = b.instrument === 'direct' ? base('direct', b.span) : library[b.instrument],
      port = setup.ports[b.port];
    if (!source || !port) {
      diagnostics.push(
        diagnostic(
          'R001',
          `Unknown ${!source ? 'instrument ' + b.instrument : 'port ' + b.port}`,
          b.span,
        ),
      );
      continue;
    }
    const instrument: Instrument = {
      ...source,
      ...b.overrides,
      params: { ...source.params, ...b.overrides.params },
      lanes: { ...source.lanes, ...b.overrides.lanes },
    };
    instrument.params = parameters(instrument.params, diagnostics);
    const override = part.lane ? b.lanes[part.lane] : undefined,
      channel = override?.channel ?? b.channel,
      note = override?.note ?? (part.lane ? instrument.lanes[part.lane] : undefined);
    if (!channel || (part.lane && note === undefined)) {
      diagnostics.push(
        diagnostic(
          'R003',
          `Missing ${!channel ? 'channel' : 'drum note mapping'} for ${part.name}`,
          b.span,
        ),
      );
      continue;
    }
    if (
      Object.values(instrument.params).some((p) => p.kind === 'nrpn') &&
      Object.values(instrument.params).some(
        (p) => p.kind === 'cc' && p.address.some((n) => [6, 38, 98, 99, 100, 101].includes(n)),
      )
    )
      diagnostics.push(diagnostic('R003', 'CC mapping conflicts with NRPN protocol state', b.span));
    const baselines: Record<string, number> = {};
    for (const p of Object.values(instrument.params))
      if (p.default !== undefined) baselines[p.name] = p.default;
    for (const [name, value] of Object.entries(b.sets)) {
      const p = instrument.params[name];
      if (!p || value < (p.bipolar ? -1 : 0) || value > 1) {
        diagnostics.push(diagnostic('R003', `Invalid startup value/mapping for ${name}`, b.span));
        continue;
      }
      baselines[name] = value;
    }
    let program: Bound['program'];
    if (b.program)
      try {
        if (!instrument.program)
          throw new RangeError('Instrument does not support program selection');
        const pieces = b.program.split('/'),
          last = pieces.pop()!,
          pc =
            integer(last, instrument.program.base, 127 + instrument.program.base) -
            instrument.program.base,
          bank =
            pieces.length === 1
              ? instrument.banks[pieces[0]]
              : pieces.map((n) => integer(n, 0, 127));
        if (!bank || (bank.length !== instrument.program.controllers.length && bank.length))
          throw new RangeError('Unknown bank or bank/controller mismatch');
        program = { bank, pc };
      } catch (error) {
        diagnostics.push(failure(error, b.span));
      }
    bound.push({
      part: part.name,
      instrument,
      port,
      channel,
      note,
      program,
      baselines,
      startupKeys: Object.keys(b.sets),
      span: b.span,
    });
  }
  const instances = new Map<string, Bound>();
  for (const b of bound) {
    const key = `${b.port.id}/${b.channel}`,
      prior = instances.get(key);
    if (
      prior &&
      JSON.stringify([{ ...prior.instrument, transpose: 0 }, prior.program, prior.baselines]) !==
        JSON.stringify([{ ...b.instrument, transpose: 0 }, b.program, b.baselines])
    )
      diagnostics.push(diagnostic('R004', `Conflicting definitions/startup on ${key}`, b.span));
    else instances.set(key, b);
  }
  return { setup, parts: bound, diagnostics, implicit: false };
}
export const gm: Record<string, number> = {
  kick: 36,
  snare: 38,
  clap: 39,
  hat: 42,
  closedhat: 42,
  openhat: 46,
  tom: 45,
  lowtom: 45,
  hightom: 50,
  rim: 37,
  ride: 51,
  crash: 49,
  shaker: 70,
  conga: 64,
};
export function implicitRig(parts: { name: string; role: string; lane?: string }[]): Rig {
  const port: Port = { id: 'main', name: 'Default MIDI output', rate: 3125, clock: false, span },
    setup: Setup = { id: 'implicit', ports: { main: port }, libraries: [], bindings: [], span },
    diagnostics: Diagnostic[] = [],
    bound: Bound[] = [];
  let channel = 1;
  for (const part of parts) {
    if (channel === 10) channel++;
    if (!part.lane && channel > 16) {
      diagnostics.push(
        diagnostic('I002', 'Implicit export has more than 15 pitched parts; provide a setup', span),
      );
      continue;
    }
    const note = part.lane ? gm[part.lane] : undefined;
    if (part.lane && note === undefined) {
      diagnostics.push(
        diagnostic('R003', `Unknown GM drum lane ${part.lane}; provide a setup`, span),
      );
      continue;
    }
    bound.push({
      part: part.name,
      instrument: base('implicit'),
      port,
      channel: part.lane ? 10 : channel++,
      note,
      baselines: {},
      span,
    });
  }
  diagnostics.push(
    diagnostic('I002', 'Export uses implicit channels/GM drums (notes only)', span, {
      severity: 'info',
      measured: { mapping: bound.map((b) => ({ part: b.part, channel: b.channel, note: b.note })) },
    }),
  );
  return { setup, parts: bound, diagnostics, implicit: true };
}
