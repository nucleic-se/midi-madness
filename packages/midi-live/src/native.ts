import { Output } from '@julusian/midi';
export type MidiOutput = { send(message: number[]): void; close(): void };
export function ports(): string[] {
  const output = new Output();
  try {
    return Array.from({ length: output.getPortCount() }, (_, i) => output.getPortName(i));
  } finally {
    output.closePort();
  }
}
export function openOutput(name: string): MidiOutput {
  const output = new Output(),
    matches = Array.from({ length: output.getPortCount() }, (_, i) => i).filter(
      (i) => output.getPortName(i) === name,
    );
  if (matches.length !== 1) {
    output.closePort();
    throw new Error(
      matches.length
        ? `MIDI output name is ambiguous: ${name}`
        : `MIDI output unavailable: ${name}`,
    );
  }
  output.openPort(matches[0]);
  return { send: (message) => output.sendMessage(message), close: () => output.closePort() };
}
