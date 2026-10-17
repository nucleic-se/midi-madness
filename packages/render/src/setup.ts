import { readFileSync } from 'node:fs';
import {
  preset,
  configuredPreset,
  members,
  roles,
  memberMix,
  type Preset,
} from '../../synth/src/presets.ts';
import { lanes } from '../../synth/src/drums.ts';
import type { PartIR } from '../../core/src/ir.ts';
export type SoftwareBinding = { selector: string; instrument: 'synth' | 'drums'; preset: string };
export type SoftwareSetup = { sampleRate: number; bindings: SoftwareBinding[] };
export const defaultSetup = new URL('../../../setups/band/band.setup', import.meta.url);
export function loadSoftwareSetup(path: string | URL = defaultSetup): SoftwareSetup {
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean);
  if (!/^setup\s+\S+$/.test(lines[0] ?? ''))
    throw new RangeError('Software setup needs a setup header');
  const setup: SoftwareSetup = { sampleRate: 48000, bindings: [] };
  const engines = new Set<string>();
  for (const line of lines.slice(1)) {
    const engine = line.match(/^engine\s+(\w+)\s*=\s*software\s+(\d+)kHz$/);
    if (engine) {
      if (engine[2] !== '48') throw new RangeError('First renderer supports 48kHz only');
      engines.add(engine[1]);
      continue;
    }
    const binding = line.match(
      /^(\S+)\s*=\s*(synth|drums)\s+engine:(\w+)(?:\s+(?:preset|kit):([\w-]+))?$/,
    );
    if (!binding || !engines.has(binding[3]))
      throw new RangeError(`Invalid software binding: ${line}`);
    if (binding[2] === 'drums' && binding[4] && binding[4] !== '808-909')
      throw new RangeError(`Unknown kit ${binding[4]}`);
    if (binding[2] === 'synth') preset(binding[4] ?? 'init');
    if (setup.bindings.some((b) => b.selector === binding[1]))
      throw new RangeError(`Duplicate software binding ${binding[1]}`);
    setup.bindings.push({
      selector: binding[1],
      instrument: binding[2] as 'synth' | 'drums',
      preset: binding[4] ?? 'init',
    });
  }
  if (!engines.size) throw new RangeError('Software setup needs an engine');
  return setup;
}
export function bindSoftware(
  setup: SoftwareSetup,
  part: PartIR,
  sound?: string,
  overrides?: Partial<Preset>,
) {
  const selectors = part.lane
    ? [part.name, `lane:${part.lane}`, 'lane:*']
    : [part.name, `role:${part.role}`, '*'];
  const b = selectors.map((s) => setup.bindings.find((b) => b.selector === s)).find(Boolean);
  if (!b) throw new RangeError(`No software binding for ${part.name}`);
  if (part.lane && b.instrument !== 'drums')
    throw new RangeError(`${part.name} is a drum lane, needs drums binding`);
  if (part.lane && !lanes.includes(part.lane))
    throw new RangeError(`Unknown drum lane ${part.lane}`);
  if (sound && part.lane)
    throw new RangeError('Synth sound selection is not supported on drum lanes');
  if (overrides && part.lane)
    throw new RangeError('Mono/voices/unison configuration is only supported on synth parts');
  if (!part.lane) configuredPreset(sound ?? b.preset, overrides);
  return { ...b, preset: sound ?? b.preset, mix: memberMix(part.name) };
}
export function softwareArticulation(
  parts: PartIR[],
  setup: SoftwareSetup,
  sounds: Record<string, string> = {},
  overrides: Record<string, Partial<Preset>> = {},
) {
  return parts
    .filter(
      (p) =>
        !p.lane &&
        configuredPreset(bindSoftware(setup, p, sounds[p.name]).preset, overrides[p.name]).mono,
    )
    .map((p) => {
      const notes = p.events
        .filter((e) => e.velocity > 0 && Number(e.gate.numerator) > 0)
        .sort((a, b) => a.nominalOnset.compare(b.nominalOnset));
      let slides = 0;
      let held: typeof notes = [];
      for (const e of notes) {
        held = held.filter((n) => n.nominalOnset.add(n.gate).compare(e.nominalOnset) > 0);
        if (held.length && held.at(-1)!.pitch !== e.pitch) slides++;
        held.push(e);
      }
      return { part: p.name, notes: notes.length, slides };
    });
}
export const softwareDomains = (parts: { name: string }[]) =>
  Object.fromEntries(parts.map((p) => [p.name, { envamount: [-1, 1] as const }]));
