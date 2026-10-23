# Named effects buses

Named buses process software-rendered audio. Use `mm render` or
`mm check --setup setups/band/band.setup`. For insert chains, note-triggered bus
ducking and buffer cuts, see [INSERTS.md](INSERTS.md). Bus freeze and MIDI-target
effect processing are not supported.

## Declare spaces

```text
fx
  bus hall = reverb decay 4s, predelay 1/32, size 85%, damping 6kHz, mod 20%
  bus dub = delay time 3/16, feedback 65%, tone bp 1.2kHz, pingpong 80% -> send hall 30%
  bus cloud = delay as tap time 1/8, feedback 40% -> reverb as space decay 8s
```

Bus chains process left to right, fully wet. Bus stages do not accept insert
`mix` or `bypass`; use sends and bus return to balance wet/dry. This also applies
to phaser stages. The part's dry signal goes to the
master separately. Buses always have a master return; terminal `send NAME VALUE`
also feeds that return to another bus. Routing cycles and unknown destinations
are errors, regardless of declaration order. Repeated stage types must have
unique `as` names.

`room` and `echo` always exist. Existing `reverb` and `delay` controls/locks are
software aliases for `send.room` and `send.echo`. Existing `mix echo` settings
configure the default echo. An explicit bus declaration replacing `room` or
`echo` takes precedence over that bus's defaults.

| Stage | Initial settings and native limits |
|---|---|
| `delay` | Dotted eighth; feedback 35% (capped at 98%); tone LP 4 kHz (20 Hz–20 kHz), or `tone bp 1.2kHz`; pingpong 60% (0–100%). Time 1 ms–10 s. `width` aliases `pingpong`. |
| `reverb` | Decay 2.2 s (50 ms–30 s); predelay 25 ms (0–2 s); size 70%; damping 6 kHz (20 Hz–20 kHz); mod 0%. Size and mod 0–100%. |

Times accept seconds, milliseconds, and ordinary/dotted/triplet note values.
Return/sends use the existing normalized amplitude curve: value squared.
For example, `30%` is normalized 0.3, giving amplitude 0.09. Native dB sends are not implemented.

## Send members and throw individual notes

```text
part lead
  send.hall = 0.3
  send.dub = across section: ramp 0..0.6
  plays notes | A4 _ C5 _ E5{send.dub 1} _ _ _ |
```

Member sends take stereo audio after shared EQ/chorus/comb and after the level
fader. `send.hall.pre = 1` takes it before the level fader, retaining pan and
shared processing, so a fade of the dry part leaves the send alive.

Note throws capture only that voice, including its release. They preserve note
pan and synthesis timbre, but precede shared EQ/chorus/comb. They are post-fader
by default; the bus send's `.pre` setting applies to throws too. Throws add to
member sends. Overlapping voices without that lock are not thrown. Drum throws
capture the current hit and continue through its decay. `.pre` is a member
setting; a note lock for `.pre` is rejected.

## Automate bus stages

```text
bus dub
  delay.feedback = 0.5
  when in build:
    delay.feedback = across section: ramp 0.5..0.95
  when in break:
    delay.time = 1/8
    return = 0.6
bus hall
  reverb.decay = pick(in break, 0.8, 0.4)
```

A bus's `return` is its master/routing return fader, normalized 0–1 (default 1).
Other fields are `STAGE.FIELD`. A bare field such as `feedback` is accepted only
when exactly one stage defines it. Ambiguous/unknown fields are errors.

| Normalized automation | Mapping |
|---|---|
| Delay `time` | Exponential 1 ms–10 s |
| Delay `feedback` | Raw fraction 0–0.98 |
| Delay `tone` | Exponential 20 Hz–20 kHz |
| Delay `pingpong` / `width` | Linear 0–1 |
| Reverb `decay` | Exponential 50 ms–30 s |
| Reverb `predelay` | 2 s × value³ |
| Reverb `damping` | Exponential 20 Hz–20 kHz |
| Reverb `size`, `mod` | Linear 0–1 |
| `return` | Amplitude value² |

A fixed time/frequency literal is converted to this curve, e.g.
`delay.time = 1/8`, `reverb.decay = 4s`, `reverb.damping = 6kHz`. Shape endpoints also accept native time/frequency literals, for example
`reverb.decay = across section: ramp 500ms..4s`. Endpoints convert to the table's
normalized scale before interpolation; unitless ranges keep their meaning.
`exp`/`log` require positive normalized endpoints, so use `ramp` at the minimum
of a parameter's scale. Other expressions use normalized numbers; general unit
arithmetic and unit-bearing named signals are not supported. Conditions and
shapes use the same score regions and curves as parts. Bus automation produces
no notes. Final values persist during release tails, preventing a muted return
from jumping back to its default at the end of the form.

Time changes move fractional delay taps with approximately 20 ms smoothing,
allowing pitch movement without clearing the buffer. Returns smooth over 2 ms.

## Feedback, tails and reporting

Feedback remains inside each stage. Delay tone filters have unity peak gain;
feedback gain is capped at 0.98 and soft saturation bounds the loop. Reverb uses
an eight-line damped feedback network with the same cap. Very long requested
reverb decays lengthen its delay network so the cap can be retained; this is a
musical approximation, not an emulation of a particular room.

Parts/sections ending do not clear buses. The renderer retains late echoes across
quiet gaps, appends 200 ms of quiet, and still obeys `--tail` (default 12 s). A
queued/active tail at that limit is reported even when its next repeat has not
yet become audible. A return muted to zero keeps processing its internal tail.

JSON reports include the resolved bus graph, peak/RMS, RMS per section, final
tail duration, growth without input, pending tails at the limit, and master
instantaneous safety-clamp activity. RMS dBFS is a draft level measure, not LUFS. A simple
150 Hz low-pass estimate flags significant low-frequency stereo energy as a
suspicion, explicitly allowing it to be intentional. Optional spectrograms are available through `--analysis`; precise masking
and wet/dry attribution are not supported.

Listen to `tests/fixtures/render/effects.mm` for throws, named spaces, routing,
feedback automation and pre-fader fades:

```sh
npm run mm -- render tests/fixtures/render/effects.mm
```

## Place a bus: pan

`pan` gives a bus (or an insert chain) a fixed place in the stereo field that can be
automated, where `autopan` only oscillates.

```text
fx
  bus roll = freeze length 1/64 -> pan position -30%, width 60% -> send hall 10%
bus roll
  pan.position = per 1 bar: 0%, 0%, -40%, 0%, 50%
```

`position` runs from −100% (left) to 100% (right) with an equal-power balance: a
mono signal keeps its power wherever it is placed, and centre is unity. Moving
toward one side fades the far channel, so a wide signal narrows as it moves out.
`width` (0–100%, default 100%) first scales the input's side signal: 0% folds it to
mono, so a stereo return can be placed as a single point. Position and width are
smoothed over about 5 ms, so stepped automation does not click; write a sweep as a
shape, for example `pan.position = across 1 bar: ramp -60%..60%`. As an insert,
`pan` defaults to 100% mix.

In bus automation, percent values are real values for any stage (`-30%` is
position −0.3), while bare numbers stay normalized to the stage's range.

## Reverse and freeze (memory stages)

Two small stages for working with the recent sound of a performance. Both work on
buses and as inserts (insert mix defaults to 50%).

```text
fx
  bus back = reverse segment 1/4, fade 5ms -> delay time 3/16, feedback 40%, pingpong 100%
  bus remnant = freeze length 1/1, speed 1/2, fade 10ms
bus remnant
  freeze.hold = per 1 bar: 0, 0, 1, 1
```

`reverse` plays its input backwards in consecutive segments: each segment is output
reversed while the next one is recorded, so the answer arrives one segment after
the call. `segment` (10 ms–4 s, musical values allowed) and `fade` (edge fades).

`freeze` records continuously and outputs nothing while `hold` is below 0.5. When
`hold` rises it stops recording and loops the last `length` (20 ms–16 s) of audio:
`speed` is a signed playback rate (−4…4, ratios such as `1/2` or `3/2` allowed;
negative plays backwards; 0 holds the read position), `start` sets the loop start
(0–1 of `length`), and `fade` sets the hold fade and the loop-wrap crossfade.
Stage times take note values (`1/1` is a whole note, one bar of 4/4) or `ms`/`s`;
`N bars` is not accepted here. In bus automation, write speeds as ratios
(`freeze.speed = per 1 bar: 1/1, -1/2, 3/2`): bare numbers are normalized like other
bus fields, so `freeze.speed = 1` means 4× and `0.5` means stopped.
Lowering `hold` fades the loop out and resumes recording. A held freeze keeps
sounding until `hold` drops or the bus return reaches zero; renders report it
at the tail limit. Feed a single note into a freeze bus with a note throw
(`{send.NAME 1}`) to remember only that note. Freeze has no feedback, so its
level is the recorded level. Excerpt previews start these stages empty at the
warm-up boundary.
