import { diagnostic, type Diagnostic } from '../../core/src/diag.ts';
import type { RealizationResult } from '../../core/src/index.ts';
import { configuredPreset, type Preset } from '../../synth/src/presets.ts';
import { bindSoftware, type SoftwareSetup } from './setup.ts';
import type { Tuning } from './tuning.ts';

export function softwareWarnings(
  result: RealizationResult,
  setup: SoftwareSetup,
  sounds: Record<string, string>,
  overrides: Record<string, Partial<Preset>>,
  tuning: Tuning,
): Diagnostic[] {
  const warnings: Diagnostic[] = [];
  for (const part of result.song?.parts ?? []) {
    if (part.lane || part.name.startsWith('fxbus__')) continue;
    const binding = bindSoftware(setup, part, sounds[part.name], overrides[part.name]);
    if (!configuredPreset(binding.preset, overrides[part.name]).mono) continue;
    const groups = new Map<string, number>();
    for (const note of part.events)
      if (note.pitch !== null && note.velocity > 0 && note.gate.numerator > 0n)
        groups.set(
          note.nominalOnset.toString(),
          (groups.get(note.nominalOnset.toString()) ?? 0) + 1,
        );
    const stacks = [...groups.values()].filter((n) => n > 1);
    if (stacks.length)
      warnings.push(
        diagnostic(
          'D002',
          `Mono software part ${part.name} (${binding.preset}) has ${stacks.length} simultaneous note stacks; they share one voice and can become slides. Use mono off and voices 8 for chords, or write a single line`,
          result.resolution.parts.get(part.name)?.span ?? result.ast.span,
          {
            severity: 'warning',
            path: `part ${part.name}`,
            measured: {
              stackCount: stacks.length,
              maxStack: stacks.reduce((a, b) => Math.max(a, b), 0),
            },
          },
        ),
      );
  }
  if (tuning.kind === 'chord' && result.harmony && result.song) {
    const roots = new Set([
      ...result.song.sections.map((s) => result.harmony!.chordAt(s.onset).root),
      ...result.harmony.layers.flatMap((l) =>
        l.chords.map((c) => result.harmony!.chordAt(c.onset).root),
      ),
    ]);
    if (roots.size === 1)
      warnings.push(
        diagnostic(
          'P007',
          'Chord tuning uses one declared harmony root throughout this song; note stacks do not set the tuning root. Write a changing harmony progression, use an explicit tuning table, or use per-note cents',
          result.ast.span,
          { severity: 'warning', path: 'song tuning', measured: { roots: [...roots] } },
        ),
      );
  }
  return warnings;
}
