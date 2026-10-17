import { generatedEvents } from '../../core/src/note-generators.ts';
import { diagnostic } from '../../core/src/diag.ts';
import { checkExpectations } from '../../core/src/expect.ts';
import { Rational as R } from '@midi-madness/foundation/time';
import { planPort } from './port-plan.ts';
import { initialize, checkLoad } from './startup.ts';
import type { RealizationResult } from '../../core/src/index.ts';
import type { Rig } from './config.ts';
import { compileNotes, sorted, type Timeline } from './notes.ts';
import { compileControls, selection } from './controls.ts';
export function compileMidi(
  realized: RealizationResult,
  rig: Rig,
  options: { clock?: boolean } = {},
): Timeline {
  if (!realized.song) throw new RangeError('MIDI compilation requires a form');
  const secondsPerWhole =
    240 / (Number(realized.song.tempo.numerator) / Number(realized.song.tempo.denominator));
  const song = {
    ...realized.song,
    parts: realized.song.parts.map((part) => ({
      ...part,
      events: part.events.flatMap((e) =>
        e.generator?.kind === 'ratchet'
          ? generatedEvents(e, secondsPerWhole, realized.song!.seed)
          : [e],
      ),
    })),
  };
  const timeline = compileNotes(song, rig);
  for (const part of song.parts) {
    if (part.lane && part.events.some((e) => e.locks['drum.generated.pitch']))
      timeline.diagnostics.push(
        diagnostic(
          'I003',
          `${part.name}: drum ratchet pitch needs software rendering; MIDI exports the written drum notes`,
          realized.ast.span,
          { severity: 'warning' },
        ),
      );
    if (part.events.some((e) => e.paths?.length || e.generator?.kind === 'grains'))
      timeline.diagnostics.push(
        diagnostic(
          'I003',
          `${part.name}: per-note paths and grains need the software renderer; MIDI cannot reproduce them`,
          realized.ast.span,
          { severity: 'warning' },
        ),
      );
  }
  compileControls(realized, timeline);
  initialize(timeline);
  timeline.messages = selection(sorted(timeline.messages));
  planPort(timeline, options.clock ?? rig.parts[0]?.port.clock ?? false);
  checkLoad(timeline, options.clock ?? rig.parts[0]?.port.clock ?? false);
  if (realized.structure) {
    const deviceParts = timeline.song.parts.map((part) => ({
      ...part,
      events: timeline.notes
        .filter((n) => n.event.part === part.name)
        .map((n) => ({ ...n.event, pitch: n.pitch, gate: new R(n.end - n.start, 3840) })),
    }));
    timeline.diagnostics.push(
      ...checkExpectations(realized.resolution, realized.structure, timeline.song.parts, {
        deviceParts,
        onlyDevice: true,
      }),
    );
  }
  return timeline;
}
