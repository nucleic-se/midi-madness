import { readFileSync } from 'node:fs';
import { openOutput, ports } from '../../../midi-live/src/native.ts';
import { play, panic } from '../../../midi-live/src/player.ts';
import { parseSetup } from '../../../midi/src/config.ts';
import { timeAt } from '../../../core/src/inspect.ts';
import type { RealizationResult } from '../../../core/src/index.ts';
import type { Timeline } from '../../../midi/src/notes.ts';
export { ports };
export function panicFile(file: string) {
  const parsed = parseSetup(readFileSync(file, 'utf8'), file);
  if (!parsed.setup || parsed.diagnostics.length)
    return { diagnostics: parsed.diagnostics, result: { sent: 0 } };
  const setup = parsed.setup,
    channels = new Map<string, Set<number>>();
  for (const b of setup.bindings) {
    const set = channels.get(b.port) ?? new Set<number>();
    if (b.channel) set.add(b.channel);
    for (const lane of Object.values(b.lanes)) if (lane.channel) set.add(lane.channel);
    channels.set(b.port, set);
  }
  if (channels.size !== 1) throw new RangeError('Panic requires one configured output');
  const [id, set] = [...channels][0],
    port = setup.ports[id];
  if (!port || !set.size) throw new RangeError('Panic setup has no usable channels/output');
  const output = openOutput(port.name);
  try {
    return {
      diagnostics: [],
      result: { sent: panic(output, [...set]), channels: [...set], port: port.name },
    };
  } finally {
    output.close();
  }
}
export async function playFile(
  realized: RealizationResult,
  timeline: Timeline,
  options: {
    from?: string;
    bars?: string;
    loop?: boolean;
    clock?: string;
    json?: boolean;
    quiet?: boolean;
  },
) {
  const outputs = [...new Set(timeline.rig.parts.map((b) => b.port.name))];
  if (outputs.length !== 1)
    throw new RangeError('Live playback requires exactly one bound MIDI output');
  let from = options.from ? timeAt(timeline.song, options.from, true) : undefined,
    to;
  if (options.bars) {
    const match = options.bars.match(/^(\d+)\.\.(\d+)$/);
    if (!match) throw new RangeError('Bars must be A..B');
    const [a, b] = [Number(match[1]), Number(match[2])];
    if (a > b || a < 1 || b > timeline.song.bars.length)
      throw new RangeError('Bar range is outside song');
    from = timeline.song.bars[a - 1].onset;
    to = timeline.song.bars[b - 1].onset.add(timeline.song.bars[b - 1].span);
  }
  if (options.from && options.bars) throw new RangeError('Choose --from or --bars');
  if (options.clock && !['send', 'off'].includes(options.clock))
    throw new RangeError('Clock must be send/off');
  const controller = new AbortController(),
    stop = () => controller.abort();
  const output = openOutput(outputs[0]);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    return await play(realized, timeline, output, {
      from,
      to,
      loop: options.loop,
      clock: options.clock ? options.clock === 'send' : undefined,
      signal: controller.signal,
      position:
        options.json || options.quiet ? undefined : (text) => process.stderr.write(text + '\n'),
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    output.close();
  }
}
