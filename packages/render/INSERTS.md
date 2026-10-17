# Inserts, tuning and analysis

Implemented for `mm render` and `mm check --setup setups/band/band.setup`.
These are software extensions; MIDI handling is not supported.

## Ordered insert chains

```text
part acid
  insert = drive 40% -> filter cutoff 3kHz, resonance 25% -> delay time 1/16, feedback 30%, mix 20%
  when in break:
    insert.filter.cutoff = across section: ramp 0.7..0.25
    insert.delay.bypass = 1
```

Declare one chain directly under a part. Repeated types need names:
`drive as dirt -> drive as fuzz`, addressed as `insert.fuzz.amount`.
Chains run on the summed stereo member, after its existing preset processing and
voice panning, before level and ordinary sends. Note throws retain their earlier
voice tap and do not pass through shared inserts. This preserves per-note pan.

| Type | Configuration fields and defaults |
|---|---|
| `filter` | `type lp12` (also lp24, hp12, hp24, bp, notch, peak), `cutoff 1800Hz`, `resonance 20%`, `drive 0%` |
| `autofilter` | Filter fields plus `rate 2Hz`, `depth 1oct`, `shape sine` |
| `drive` | `amount 30%`, `tone 9kHz`, `model soft` (also tube, hard); `drive 40%` sets amount |
| `crush` | `bits 8`, `rate 11kHz`, `jitter 0%` |
| `chorus` | `rate 0.3Hz`, `depth 50%`, `voices 2`, `width 80%` |
| `phaser` | `rate 0.2Hz`, `stages 6` (4–12), `center 800Hz`, `depth 2oct` (0–4), `feedback 35%`, `width 70%` |
| `flanger` | `time 3ms` or `tune A4`, `rate 0.2Hz`, `depth 2ms` (0–10), `feedback 50%`, `width 70%` |
| `delay` | Same fields as the delay bus; default dotted eighth |
| `tremolo` | `rate 2Hz`, `depth 50%`, `shape sine` |
| `autopan` | `rate 0.25Hz`, `depth 80%`, `shape sine`, `phase 50%` (right phase offset in cycles) |
| `gate` | `pattern \| x . x . \|`, `rate 1/16`, `attack 3ms`, `release 15ms`, `depth 100%` |
| `comb` | `pitch C4` or `time 3.822ms`, `feedback 40%`, `depth 0`, `rate 0.2Hz` |
| `ring` | `hz 440Hz`, or `ratio 1.5` to the most recently activated synth note; drums follow their current oscillator pitch |

Shapes: sine, triangle, square, saw, sample-and-hold. Modulation runs on the song
clock and continues during rests. Rate automation integrates phase continuously.
`rate` accepts Hz or a note subdivision; `crush.rate` accepts Hz or a note name.
`comb.pitch` and `ring.hz` accept absolute note names; root/chord frequency following
is not supported. A gate currently accepts a single plain rhythm literal; rhythm
operations, subdivisions and Euclidean patterns are not supported.

Default `mix`: 25% for delay; 50% for chorus, comb, ring, phaser and flanger; 100% for the others.
Mix is a linear dry/wet blend. Bypass crossfades over about 10ms, stops new input,
and lets delay/comb/flanger/phaser state decay instead of clearing them.

Configuration values above are native. Automated expressions use normalized 0–1:
cutoff/tone map exponentially 20Hz–20kHz, rate exponentially 0.01Hz–5kHz (chorus/comb/phaser/flanger
stop at 20Hz), delay time exponentially 1ms–10s, comb time 0.2ms–2s, attack/release
0.1ms–1s; autofilter depth maps 0–4 octaves, comb depth 0–10ms, ring ratio 0–32.
Flanger time maps 0.02–30ms, depth 0–10ms; phaser depth 0–4 octaves, center
20Hz–20kHz. Bits map to 1–16, voices to 2–4, stages to 4–12 (rounded). Mix, bypass and ordinary percent fields are linear.
Feedback is a signed raw fraction for comb, phaser and flanger, bounded ±0.95; delay is 0–0.98.
Native literals in assignments are converted, e.g. `insert.delay.time = 1/8`,
`insert.filter.cutoff = 3kHz`, `insert.autofilter.depth = 2oct`.
Shape endpoints accept unit-bearing literals, beat subdivisions and note names, for example:

```text
insert.filter.cutoff = across section: ramp 500Hz..2kHz
insert.delay.time = across 2 bars: ramp 1/8..1/4
```

Endpoints convert to the parameter's normalized scale before interpolation;
`ramp 500Hz..2kHz` therefore sweeps geometrically in hertz. Unitless ranges keep
their normalized meaning, including bits, voices and stages. The same conversion works in `hold`, other shape types,
parenthesized/chained shapes and `per` values. Units must match the destination,
and native endpoints must fit its range. `exp`/`log` require positive **normalized**
endpoints; use `ramp` when an endpoint maps to zero. General unit arithmetic and
unit-bearing named signals are not supported.

Fixed bits/voices/stages assignments use their integer native values. Unknown fields fail.

Filter modes can be set and automated with names, e.g. `insert.filter.type = hp24`.
Use `insert.filter.cutoff = across section: ramp 0.3..0.9` for a sweep, or
`autofilter cutoff 1kHz, rate 1/8, depth 2oct` for beat-locked motion.
Phaser uses 4–12 first-order all-pass stages with a stereo frequency sweep.
Flanger uses a short interpolated feedback delay; `tune A4` sets its base delay
to one A4 period. Set `depth 0ms` to hold that tuning. Tune/pitch aliases are
configuration-only; automate `insert.flanger.time` with seconds/milliseconds.
`width 0%` locks the two modulation phases together; 100% separates them by 90°.
Bus stages are wet-only: phaser's familiar notches appear when its return combines
with the dry member (or use its default 50% insert mix).
The listening fixture `tests/fixtures/render/modulation-effects.mm` compares dry,
filter/autofilter, phaser, flanger, tuned flanger, and a phaser bus in that order.

The insert processors also work in a wet-only bus chain. Bus stages have no mix or
bypass field; their return fader can silence the output. Insert reverb is not supported;
use a reverb send.

## Ducking and deliberate cuts

```text
bus hall
  duck from kick 6dB release 1/8

silence before drop for 1 beat and cut fx
```

Bus ducking is note-triggered, with velocity-weighted depth, a 3ms attack and
exponential recovery. It reduces the return and downstream routing, while the
effect continues running. Muted/unselected sources do not trigger it. Audio-follower
ducking and insert sidechain compression are not supported.

`and cut fx` clears every bus and insert buffer at the beginning of the written
silence, including preset chorus and comb buffers. It leaves instrument voices
alone: a held note or its release can still feed new audio into effects after the
clear. It does not turn the silence into a global note-off.

## Independent note tuning

```text
song "Pure thirds"
  tempo 120
  key Eb major
  tuning just chord
part voices
  plays notes | Eb3+G3+Bb3 _ _ _ |
```

Song tuning supports `equal`, `just from Eb`, `just 7-limit from Eb`, `just chord`,
`just 7-limit chord`, and `cents C 0 C# -9.78 ...` with all twelve pitch classes.
Five-limit intervals use 1, 16/15, 9/8, 6/5, 5/4, 4/3, 45/32, 3/2, 8/5, 5/3,
9/5, 15/8. Seven-limit replaces the minor third, tritone and minor seventh with
7/6, 7/5 and 7/4. Chord tuning chooses the current harmony root at each attack;
held notes keep their tuning across later chord changes.

`G3-13.69ct`, `c3+15.64ct` and `G3{cents -13.69}` add a per-note offset (±2400ct)
to the selected tuning and the member bend. Offsets survive material operations.
Suffixes can combine with locks: `G3-13.69ct{pan 1}`. Independent suffixes inside
a `+` chord are not supported: use chord/table tuning or separate note attacks.
A cents lock on a chord shifts every note of that chord. Cents locks on drums and
member-level cents automation are rejected.

## Listening and analysis

```sh
npm run mm -- render examples/first_song.mm --solo lead,keys --from "bar 1" --bars 4 --out renders/example-solo/mix.wav
npm run mm -- render examples/first_song.mm --mute kick --out renders/example-no-kick/mix.wav
npm run mm -- render tests/fixtures/render/inserts.mm --analysis
```

Solo/mute select actual member names, preserve timing and score automation, and
include only selected members' sends. Use separate output folders for comparisons.

`--analysis` adds an HTML listening page, float WAV stems, a full mix spectrogram,
mix spectrograms per section, member spectrograms and RMS/peak measurements per
section and bar. Bar numbers stay those of the original song. Member measurements
include inserts and level but exclude shared bus returns. RMS is unweighted dBFS,
not LUFS. Float stems preserve levels above 0dBFS without clipping the stored data.
Spectrograms require ffmpeg; without it, levels and stems remain available and the
analysis records a warning. `--no-analysis` overrides this option and omits reports.

Masking detection, automatic loudness matching, pitch/onset analysis and automatic
mix changes are not supported. The listening fixture is `tests/fixtures/render/inserts.mm`.

## Gain above preset levels

`level = +12dB` raises a member or drum lane above its preset trim. Fixed native
levels accept -60..+12 dB. `level.db = across section: ramp -6..12` automates gain
in dB; ordinary `level` remains a normalized square-law fader and multiplies this
gain if both are used. Use `level = 0` for silence. Solo/mute still work with these
controls, for example `mm render song.mm --solo hats`.

Bus tail reports measure wet decay relative to each bus peak, from its last
significant input capped at the score end. Instrument releases feeding a bus after
the score contribute to its render tail. This is not a measurement of nominal RT60.
See [modulation](MODULATION.md) for normalized LFO mappings and
[sounds](SOUNDS.md) for preset velocity behavior.
