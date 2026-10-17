import type { LineOrigin } from './include.ts';

/** Source rows retain provenance while a derived score changes its sound. */
export type SourceRow = { text: string; origin: LineOrigin };
export class RestyleError extends Error {
  readonly origin: LineOrigin;
  constructor(message: string, origin: LineOrigin) {
    super(message);
    this.origin = origin;
  }
}

const clean = (row: SourceRow) => row.text.replace(/\/\/.*$/, '').trim();
const depth = (row: SourceRow) => row.text.match(/^\s*/)?.[0].length ?? 0;
const fail = (row: SourceRow, message: string): never => {
  throw new RestyleError(message, row.origin);
};
function blocks(rows: SourceRow[]): SourceRow[][] {
  const result: SourceRow[][] = [];
  for (const row of rows) {
    if (!result.length || (clean(row) && depth(row) === 0)) result.push([]);
    result.at(-1)!.push(row);
  }
  return result;
}
const soundControls = new Set(
  (
    'cutoff res envamount attack decay sustain release level level.db pan drive wave detune ' +
    'noise sub glide reverb delay fold pw vowel velSens sync bend.range ' +
    'filterattack filterdecay filtersustain filterrelease'
  ).split(' '),
);
const soundPrefixes =
  /^(?:osc[12]|filter|unison|fm|lfo2?|modenv|pluck|formant|drum|send|insert|ring|comb|space)\./;
function fieldKey(row: SourceRow, bus: boolean, conditional: boolean): string {
  const text = clean(row);
  if (!conditional && /^(sound|mono|voices|unison)\s+\S/.test(text) && !bus)
    return text.split(/\s+/)[0];
  if (!conditional && /^duck\s+\S/.test(text) && bus) return 'duck';
  const assignment = text.match(/^([A-Za-z][\w.-]*)\s*=\s*\S/);
  if (assignment) {
    const key = assignment[1];
    if (bus || key === 'insert' || soundControls.has(key) || soundPrefixes.test(key)) return key;
  }
  return fail(row, `Restyling cannot change musical fields: ${text}`);
}
/** Separate direct fields and single-level conditional fields; never edit note material. */
function entries(rows: SourceRow[], bus: boolean, strict: boolean) {
  const result: { key: string; rows: SourceRow[]; conditional: boolean }[] = [];
  let condition: (typeof result)[number] | undefined;
  const seen = new Set<string>();
  for (const row of rows) {
    const text = clean(row);
    if (!text) {
      if (condition) condition.rows.push(row);
      else result.push({ key: '', rows: [row], conditional: false });
      continue;
    }
    if (strict && ![2, 4].includes(depth(row)))
      fail(row, 'Restyle fields use two spaces; conditional fields use four');
    if (depth(row) === 2 && /^when\s+.+:$/.test(text)) {
      const key = text.replace(/\s+/g, ' ');
      if (strict && seen.has(key)) fail(row, `Duplicate restyle condition ${key}`);
      seen.add(key);
      condition = { key, rows: [row], conditional: true };
      result.push(condition);
    } else if (depth(row) > 2 && condition) {
      if (strict) fieldKey(row, bus, true);
      condition.rows.push(row);
    } else if (!strict && depth(row) > 2 && result.length) {
      result.at(-1)!.rows.push(row);
    } else {
      if (strict && depth(row) !== 2) fail(row, 'Expected a direct restyle field');
      condition = undefined;
      const key = strict
        ? fieldKey(row, bus, false)
        : (text.match(/^([A-Za-z][\w.-]*)\s*(?:=|\s)/)?.[1] ?? text);
      if (strict && seen.has(key)) fail(row, `Duplicate restyle field ${key}`);
      seen.add(key);
      result.push({ key, rows: [row], conditional: false });
    }
  }
  return result;
}
function mergeFields(base: SourceRow[], patch: SourceRow[], bus: boolean, conditional = false) {
  // Conditional bodies are temporarily normalized to direct-field indentation.
  const shift = (row: SourceRow, amount: number): SourceRow => ({
    text: amount < 0 ? row.text.slice(-amount) : ' '.repeat(amount) + row.text,
    origin: { ...row.origin, indent: row.origin.indent + amount },
  });
  const normalize = (rows: SourceRow[]) => (conditional ? rows.map((r) => shift(r, -2)) : rows);
  const target = entries(normalize(base), bus, false);
  const changes = entries(normalize(patch), bus, true);
  for (const change of changes)
    if (change.conditional) {
      const nested = entries(
        change.rows.slice(1).map((r) => shift(r, -2)),
        bus,
        true,
      );
      for (const field of nested) {
        if (field.conditional) fail(field.rows[0], 'Nested restyle conditions are not supported');
        if (field.key) fieldKey(field.rows[0], bus, true);
      }
    }

  if (conditional)
    for (const change of changes) {
      if (change.conditional) fail(change.rows[0], 'Nested restyle conditions are not supported');
      if (change.key) fieldKey(change.rows[0], bus, true);
    }
  for (const change of changes) {
    if (!change.key) continue;
    const index = target.findLastIndex((e) => e.key === change.key);
    if (index < 0) target.push(change);
    else if (change.conditional)
      target[index] = {
        ...target[index],
        rows: [
          target[index].rows[0],
          ...mergeFields(target[index].rows.slice(1), change.rows.slice(1), bus, true),
        ],
      };
    else target[index] = change;
  }
  const result = target.flatMap((e) => e.rows);
  return conditional ? result.map((r) => shift(r, 2)) : result;
}

/** Apply ordered sound-only patches to already expanded, complete score rows. */
export function applyRestyles(rows: SourceRow[]): SourceRow[] {
  const output: SourceRow[][] = [];
  for (const block of blocks(rows)) {
    const first = block[0];
    const text = clean(first);
    if (!/^restyle\b/.test(text)) {
      output.push(block);
      continue;
    }
    const match = text.match(/^restyle\s+(part|group|bus)\s+([A-Za-z][\w-]*)$/);
    if (text === 'restyle fx') {
      for (const row of block.slice(1))
        if (clean(row) && !(depth(row) === 2 && /^bus\s+[A-Za-z][\w-]*\s*=\s*\S/.test(clean(row))))
          fail(row, 'restyle fx accepts bus declarations only');
      const indices = output.flatMap((b, i) => (clean(b[0]) === 'fx' ? [i] : []));
      if (indices.length > 1) fail(first, 'Cannot restyle duplicate fx blocks');
      const replacement = [
        { text: 'fx', origin: { ...first.origin, indent: first.origin.indent - 8 } },
        ...block.slice(1),
      ];
      if (indices.length) output[indices[0]] = replacement;
      else output.push(replacement);
      continue;
    }
    if (!match) fail(first, 'Expected restyle part NAME, group NAME, bus NAME or fx');
    const [, kind, name] = match!;
    let targets = output.filter(
      (b) => clean(b[0]) === `${kind === 'group' ? 'part' : kind} ${name}`,
    );
    if (kind === 'group')
      targets = output.filter(
        (b) =>
          /^part\s+[A-Za-z][\w-]*$/.test(clean(b[0])) &&
          b.some((r) => depth(r) === 2 && clean(r) === `group ${name}`),
      );
    if (!targets.length && kind === 'bus') {
      const declared = output.some(
        (b) =>
          clean(b[0]) === 'fx' &&
          b.slice(1).some((r) => new RegExp(`^bus\\s+${name}\\s*=`).test(clean(r))),
      );
      if (declared || ['room', 'echo'].includes(name)) {
        const target = [
          { text: `bus ${name}`, origin: { ...first.origin, indent: first.origin.indent - 8 } },
        ];
        output.push(target);
        targets = [target];
      }
    }
    if (!targets.length)
      fail(
        first,
        `Unknown or generated restyle ${kind} ${name}; targets must be explicit declarations`,
      );
    if (kind !== 'group' && targets.length !== 1) fail(first, `Ambiguous restyle ${kind} ${name}`);
    // Validate even an otherwise empty patch; a target header alone is a legal no-op.
    for (const target of targets) {
      const body = mergeFields(target.slice(1), block.slice(1), kind === 'bus');
      target.splice(1, target.length - 1, ...body);
    }
  }
  return output.flat();
}
