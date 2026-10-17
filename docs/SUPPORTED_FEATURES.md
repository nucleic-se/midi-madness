# Supported features and limitations

The compiler produces musical events and controls. Audio rendering and MIDI consume those events through separate backends, with different sound and device capabilities.

## Score language

- Notes, hits, rests, holds, stacks, subdivisions, tuplets and exact rational durations.
- Motifs, rhythms, phrases, sections, forms, functions and pattern operations.
- Keys, chords, scale/chord-relative pitches, ranges and voice leading.
- Conditions, deterministic variation, curves, signals, section-keyed parameter lanes and onset-triggered controls.
- Recursive `.mmi` includes, typed part templates, literal loops and per-span value sequences.
- JSON/CSV automation lanes, source locations and dependency hashes.
- Inspection, expectations, formatting, accepted snapshots and versioned listening feedback.

Sound restyling layers import a complete score with `include score` and override
explicit parts, whole-part groups, FX declarations and bus controls. Musical
fields remain inherited; generated template/loop targets are unsupported. See
[Sound restyling](reference/LANGUAGE.md#sound-restyling).

See [Language reference](reference/LANGUAGE.md) for syntax and [Literal profile 1](reference/LITERAL_V1.md) for compatibility rules.

## Software audio

The renderer supports built-in synth and drum presets, including analog/FM sounds, a 303-style voice, plucked strings and choir. Controls cover oscillators, filters, two LFOs, modulation envelopes, mono/poly/unison, microtuning, per-note locks and paths, ratchets and synth grains.

Processing includes ordered inserts (including gain-adjustable bell/shelf EQ and
optional drive compensation), measured per-stage gain, named buses, sends and note throws, note-triggered bus ducking and buffer cuts. Output options include excerpts, solo/mute, member and grouped stems, analysis, stereo, analytic binaural and first-order ambisonics, with source/listener motion and propagation-derived Doppler. Single-pass part
and bus-return stems include peak/RMS and six-band spectral energy measurements;
shared returns remain separate from dry parts.

Current limits:

- Rendering uses 48 kHz. Default stereo/binaural WAVs are 24-bit PCM; ambisonics uses four-channel 32-bit float ACN/SN3D.
- Binaural output uses an analytic head model, not a measured HRTF.
- Excerpts render from song start before cropping.
- Reverb is a bus effect. Audio-follower sidechain ducking and insert reverb are unsupported.
- General arithmetic with native units is unsupported; fields accept the fixed literals and numeric ranges documented for them.
- Grains and per-note paths require pitched synth parts. Grouped stems do not support ambisonic output.
- The master safety stage is an instantaneous peak clamp. Reports give peak and RMS measurements; they do not perform automatic mastering or loudness matching.

See [Renderer](../packages/render/README.md) and its linked control references for exact ranges and additional processor-specific limits.

## Combined MIDI export and live playback

`export --midi` and live playback use instrument definitions and setups for notes, controller mappings, programs, articulation and device/port constraints. Combined export without a setup is notes-only, with automatic pitched channels and supported General MIDI drums.

Current limits:

- Implicit combined export permits at most fifteen pitched parts on one port; larger arrangements need an explicit setup.
- Live playback requires an explicit setup and available MIDI outputs.
- Software presets, inserts and bus DSP do not become hardware instrument definitions.
- This backend does not reproduce per-note paths or grains. Drum ratchet pitch changes also require software rendering; the MIDI backend reports these limitations.
- Controller traffic is adapted to configured device/port budgets. Required traffic exceeding capacity produces an error.

See [Using MIDI](guides/USING_MIDI.md) and [Instruments and setups](reference/INSTRUMENTS.md).

## DAW interchange

DAW packs include matching dry-part WAVs and per-part MIDI, complete effect returns,
a draft mix and import notes. MIDI-only per-part export compiles the software
performance without audio synthesis. Pitch paths use channel bend; conflicting
polyphonic bends, non-pitch voice paths and audio-only processing are reported
as representation losses. MPE and automatic destination instrument mapping are
unsupported. See [DAW export](guides/EXPORTING_TO_A_DAW.md).

## Graphics and shared data

Foundation provides headless time, curve, envelope and parameter primitives. Graphics provides structure/performance evaluation, adapters and composable Three.js effects. Renderer sidecars carry scheduled inputs and recorded voice envelopes, not post-effect audio levels.

See [Integration](INTEGRATION.md) for packages, peer versions, data contracts and artifact installation.
