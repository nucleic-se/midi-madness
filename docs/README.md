# Documentation

midi-madness turns text scores into musical events for audio rendering, MIDI export and live playback. Start with a guide for your task, then use the references for syntax and parameter details.

All `npm run mm -- ...` commands below run from the repository root after `npm ci`.

## Learn and use the tools

| Goal | Guide |
|---|---|
| Write notes, drums and sections | [Writing a song](guides/WRITING_A_SONG.md) |
| Make a WAV, excerpt, stem or analysis page | [Rendering audio](guides/RENDERING_AUDIO.md) |
| Export matching stems and MIDI for a DAW | [Exporting to a DAW](guides/EXPORTING_TO_A_DAW.md) |
| Export a MIDI file or connect a device | [Using MIDI](guides/USING_MIDI.md) |
| Find errors, inspect events and compare revisions | [Inspecting scores](guides/INSPECTING_SCORES.md) |
| Try a complete arrangement | [Examples](../examples/README.md) |

[Supported features and limitations](SUPPORTED_FEATURES.md) explains the compiler and backend capabilities. Software-renderer settings and MIDI instrument mappings are distinct; choose the guide for the output you need.

## Language and command reference

- [Language](reference/LANGUAGE.md): notation, types, harmony, curves, conditions, parts and execution rules.
- [CLI](reference/TOOLING.md): commands, flags, JSON output and diagnostics.
- [Instruments and setups](reference/INSTRUMENTS.md): device definitions, controller mappings, channels and routing.
- [Literal profile 1](reference/LITERAL_V1.md): score-compatibility rules and reproducibility.

The [reference index](reference/README.md) links directly to common topics.

## Audio controls

| Topic | Reference |
|---|---|
| Output, reports and renderer limits | [Software renderer](../packages/render/README.md) |
| Synth and drum presets | [Sounds](../packages/render/SOUNDS.md) |
| Oscillators, filters, envelopes and voice controls | [Instrument parameters](../packages/render/INSTRUMENT_PARAMS.md) |
| LFOs, bends and modulation effects | [Modulation](../packages/render/MODULATION.md) |
| Sends, returns and effect routing | [Effect buses](../packages/render/EFFECTS.md) |
| Insert chains, tuning and analysis | [Inserts and tuning](../packages/render/INSERTS.md) |
| Curves, external data, note paths, ratchets, grains and groups | [Primitives](../packages/render/PRIMITIVES.md) |
| Listener/source motion, binaural and ambisonic output | [Spatial audio](../packages/render/SPATIAL.md) |
| Reusable fragments, templates and value sequences | [Score workflows](../packages/render/WORKFLOW.md) |

## Libraries and development

- [CLI and package integration](INTEGRATION.md): scripting, exported packages and performance event data.
- [Foundation](../packages/foundation/README.md): time, curves, envelopes and parameter evaluation.
- [Graphics](../packages/graphics/README.md): performance adapters, mappings and visual effects.
- [Architecture](ARCHITECTURE.md): compiler and backend data flow.
- [Deterministic variation](../packages/core/VARIATION.md): event addressing and seeded draws.
- [Contributing](../CONTRIBUTING.md): dependencies, validation and documentation conventions.
