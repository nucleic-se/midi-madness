# Instrument parameters

Software-only controls for the existing instruments. Use `mm render` or
`mm check --setup setups/band/band.setup`. Existing presets and parameter mappings
keep their defaults; new controls only alter a sound when explicitly set.

## Voice configuration

```text
part arp
  sound saw-pluck
  mono off
  voices 8
  unison 4
  unison.spread = 24ct
  unison.width = 1
  plays notes | D3+F3+A3 _ _ _ |
```

`mono on/off`, `voices N` (1–32, also `voices poly N` / `voices mono`), and
`unison N` (1–8) are fixed part declarations. Put them directly under the part,
not in a `when` block or expression. Voices implies poly unless mono was explicitly
set; turning off a mono preset without a voice count gives eight voices.
The checker and renderer use the same override for articulation and scheduling.
Plucked strings currently require unison 1. Drum parts reject synth configuration.

## Oscillators and voice filters

| Control | Values |
|---|---|
| `osc1.level`, `osc2.level` | Linear amplitude 0–1; init's second oscillator starts off |
| `osc1.wave`, `osc2.wave` | Existing 0–1 sine/triangle/saw/pulse morph; independent oscillators |
| `osc1.fine`, `osc2.fine` | −100…+100 cents; fixed `ct` literals or numeric cents |
| `osc2.semitone` | −48…+48 semitones; fixed `st` literals or numeric semitones |
| `pw` | Pulse width 0.02–0.98, applied to both analog oscillators |
| `fm.index` | 0–20; phase-modulates the analog carrier, or sets the FM preset's envelope-scaled index |
| `fm.ratio` | 0.01–32 modulator/carrier frequency ratio; analog FM uses oscillator 2 as its modulator |
| `sync` | 0 off; nonzero enables analog oscillator-2 hard sync to oscillator 1 |
| `sync.ratio` | 1–16 slave/master frequency ratio, independent of osc2 tuning while sync is on |
| `fold` | 0–1 wavefolder amount; 0 preserves the signal |
| `filter.type` | `lp12`, `lp24`, `hp12`, `hp24`, `bp`, `notch`, `lp18`; numeric 0–6 in that order |
| `keytrack` | 0–2 octaves of cutoff movement per pitch octave, relative to C4 |
| `filter.fm` | 0–4 octaves from oscillator 1; numeric or fixed `oct` literal |
| `unison.spread` | 0–100 cents; uses the detune spacing of the unison voices |
| `unison.width` | 0–1 stereo unison spread |
| `velSens` | 0–1 velocity sensitivity; 0 ignores velocity, 1 uses velocity^1.5 |

These are voice filters, before member inserts. Each voice retains its own filter
state. `cutoff`, `resonance`, `envamount` and the existing filter envelope still apply.
The choir keeps its vowel bank ahead of the selected filter. Hard sync/folding and
audio-rate modulation are draft DSP; extreme ratios can produce aliasing.

Oscillator wave/mix/PW/sync controls are intended for analog sounds. FM presets
use the carrier level/tuning and FM index/ratio; osc2 tuning offsets its operator.
Analog FM uses `fm.ratio` in place of ordinary oscillator-2 tuning. Pluck voices
report unsupported oscillator-2, FM, sync, fold and filter-FM controls as ignored.
`detune` uses a normalized 0–50-cent mapping; `unison.spread` uses native
cents. If both are assigned, the most recently applied control wins.

## Amplitude and filter envelope times

`attack`, `decay`, `release` and their `filter.` equivalents accept explicit
`ms`/`s` literals, and `note(1/8)` durations at the song tempo. Dotted and triplet
forms work: `note(1/8.)`, `note(1/8t)`. The valid range is 1ms–5.001s.
Unitless values and arithmetic remain normalized 0–1, using
`seconds = 0.001 + 5 × value³`; `attack = 1/8` therefore retains its existing
normalized meaning. Native durations invert that mapping before compilation.
The song's default tempo is 100 BPM. An authored `define note(...)` function
keeps precedence over the convenience spelling; use ms/s when it is present.

```text
attack = 10ms
decay = note(1/8)
release = across section: ramp 50ms..500ms
filter.decay = per 1 bar: 120ms, note(1/8)
```

Native literals work in fixed assignments, shape endpoints, per-value lanes
and existing supported filter-envelope locks/path endpoints. Shapes interpolate normalized
values, so a linear ramp is not linear in seconds. Native-unit arithmetic and
unit-bearing named signals are unsupported. `exp`/`log` retain the requirement
for positive normalized endpoints; 1ms maps to zero, so use `ramp` for that
endpoint. These synth controls do not add new drum envelope parameters or new
amplitude-lock capabilities.

`modenv.attack/decay/release` retain their native-seconds unitless meaning and
1ms–10s range; they additionally accept the same explicit note durations.

## LFOs

The primary LFO supports:

| Control | Values |
|---|---|
| `lfo.ratio` | 0 off, or up to 32 × each voice's current note frequency; rate capped at 5 kHz |
| `lfo.trigger` | `song` (default) or `note`; note mode restarts on retrigger, not legato |
| `lfo.phase` | Initial phase offset in cycles, 0–1 |
| `lfo.delay` | 0–10 seconds before modulation begins |
| `lfo.fade` | 0–10 seconds to fade in after delay |
| `lfo.slew` | 0–1-second exponential smoothing time; 0 bypasses smoothing |
| `lfo.resonance` | −1…+1 resonance depth |
| `lfo.pw` | −0.48…+0.48 pulse-width depth |
| `lfo.wave` | −1…+1 oscillator-1 waveform morph depth |
| `lfo.detune` | −100…+100 cents of detune modulation |

Ratio mode follows each voice's pitch and glide. Delay/fade are per note even in
song mode. Fixed `ms`/`s` literals work for delay/fade/slew. Existing pitch, cutoff,
amp, pan, shape and rate controls are described in [MODULATION.md](MODULATION.md).

The independent second LFO has `lfo2.hz` (0.01–5000 Hz), `lfo2.sync 1/16`,
`lfo2.ratio` (0–32), `lfo2.trigger song/note`, `lfo2.phase` (0–1), and
`lfo2.shape` (the same five names; numeric 0–1). Its destinations are
`lfo2.pitch` (±2400 cents), `lfo2.cutoff` (±4 octaves), `lfo2.amp` (±1) and
`lfo2.pan` (±1). Both LFOs can move the same destinations together.

`lfo2.rateMod` (±4 octaves) multiplies its rate by
`2^(first-LFO × rateMod)`. `lfo2.depthMod` (±1) multiplies its waveform by
`max(0, 1 + first-LFO × depthMod)`, allowing depth up to twice the base depth.
This supplies rate/depth motion without duplicate parts. LFO2 shape, phase and
trigger can be locked per note, like its rate and destinations.

## Routed modulation envelope

`modenv.attack`, `.decay` and `.release` use native seconds (1ms–10s), with fixed
`ms`/`s` literals. `.sustain` is 0–1. Defaults are 10ms attack, 300ms decay,
zero sustain and 200ms release. It retriggers with the voice envelope.

- `modenv.pitch`: ±2400 cents.
- `modenv.cutoff`: ±4 octaves.
- `modenv.lfo`: −1…+1; positive values blend primary LFO depth toward the envelope,
  negative values blend toward its inverse. At 0 it leaves LFO depth unchanged.
- `modenv.curve`: 0.25–4; raises the envelope value to this power. Default 1
  preserves its linear attack/exponential decay and release.

```text
modenv.attack = 2ms
modenv.decay = 80ms
modenv.pitch = 1200ct
modenv.cutoff = 2oct
```

## Per-note locks

`cutoff`, `resonance`, `level`, `level.db`, `fm.index`, `fold`, `sync`,
`sync.ratio`, `pw`, `filter.fm`, numeric `lfo.*`,
`lfo2.*`, `modenv.*`, `envamount`, and filter ADSR locks apply
to that note's voice, including its release. They do not alter overlapping
voices or the part's automation. Locks override member controls for the life of
that voice; unlocked voices continue following member automation. Filter ADSR
locks keep their existing unitless normalized mapping and additionally accept
explicit ms/s/note times; modenv ADSR locks use native seconds.

```text
plays notes | D4{lfo.hz 7, lfo.pitch 120, lfo.trigger 1, length 1/1} F4{lfo.hz 11, lfo.cutoff 2, envamount 0.8, length 1/1} . . |
```

Native time, frequency, cents, semitone and octave controls also accept their
`ms`/`s`, `Hz`/`kHz`, `ct`, `st` and `oct` literals in locks. Unsupported units
produce a diagnostic instead of silently suppressing the note. Use `lfo.trigger 1` for note and 0 for song. Named shapes
in assignments convert to their numeric index; shape locks use 0, 0.25, 0.5, 0.75,
1. A lock on a chord applies to all its notes. Instrument-level filter type and
oscillator mix/tuning/wave controls remain member automation. The voice controls
listed above are independent per voice. Continuous movement after attack uses
[per-note paths](PRIMITIVES.md#per-note-paths), with destination-specific units.

## Envelope/LFO routes into timbre

All three sources (`lfo`, `lfo2`, `modenv`) can drive these destinations:

| Suffix | Depth range and meaning |
|---|---|
| `fm.index` | ±20 index units |
| `fold` | ±1 amount |
| `sync.ratio` | ±4 octaves; multiplies the base ratio by `2^(modulation)` |
| `pw` | ±0.48 width |
| `filter.fm` | ±4 octaves of oscillator-to-filter depth |

For example, `lfo.fm.index = 3`, `lfo2.fold = 0.4`, and
`modenv.sync.ratio = 2oct`. Routes can be automated or locked per note.
For each destination the three source contributions are summed, then added to
its base value (multiplied for sync ratio), and bounded to its instrument range.
LFO waveforms are bipolar; the modulation envelope is unipolar. Pulse-width
modulation needs a pulse waveform; sync modulation needs `sync = 1` and an audible
second oscillator. These routes do not give plucked strings an analog oscillator.

## Drum controls

Existing `tone`, `tune`, `decay`, pan and level controls remain unchanged.

| Control | Values |
|---|---|
| `drum.pitch` | MIDI note 0–127, or a fixed note name such as `D3`; scales the model's reference oscillator |
| `drum.pitch.depth` | −48…+48 semitones; replaces the built-in pitch envelope when set |
| `drum.pitch.decay` | 1ms–2s; pitch-envelope time constant, numeric seconds or `ms`/`s` |
| `noise` | 0–1 crossfade from the original drum model toward added white noise; default 0 preserves the kit |
| `drum.lfo.hz` / `drum.lfo.sync 1/16` | 0.01–5000 Hz or a tempo subdivision |
| `drum.lfo.pitch` | ±24 semitones |
| `drum.lfo.tone`, `drum.lfo.amp` | 0–1 depth |

Pitch/depth/decay/noise locks are captured per hit. The drum LFO follows the song
clock and continues through rests. Metallic/noisy models do not have one musical
fundamental; note tuning anchors their reference oscillator, rather than making a
cymbal or shaker a pure pitched instrument. `level = +12dB` remains available.

## Listening fixture and limitations

Render `tests/fixtures/render/instrument-params.mm`. It compares plain init, dual
oscillators, PWM, FM, sync, folding, filter FM, note-tracked modulation, flutter,
two LFOs, an envelope chirp, poly unison, independent note locks and tuned drums.

Native units inside general expressions are not supported; numeric expressions use
the ranges above. Modulation routing into shared sends/inserts and adjustable preset drift/ageing
are not supported.
[Native ratchets and synth grains](PRIMITIVES.md) are implemented, along with
independent per-note parameter paths. [Spatial controls](SPATIAL.md) add
listener-relative `space.az/el/dist` or world-space `space.x/y/z`; the two
coordinate families cannot be mixed in one part.
