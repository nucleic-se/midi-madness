# Software sounds

Use these presets through `sound <name>` in software scores, or `preset:<name>`
in a software setup. Sound selection is fixed for the part; changing it in a
`when` block is not supported.

```text
part harp
  sound ks-pluck
  plays notes | D4 . A4 . F#4 . E4 . |
  pluck.damping = 0.4
  pluck.brightness = 0.6
  pluck.decay = 2s
  pluck.pick = 0.3

part voices
  sound choir
  plays notes | D3+F#3+A3 _ _ _ |
  vowel = across 8 bars: ramp 0..1
  lfo.vowel = 0.15
```

Instrument controls, including voice/unison overrides and oscillator/filter
parameters, are documented in [INSTRUMENT_PARAMS.md](INSTRUMENT_PARAMS.md).

## Available presets

Use `mm help sound` for the list and `mm help sound NAME` for resolved preset values.
The default software setup selects presets by part name, then role, then the
`*` fallback. A part-level `sound NAME` overrides the selected preset. The
name-based bindings are:

| Member / selection | Preset |
|---|---|
| `bass` | `round-bass` |
| `acid` | `acid-303` |
| `arp` | `saw-pluck` |
| `pads` | `warm-pad` |
| `chords` | `stab` |
| `lead` | `warm-lead` |
| `counter` | `soft-square` |
| `drone` | `round-drone` |
| `seq` | `pluck-seq` |
| `fx` | `noise-sweep` |
| `keys` | `fm-keys` |
| Fallback after name and role bindings | `init` |
| Explicit additional selections | `ks-pluck`, `choir` |

`init` has full velocity sensitivity: gain follows `velocity^1.5` for each
voice, including note stacks. Other presets keep their chosen sensitivity.
Synthesized drums use the sixteen lanes listed in the render fixture guide.

## ks-pluck

A seeded-noise exciter feeds a tuned string waveguide. A fractional all-pass
sets pitch; a frequency-selective damper suppresses upper harmonics while its
unity response at the fundamental keeps the loop stable and accurately tuned.

| Control | Range and preset starting value | Behavior |
|---|---|---|
| `pluck.damping` | 0–1; 0.4 | Higher values remove upper harmonics faster. Applies to ringing voices. |
| `pluck.brightness` | 0–1; 0.6 | Excitation low-pass, exponential 300Hz–12kHz. Captured at attack. |
| `pluck.decay` | Normalized exponential 50ms–30s; 2s | Fundamental decay to −60dB, independent of upper-harmonic damping. Accepts fixed `ms`/`s` literals. |
| `pluck.pick` | 0–1; 0.3 | Pick-position comb in the excitation. Captured at attack. Endpoints are kept slightly away from exact cancellation. |

Twelve voices, no drift, single string per voice. Velocity controls amplitude.
The existing amp envelope still gates the note: use a long gate or release to
let the natural decay finish. Pitch bend and per-note tuning reach the waveguide.
Its current practical frequency range is 20Hz–6kHz at 48kHz; extremes clamp.
This is a synthesized string family, not a sampled guitar or a modal instrument.

## choir

A band-limited saw and breath noise feed three parallel vowel bands; the third
is quieter. A 5kHz low-pass and gentle stereo chorus follow them. Eight voices,
500ms attack, 1.2s release. The breath exciter is white noise. It produces sustained vowel colours;
consonants and syllables are not supported.

| Control | Range and preset starting value |
|---|---|
| `vowel` or `formant.vowel` | 0 A, 0.25 E, 0.5 I, 0.75 O, 1 U; preset 0.1 |
| `formant.shift` | −12…+12 semitones; numeric or a fixed `st` literal; preset 0 |
| `formant.resonance` | 0–1; preset 0.5. Higher values narrow the vowel bands. |
| `lfo.vowel` | 0–1 vowel-position depth; preset 0.15. Uses the existing LFO rate/shape and song clock. |

The three vowel centers in Hz are A: 800/1150/2900, E: 400/1700/2600,
I: 300/2200/3000, O: 450/800/2830, U: 325/700/2530. Morphing interpolates
frequencies logarithmically. `cutoff` still controls the following low-pass;
`noise` controls breath amount. Set `lfo.vowel = 0` for fixed vowel positions.

All listed controls accept the usual score expressions and `when` blocks.
Pluck controls on other modes, or vowel controls on non-formant sounds, are
reported as ignored. Unknown presets and incompatible preset definitions fail.

```sh
npm run mm -- help sound
npm run mm -- help sound choir
npm run mm -- render tests/fixtures/render/new-sounds.mm
```

The 22-bar listening fixture plays strings (0:00–0:09), five vowel positions
(0:09–0:31), then both together (0:31–0:49), followed by release tails.
It checks with `--setup setups/band/band.setup`; software-only controls require
that software target. MIDI exports do not turn
`sound` declarations into patch messages; use a MIDI setup for bank/program selection.
