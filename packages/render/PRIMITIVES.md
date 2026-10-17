# Curves, data lanes and note primitives

These features are implemented by the software renderer. Start with
`mm render song.mm`; grouped stems are opt-in. Browser playback is not supported.

## Exponential curves and arithmetic

```mm
lfo2.hz = across 8 bars: exp 1..256
cutoff = across 4 bars: log 0.1..0.9
level = pow(accent, 2)
```

`exp a..b` interpolates geometrically: `a * (b/a)^t`. Equal time spans
have equal ratios. `log` uses its inverse easing:
`a + (b-a) * log(1+(b/a-1)*t)/log(b/a)`. Equal endpoints hold steady.
Both require positive endpoints and support falling ranges. Use `ramp` for zero
or negative endpoints. Shape periods repeat, like existing `across` shapes.

`^` is right-associative and binds more tightly than `*` and `/`:
`2 ^ 3 ^ 2` is 512. Keep spaces around operators; `pow(a, b)` is equivalent.
Non-real results, infinities and possibly-zero negative powers diagnose.
Pitch chord inversion spellings keep their existing meaning.

## Data lanes

```mm
cutoff = data "lanes.json" key brightness per 1 beat smooth
pan = data "lanes.csv" key pan per 1/16 hold
```

Paths resolve relative to the file containing the lane, including a `.mmi`
fragment, rather than the shell's working directory.
JSON keys can traverse objects (`key verse.brightness`); their value must be a
nonempty array of finite numbers. CSV has a header and numeric rows; quoted
fields are supported, embedded newlines are not. Missing files, columns and
invalid values diagnose. Values use the destination's ordinary numeric domain.

The grid defaults to one bar; interpolation defaults to `smooth`. A fraction
without `bar` or `beat` is a whole-note duration. `hold` keeps each value until
the next grid point. Lanes loop and reset exactly like `per` sequences, including
smooth interpolation from the last value back to the first. The render report
records dependency paths and hashes. Editing a lane changes the audio and the
score provenance hash; keep lane files with the score. Render again after changing
a lane before converting the audio. See
[includes and provenance](../../docs/reference/TOOLING.md#includes-and-provenance).

## Per-note paths

```mm
plays notes | C4{pitch -> E4 over 1/8} D4 . . |
plays notes | C4{cutoff 0.2 -> 0.8 over 1/4 curve exp, length 1/2} E4{pitch 0ct -> -100ct over 1/4} . . |
```

Paths belong to a voice; overlapping voices have independent ages and values.
They begin at the performed note onset, reach the target at `over`, then hold
it through the remainder of the note/release. A shorter gate can cut the path
short. Pattern time scaling also scales the written path duration. `pitch -> E4` targets an absolute equal-tempered pitch relative to the
realized note; numeric pitch endpoints are cents relative to its initial pitch.
`st` and `oct` pitch endpoints convert to cents. Tuning and member bend remain
additional offsets. A path does not create a new attack or a mono slide.

Parameter paths require both endpoints. Curves are `linear` (default), `exp`
and `log`; exp/log need positive endpoints. Supported voice destinations:
cutoff, resonance, pan, level, level.db, cents, envamount, fm.index, fold, sync,
sync.ratio, pw, filter.fm, filter envelope controls, both LFOs and the modulation
envelope (including their existing routing depths), and spatial coordinates.
Ordinary normalized domains and native parameter units still apply. For example,
`lfo2.cutoff 1oct -> 3oct over 1/4` is an octave-depth path, while
`pitch 1st -> 1oct over 1/4` is a cents-offset pitch path. Incompatible units diagnose.
Geometric pitch endpoints must remain positive after resolving an absolute target
against the starting note. Unsupported
renderer paths fail explicitly. These paths require software rendering; MIDI
export warns because ordinary MIDI channels cannot reproduce independent bends
on overlapping notes.

## Ratchets

```mm
plays notes | C4{ratchet 4, ratchet.decay 0.2, ratchet.pitch 2st, ratchet.curve 1.5} . . . |
plays hits | x{ratchet 8, ratchet.decay 0.1} . . . |
```

One compact event schedules N attacks within its written slot. Attack i starts
at `(i/N)^curve` of that slot. Each gate is the gap to the next attack
(or slot end), scaled by the source note's gate/slot ratio.
`curve` defaults to 1: even spacing. Values greater than 1 give increasing gaps (deceleration);
values below 1 give decreasing gaps (acceleration). Velocity multiplies by
`(1-decay)^i`; pitch changes by i times `ratchet.pitch` (cents, or ct/st/oct).
For drum lanes, pitch movement changes reference tuning. Set `decay 0` for equal
velocities. Counts are 1..65536; spacing curves are >0..16.

Native ratchets stay compact through realization, then lower to attacks for
software and MIDI scheduling. Existing literal `*N` ratchets keep their meaning.
Generated attacks still count in render reports. Per-note paths restart on each
retrigger. `ratchet.pitch` does not move a drum's pitch unless its lane has a
pitched component; cymbal/noise sounds respond according to their synthesis.

## Synth grains

```mm
plays notes (across 8 bars: C4{grains 2000, grain.size 30ms, grain.scatter 0.3, grain.pitchjitter 20ct, grain.pan 0.5})
```

Each event generates short instances of its selected synth sound. This is a
synth grain source; audio-file freezing and sample playback are not implemented.
Grains use a Hann window, deterministic scatter, pitch jitter and stereo spread.
`grain.size` is seconds or ms/s; default 30 ms. Scatter (0..1) is measured in
one grain interval; pitch jitter is ±cents; pan is an additive ±normalized spread
around the member/note pan. Explicit spatial coordinates still replace ordinary
pan positioning. Propagation-delay tails survive the end of a grain window. Count is
1..65536. The source note's written span distributes the grains. The last grain
may extend beyond its slot; song/excerpt boundaries still truncate scheduling.

Grain parts use a pool of 256 polyphonic voices regardless of a mono source
preset. Excess simultaneous grains fail rather than silently stealing grains.
Grains currently require a pitched part. Counts and size determine render cost;
2,000 grains over eight bars are a normal draft workload. They require the
software renderer; MIDI export warns.

## Grouped stems

```mm
part piano
  group harmony
  plays notes | C4+E4+G4 . . . |
part melody
  group melody
  plays notes | C5 D5{group ornament} E5 . |
```

Run `mm render song.mm --stems-by group`. Untagged events default to their part
name. Per-note tags override the part tag. Float stereo files go in `stems/`,
with RMS/peak levels and paths in `report.json`. They have identical timelines
and lengths and sum to the emitted mix (within float rounding).

Each group gets its own synthesis/effect pass. Shared nonlinear inserts and
master corrections are distributed between the stems by their sample magnitudes
(with whole-track energy weights during silence), preserving the full mix.
A solo stem therefore represents its contribution to the finished mix and can
differ from rendering that group alone. This costs roughly one extra render per
group; ordinary draft renders incur no stem passes. Binaural grouped stems are
supported; ambisonic grouped stems remain unsupported and give an error.
