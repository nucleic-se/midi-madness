# Architecture

The score language describes musical material and performance controls. Instrument and setup files describe how backends play that material. Both software audio and MIDI start from the compiler's realized events.

## Packages

| Package | Responsibility |
|---|---|
| `core` | Include/data loading, templates, parsing, resolution, material expansion, harmony, event/control realization, diagnostics and inspection |
| `cli` | File entry points, commands, structured output, snapshots and listening feedback |
| `render` | Software score settings, scheduling, audio output, performance sidecars, reports and analysis |
| `synth` | Presets, voice/drum models, modulation, inserts, buses and spatial DSP |
| `midi` | Instrument/setup resolution, articulation, controllers, output budgets and MIDI files |
| `midi-live` | Native ports, playback scheduling, transport and note cleanup |
| `foundation` | Shared rational time, clocks, curves, envelopes and numeric parameters |
| `graphics` | Structure/performance evaluation, adapters, mappings and visual effects |

## File loading and compilation

The CLI loads disk scores through `loadScore` in `packages/core/src/include.ts`. Loading expands recursive includes, resolves data paths and collects dependency hashes and a source line map. This preserves original file locations for diagnostics.

Templates and literal loops expand into ordinary parts before parsing and realization. The compiler resolves names, material, form and harmony, then realizes musical events and controls. Provenance identifies original definitions and invocations. Exact rational whole-note time preserves the grid through operations and scheduling; deterministic random addresses keep local edits from reshuffling unrelated material.

Software-only fields are prepared by the render package. Device adaptation belongs to MIDI, rather than the core score grammar.

## Software rendering

`packages/render/src/render.ts` prepares software settings, realizes the score, validates inserts and sends, binds presets and schedules backend events. `packages/synth` evaluates voices and drum hits, note-local controls and paths, modulation and effects.

Member processing and named buses feed the mix. Bus routing cycles are rejected. Spatial sources use listener/source lanes, direction, distance, air absorption and propagation delay. A safety ceiling bounds the emitted mix.

The renderer writes the WAV, a versioned event sidecar and reports unless disabled. The sidecar records actual scheduled inputs and recorded envelopes. Optional analysis adds member stems, images and measurements; grouped stems use a separate contribution pass.

Excerpts render from song start before cropping so held voices, automation and effect state are retained. See [Rendering audio](guides/RENDERING_AUDIO.md) for output behavior and [Spatial audio](../packages/render/SPATIAL.md) for coordinate/data contracts.

## MIDI compilation and playback

Instrument definitions map named parameters and drum lanes onto MIDI. Setups select parts, devices, ports, channels, programs and startup values. The compiler resolves articulation, samples controls, adapts optional traffic to output budgets and writes a MIDI file or an ordered live-playback schedule.

Live playback opens configured outputs and handles transport, range entry, looping and cleanup. Software sounds and effects are not translated into hardware sound definitions. See [Using MIDI](guides/USING_MIDI.md).

## Shared time and performance data

Foundation is built ESM with TypeScript declarations. Core imports rational arithmetic from `@midi-madness/foundation/time`; score time uses whole notes, while the shared playback interface uses quarter-note beats. Clock and origin conversions are explicit. The host supplies the clock and owns audio/MIDI devices.

Graphics consumes structure or performance data through explicit adapters. Its performance API uses media seconds, positioned voices, listener lanes and caller-supplied voice/envelope semantics. The renderer sidecar adapter converts sample coordinates without inventing DSP state.

See [CLI and library integration](INTEGRATION.md) for application interfaces and [Contributing](../CONTRIBUTING.md) for validation.
