import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from '../../../core/src/parser.ts';
import { diagnostic, type Diagnostic } from '../../../core/src/diag.ts';
import {
  parseSetup,
  parseInstrument,
  resolveRig,
  type Instrument,
  type Rig,
} from '../../../midi/src/config.ts';
export function loadRig(file: string, source: string): Rig {
  const parsed = parseSetup(readFileSync(file, 'utf8'), file),
    diagnostics: Diagnostic[] = [...parsed.diagnostics];
  if (!parsed.setup)
    return {
      setup: {
        id: 'invalid',
        ports: {},
        libraries: [],
        bindings: [],
        span: { line: 1, col: 1, endLine: 1, endCol: 1 },
      },
      parts: [],
      diagnostics,
      implicit: false,
    };
  const library: Record<string, Instrument> = {};
  for (const path of parsed.setup.libraries) {
    const root = resolve(dirname(file), path),
      files = statSync(root).isDirectory()
        ? readdirSync(root)
            .filter((f) => f.endsWith('.inst'))
            .sort()
            .map((f) => resolve(root, f))
        : [root];
    for (const filename of files) {
      const result = parseInstrument(readFileSync(filename, 'utf8'), filename);
      diagnostics.push(...result.diagnostics);
      if (result.instrument) {
        const id = result.instrument.id;
        if (library[id])
          diagnostics.push(
            diagnostic('R004', `Duplicate instrument ${id}`, result.instrument.span, {
              file: filename,
            }),
          );
        else library[id] = result.instrument;
      }
    }
  }
  const parts = parse(source)
    .ast.statements.filter((s) => s.kind === 'part')
    .map((s) => {
      const lane = s.fields.find((f) => f.kind === 'field' && f.name === 'lane'),
        role = s.fields.find((f) => f.kind === 'field' && f.name === 'role');
      const word = (f: typeof lane) =>
        f?.kind === 'field' && f.value.kind === 'clause' ? f.value.tokens[0] : undefined;
      return { name: s.name, lane: word(lane), role: word(role) ?? (lane ? 'pulse' : 'bed') };
    });
  const rig = resolveRig(parsed.setup, library, parts);
  rig.diagnostics.unshift(...diagnostics);
  return rig;
}
export function domains(rig: Rig) {
  return Object.fromEntries(
    rig.parts.map((b) => [
      b.part,
      Object.fromEntries(
        Object.values(b.instrument.params).map((p) => [
          p.name,
          [p.bipolar ? -1 : 0, 1] as readonly [number, number],
        ]),
      ),
    ]),
  );
}
export function rigSummary(rig: Rig) {
  return rig.parts.map((b) => ({
    part: b.part,
    instrument: b.instrument.id,
    port: b.port.name,
    channel: b.channel,
    transpose: b.instrument.transpose,
    note: b.note,
    program: b.program,
    defaults: b.baselines,
  }));
}
