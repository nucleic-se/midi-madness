import type { PartIR } from '../../core/src/ir.ts';
import { Rational } from '@midi-madness/foundation/time';
import { voiceControl, supported, type SynthEvent } from '../../synth/src/engine.ts';

/** Keep performed timing, but preserve articulation from the written gates. */
export function scheduleNotes(
  part: PartIR,
  mono: boolean,
  position: (time: Rational) => number,
  offset: number,
  endSample: number,
  tuning?: (event: PartIR['events'][number]) => number,
): SynthEvent[] {
  const notes = part.events
    .filter(
      (e) =>
        e.pitch !== null &&
        e.velocity > 0 &&
        e.gate.numerator > 0n &&
        position(e.performedOnset) < endSample,
    )
    .sort((a, b) => a.nominalOnset.compare(b.nominalOnset))
    .map((event) => ({
      event,
      start: position(event.performedOnset),
      end: Math.min(endSample, position(event.performedOnset.add(event.gate))),
    }));
  if (mono)
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i],
        writtenEnd = n.event.nominalOnset.add(n.event.gate);
      // A long held note can span several shorter notes. Trim it at the first
      // later attack it does NOT overlap in the score, not just at its neighbor.
      let lo = i + 1,
        hi = notes.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (notes[mid].event.nominalOnset.compare(writtenEnd) < 0) lo = mid + 1;
        else hi = mid;
      }
      const separate = notes[lo];
      if (separate && n.end > separate.start) n.end = separate.start;
      let nextIndex = i + 1;
      while (
        nextIndex < notes.length &&
        notes[nextIndex].event.nominalOnset.equals(n.event.nominalOnset)
      )
        nextIndex++;
      const next = notes[nextIndex];
      if (next && writtenEnd.compare(next.event.nominalOnset) > 0 && n.end <= next.start)
        n.end = Math.min(endSample, next.start + 1);
    }
  return notes.flatMap((n) => [
    {
      sample: n.start + offset,
      type: 'on' as const,
      id: n.event.id,
      pitch: n.event.pitch! + ((n.event.locks.cents ?? 0) + (tuning?.(n.event) ?? 0)) / 100,
      velocity: n.event.velocity,
      grainSamples: n.event.grain ? n.end - n.start : undefined,
      paths: n.event.paths?.map((path) => {
        if (path.name !== 'pitch' && (!voiceControl(path.name) || !supported.has(path.name)))
          throw new RangeError(`Unsupported per-note path ${path.name}`);
        const from = path.from ?? 0;
        const to =
          path.name === 'pitch' && path.absolutePitch ? (path.to - n.event.pitch!) * 100 : path.to;
        if (
          !Number.isFinite(from) ||
          !Number.isFinite(to) ||
          (path.curve !== 'linear' && (from <= 0 || to <= 0))
        )
          throw new RangeError(
            `Note path ${path.name}: exp/log endpoints must remain positive after pitch resolution`,
          );
        return { ...path, samples: position(path.duration), to, from };
      }),
      pan: n.event.locks.pan,
      panOffset: n.event.panOffset,
      locks: Object.fromEntries(
        Object.entries(n.event.locks).filter(([key]) => key !== 'cents' && voiceControl(key)),
      ),
      sends: Object.fromEntries(
        Object.entries(n.event.locks)
          .filter(([key]) => key.startsWith('send.') && !key.endsWith('.pre'))
          .map(([key, v]) => [key.slice(5), v]),
      ),
    },
    { sample: Math.max(n.start + 1, n.end) + offset, type: 'off' as const, id: n.event.id },
  ]);
}
