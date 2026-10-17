# Software modulation controls

Use `mm render` and `mm check --setup setups/band/band.setup` for these software
controls. Named shapes, sync divisions, the unit literals below and the small
`mix` block are handled by the render package. They are not a general native-unit expression
language and are not accepted by ordinary check/format/MIDI export commands.

See [instrument parameters](INSTRUMENT_PARAMS.md) for note-tracked rates, note
triggering, phase/fade/slew, a second LFO, new destinations and per-note locks.

## Audio-rate LFO

The LFO runs per sample. Its phase starts at song time zero, continues through
silence, and is independent of note triggers. Constant/synced rate assignments
anchor to the song clock; rate automation integrates frequency continuously.

```text
part lead
  lfo.sync 1/16
  lfo.shape sine
  lfo.pitch = 100ct
  lfo.cutoff = 2oct
  lfo.amp = 0.5
  lfo.pan = 1
```

| Control | Value |
|---|---|
| `lfo.rate` | Normalized 0–1: exponential 0.05 Hz–2 kHz |
| `lfo.rate = 440Hz` / `5kHz` | Literal frequency, 0.01 Hz–5 kHz; lowered onto the rate curve internally, preserving score overrides |
| `lfo.hz` | Numeric Hz, supports ordinary scalar expressions and ranges |
| `lfo.sync 1/16`, `1/8.`, `1/8t` | One cycle per note value at the song tempo |
| `lfo.shape` | `sine`, `triangle`, `square`, `saw`, `sample-and-hold` (or `sh`) |
| Numeric `lfo.shape = x` | 0 sine, 0.25 triangle, 0.5 square, 0.75 saw, 1 S&H |
| `lfo.pitch` | Depth in cents, −2400…+2400; `1200ct` or numeric `1200` |
| `lfo.cutoff` | Depth in octaves, −4…+4; `2oct` or numeric `2` |
| `lfo.amp` | 0…1: tremolo depth; −1…0: bipolar AM/ring-mod blend |
| `lfo.pan` | −1…1: auto-pan depth; sign reverses direction |
| `lfo.amount` | Legacy cutoff LFO depth, using the preset's cutoff depth |

The four destination depths are independent and can be combined. They do not
need `lfo.amount` to enable them. `lfo.cutoff` adds to the preset cutoff
LFO. Pitch modulation is in cents (exponential frequency modulation at audio
rates). S&H is deterministic and changes once per cycle.

Rapid periodic expression controls such as
`pan = across 1/64: sine -1..1` use a 3 kHz grid, including signal references and
streams that look constant on the coarse IR grid. Cutoff, gain, pan and bend are
smoothed over approximately 0.3 ms. Other varying streams retain 250 Hz sampling.
LFO modulation itself runs at the audio sample rate, not on either control grid.

## Note placement and bend

`C4{pan -1, length 1/1}` captures the pan on that voice, including its release.
Other overlapping notes keep their own pan. Without a lock, a voice follows the
member's pan automation. Auto-pan adds to either placement; chorus/reverb can
still spread the wet signal.

```text
bend.range = 24st
bend = 0 - (across section: ramp 0..1)
```

`bend.range` is numeric semitones (or a literal `24st`), 0–24. It defaults to 2,
and controls how normalized bend maps to pitch. `bend` stays normalized −1…+1.

Independent [per-note paths](PRIMITIVES.md#per-note-paths) can also move pan,
cents or absolute note pitch during a voice lifetime. Member bend and tuning
remain additive. [Spatial coordinates](SPATIAL.md) replace ordinary pan with
point-source placement when supplied; world-space sources also respond to the
listener's motion.

## Ring modulation

```text
ring.ratio = 1.5
ring.mix = 1
```

`ring.ratio` is 0.01–32 times each voice's current note frequency. Alternatively:

```text
ring.sync 1/128
ring.mix = 0.5
```

`ring.sync` anchors a common carrier to song time. `ring.hz = 440Hz` (or numeric
Hz) chooses an absolute carrier, 0.01–5000 Hz. `ring.mix` blends dry and bipolar
ring-modulated sound. The ratio follows note pitch/glide; absolute and synced
carriers remain independent of note pitch.

## Tuned comb and flanger

```text
comb.pitch C4
comb.mix = 0.5
comb.feedback = 0.6
comb.depth = 0.0001
comb.rate = 0.2
```

The stereo comb has fractional delay taps. `comb.pitch` sets the delay period
from an absolute note (including sharps/flats). `comb.hz` sets the frequency in
numeric Hz. `comb.sync 1/32` chooses a tempo subdivision; `comb.time = 2ms`,
`0.002` or `1/32` sets the delay directly. Delay range is 0.2 ms–2 s.

`comb.feedback` is −0.95…+0.95. Positive feedback reinforces integer harmonics;
negative feedback changes the resonance pattern. `comb.depth` is sine modulation
in seconds, 0–0.01; `comb.rate` is numeric Hz, 0.01–20. Nonzero depth makes this a
flanger. `comb.mix` is 0–1. Large feedback can strongly amplify resonances; the
existing draft safety ceiling still protects the output.

## Tempo-synced stereo echo

```text
mix
  echo time 1/8., width 100%, feedback 45%
```

Width 0 is centered; width 1 is full ping-pong. Echo time accepts ordinary, dotted
and triplet note values, or literal ms/s, up to 10 seconds. Feedback is 0–95%.
Omitted values keep the defaults (dotted eighth, width 0.6, feedback 0.35).
Member `delay` still controls the send. This `mix` block supports echo
only. Use [named buses](EFFECTS.md) for delay/reverb configuration, effect chains,
routing and automation; a general master configuration block is not supported.

## Dense software parts

The software target allows 256 attacks per bar. Above that, D001 is a warning,
so dense software experiments can still render. The normal core/MIDI target
retains its 64-attack error. No note events are thinned by the renderer.

## Listening track

`tests/fixtures/render/modulation.mm` contains eight two-bar sections demonstrating
sync, audio-rate pitch modulation, AM, fast expression pan, wide bends, note pan
locks, ring modulation and comb/echo. Render it with:

```sh
npm run mm -- render tests/fixtures/render/modulation.mm
```
