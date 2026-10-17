# Instruments and setups

See the [setup guide](../../setups/README.md)
and [software renderer](../../packages/render/README.md) for current usage. Examples
use generic placeholder devices and mappings; verify them against your hardware.

For setup examples, start with [Using MIDI](../guides/USING_MIDI.md). Jump to
[instrument syntax](#2-instrument-definitions-and-setup-syntax),
[part mappings](#3-setup-and-direct-mappings),
[program selection](#31-preset-numbering-and-startup) or
[backend rules](#42-midi-10-output-rules-normative-for-the-midi-10-backend).

**Rule: a score (`.mm`) never contains MIDI.** No channels, CC numbers, note maps, program
numbers or port names. A score names *musical* things: parts, roles, drum lanes, and
**named parameters** with normalized values. Everything device-specific lives in two other
file types:

| Layer | File | Contains | Edited when |
|---|---|---|---|
| Score | `*.mm` | Music: parts, roles, lanes, named parameters (0–1), curves | The music changes |
| Instrument definition | `*.inst` | One device model's MIDI implementation | Once per device model (shareable) |
| Setup | `*.setup` | Your studio: ports, channels, programs, which part plays where | You rewire or swap gear |

Example: replace the example-bass with an example-synth on the bass.

```diff
# studio.setup
- bass  = example-bass   port:main ch:5
+ bass  = example-synth  port:main ch:1 program:ram-a/12
```

`song.mm` is unchanged. `bass.cutoff` was sent as CC 19 on the example-bass. It is now sent
using the Virus definition's mapping, and the program is selected when the song starts.

---

## 1. Named parameters in the score

### 1.1 Vocabulary

Parameters are named by **musical function**, not by any manufacturer's terms. Values in
the score are normalized **0–1** (or bipolar −1…1 where marked). The standard vocabulary:

| Group | Names |
|---|---|
| Filter | `cutoff`, `resonance`, `envamount`, `filterdrive` |
| Amp / envelope | `attack`, `decay`, `sustain`, `release`, `level` |
| Tone | `drive`, `wave`, `detune`, `noise`, `sub` |
| Pitch / play | `glide`, `bend` (bipolar), `vibrato`, `mod` |
| Space / fx | `send1`, `send2` (generic sends), `delay`, `reverb`, `pan` (bipolar) |
| Drums (per lane) | `tune`, `decay`, `cutoff`, `level`, `pan` |

Instrument definitions MAY add device-specific names, such as `osc2.semitone` or
`filter2.cutoff`. A score that uses them only works on instruments that define them.
- A name in the vocabulary that the bound instrument lacks is warning `I001`.
- A name that is neither in the vocabulary nor defined by any instrument in the given
  setup is error `I003` with suggestions, so `cutof = 0.3` never passes silently. Without
  `--setup`, only vocabulary names and names of the form `group.param` are accepted.

### 1.2 Setting and moving parameters (score syntax)

Parameters are fields of a part (docs/reference/LANGUAGE.md §12.5–§12.6):

```
part bass
  role low
  plays roots | X . x{cutoff 0.9} x |               // a parameter lock on one hit
  cutoff = 0.35                                      // constant
  resonance = 0.25 + bright * 0.55                   // a curve mapped into a range
  when in drop:
    cutoff = 0.2 + trigger(kick, decay 1/8) * 0.5

part pad
  role bed
  plays chords
  reverb = across section: ramp 0.2..0.7
  pan = 2 * wob - 1                                  // bipolar destination, wob is a 0..1 signal

part kick
  lane kick
  plays hits | X . . . X . . . |
  decay = 0.4                                        // drum lane parameter
```

- Values are normalized: 0..1, or -1..1 for parameters the definition marks `bipolar`.
  Literal assignments are checked against the domain. Computed expressions are checked by
  their derived range (docs/reference/LANGUAGE.md §10.3).
- **Parameter locks** (`x{cutoff 0.9}`) are intervals over their event's gate.
  When a lock ends, the parameter takes the **current** value of the next layer down (the
  part's expression, then declared setup/instrument baselines), never a value captured when the
  lock began. Conflicts on channel-wide parameters and same-start ties follow docs/reference/LANGUAGE.md §12.6.
- Score expressions route curves to named parameters. Setups supply fixed startup
  values with `set`; they do not declare global curve routes (§3.2).
- `sound NAME` selects a software-renderer preset. MIDI instruments use the
  setup's bank/program declarations instead.

### 1.3 Drum lanes

A score names lanes by function: `kick`, `snare`, `clap`, `hat`, `openhat`, `tom`, `rim`,
`crash`, `ride`, `perc1…perc8`, … (device lane names are defined in its instrument file; the software kit has fixed lanes). The instrument definition says how each lane is played (note, or channel per track).

---

## 2. Instrument definitions and setup syntax

### Software draft targets

`mm render` and `mm check --setup` also accept the software setup in
`setups/band/band.setup`. An `engine audio = software 48kHz` declaration replaces
the MIDI port. Bindings use `synth engine:audio preset:NAME` or
`drums engine:audio kit:808-909`; there are no channel assignments. Exact part
names win, followed by exact drum lanes, `lane:*` for drums, or `role:NAME` and
`*` for pitched parts. Unknown presets and drum lanes are errors.

Software targets use existing normalized score controls plus the native instrument
controls documented in `packages/render/INSTRUMENT_PARAMS.md`. Hardware calibration and
general native-unit arithmetic are not supported; narrow software literals are supported. Software setup parsing belongs to the
render package; MIDI export and live playback continue to use MIDI setups.
See `packages/render/README.md` for supported commands and backend limitations.

### MIDI targets

The supported fields are:

```text
instrument example-synth
  name "Example synth"
  voices poly
  range 0-127
  program bank:cc0+cc32 select:pc base:1
  banks ram-a:0/0 ram-b:0/1
  program-lead 500ms
  param cutoff cc:40 default:0.5
  param attack cc:59
  param pan cc:10 bipolar
  param bend pitchbend bipolar
```

These are illustrative mappings, not a built-in device definition. Verify bank
numbers, controller addresses and parameter behavior against your device manual.

| Field | Meaning |
|---|---|
| `voices mono`, `voices poly`, `voices poly N`, `voices drums` | Voice policy. Omitted means `poly` without a declared cap; explain reports that default. |
| `range LOW-HIGH` | Inclusive MIDI note bounds, integers 0–127. Omitted means 0–127. |
| `transpose +12` | Pitched-note offset in semitones (−127..127), default 0. Applied before device range folding; drum maps are unchanged. Can be overridden inside a setup binding. |
| `glide legato` | Mono overlapping distinct notes use note-on-before-note-off handover. Omitted means retrigger. |
| `program bank:cc0\|cc32\|cc0+cc32 select:pc base:0\|1` | Supported bank messages and displayed preset numbering. Bank field may be omitted for PC-only devices. |
| `banks NAME:MSB/LSB …` | Named bank byte pairs. For single-controller banking, use `NAME:N`. Values are 0–127. |
| `program-lead Nms` | Wait after program selection before initialization controllers/notes; default 500 ms. |
| `latency Nms` | Instance scheduling compensation; default 0. |
| `param NAME …` | Musical alias to message mapping; optional explicit normalized `default:VALUE`. |
| `lanes note-map` plus `lane NAME note:N` | Drum note aliases on the binding's channel. |
| `lanes channel-per-track` plus `lane NAME note:N` | Each used lane needs its channel in the setup. |

Required parameter mappings:

- `cc:N`: one 7-bit controller; default device range 0–127.
- `cc:N lsb:M`: a 14-bit controller pair; send MSB then LSB together, default range 0–16383.
- `nrpn:MSB/LSB bits:7|14`: select with CC99/98, then CC6 and, for 14-bit, CC38.
  Cache selection per output/channel, invalidating it when another message changes it.
- `pitchbend`: 14-bit channel pitch bend, centre 8192; bipolar by default.
- `as:OTHER`: an alias to another parameter in the same definition. Resolve acyclically;
  missing targets and cycles are errors. Arbitration is on the final MIDI destination.

All mappings accept `min:N max:N`, `bipolar`, `rate:N` and `default:VALUE` when applicable.
`rate:` is an optional upper limit: defaults are 100 Hz for 7-bit and 50 Hz for 14-bit.
The renderer may sample slow curves more cheaply and thin interior samples to fit the port.
Notes, locks, required boundaries and final values are preserved; thinning is reported as
info `D006`. It also plans atomic message groups into available wire time.
Device bounds must fit the encoding. `default` uses the same normalized domain as the score.
CC/NRPN address bytes are 0–127; channels in user files are 1–16. Ordinary CC mappings
must not target CC0/32 bank selection or CC120–127 channel-mode commands. These belong to
managed initialization/cleanup. Devices can assign musical meanings to CC98/99 and similar
numbers; allow those in CC-only definitions. If an instance also uses NRPN, reject raw CC
mappings that conflict with its CC6/38/98/99/100/101 protocol state. Never assume a listed
controller has standard semantics merely because its number matches a protocol convention.

Response mapping is linear. Unipolar values clamp to 0–1, bipolar values to
−1–1. Unipolar encoding is `round(min + v * (max - min))`; bipolar zero maps to 64 or 8192,
with each half mapped separately to its bound. Bounds must enclose that centre. Explicit
boolean/enumerated controls use declared integer min/max with the same quantization.
Nonlinear response curves and SysEx templates are not supported; requesting them produces a
clear unsupported-feature error. Unmapped `bend` may use MIDI pitch bend only if declared
by the definition; there is no implicit permission to alter a synth's pitch.

A definition can omit program support and all parameter mappings. This supports instruments
used for notes only. Declare voice limits from the device specification.

## 3. Setup and direct mappings

```text
setup example-rig
  port main = "EXACT OUTPUT NAME FROM mm ports" clock:send
  library ./instruments

  lead = example-synth port:main ch:1 program:ram-a/100
    set cutoff 0.35
    set attack 0.1
  pad = example-synth port:main ch:2 program:ram-b/40
  bass = example-bass port:main ch:5
  lane:kick = example-drums port:main ch:12

  # Reuse a definition but replace one alias mapping for this binding.
  texture = example-synth port:main ch:3
    param cutoff cc:41

  # An inline definition is useful before a reusable .inst exists.
  manual = direct port:main ch:7
    voices mono
    range 0-127
```

`set NAME VALUE` declares normalized starting parameter values.
A direct binding accepts the same definition fields as `.inst`, including `param`, `program`,
`banks`, `program-lead` and drum lanes. A referenced definition can override parameter mappings,
voice/range/latency settings and startup values in its binding block. The merged definition
is validated exactly like a standalone definition. Declared defaults are explicit writes;
unspecified parameters remain at their loaded preset/manual settings.

Binding precedence is exact part name, `lane:NAME`, `role:NAME`, then `*`. At the same
specificity, more than one match is an error with candidate spans. Every part with realized
notes or an effective controller stream needs a binding; no preview or silent-drop fallback. A setup may contain unused aliases. Each run
initializes only destinations used by the score.

For drum definitions, setup `lane NAME ch:N [note:N]` entries can supply channel-per-track
routing or override a note map. For an example note-map kit, used lanes can share
a channel and use different notes. This does not imply that its parameter CCs independently
address those drum voices. Per-lane parameter control needs separately declared routing;
otherwise it is a channel-wide control, with ordinary conflict arbitration.

The physical instance identity is logical output + channel. Three example-synth channels are
three instances. Several score parts on the same channel share one instance and its voice,
program and controller state. Conflicting program/bank/default/definition declarations for
that instance are errors; compatible declarations merge. Reusing an instrument model on a
different channel does not create a conflict. Physical voice-pool allocation across the
multitimbral parts is not modeled; The user configures the device's multitimbral mode.

### 3.1 Preset numbering and startup

Setup selectors are `program:NUMBER`, `program:BANK-NAME/NUMBER` or
`program:MSB/LSB/NUMBER`. `base:1` is the default: displayed preset 100 becomes wire PC 99.
`base:0` allows displayed 0–127. Raw bank bytes are always 0–127. Named bank resolution
uses the definition, never guesses a manufacturer's numbering convention.

Each used instance follows this sequence once per playback/export:

1. Send declared bank select controllers, then program change.
2. Wait at least that instance's `program-lead` if a program was requested.
3. Send declared definition defaults, overridden per parameter by setup `set` values.
4. Establish applicable score-time-zero controller values before the first attack.
5. Begin playback. No later bank/program changes are allowed.

Only final effective initialization values need to be sent; do not send a default immediately
followed by an overriding setup value. Programs are optional. No program means use the
currently selected hardware patch, with any explicit startup values still applied.
All used instances finish initialization before the shared musical start. Pre-roll includes
patch waits, actual initialization-message transmission time and the earliest negative
performed/latency offset. Export contains the same initialization and `mm:start` marker;
no note can precede its instance's readiness. An exported file can therefore reinitialize
the rig when played from its beginning.

Unsupported program selection, unknown banks/parameters in startup `set`, and contradictory
instance initialization are configuration errors. A binding without program support remains
usable when no program is requested. Stop/replay runs initialization again; presets never
change as part of musical playback.

### 3.2 Parameters, locks and fallback values

Effective parameter precedence, from highest to lowest:

1. Active event locks.
2. Score part/override expressions.
3. Declared setup startup value (`set`).
4. Explicit instrument definition default.
5. Unknown value in the loaded patch/manual hardware state.

Setup values are also fallback baselines when a score expression is absent. At a lock end,
restore the currently sampled expression or declared baseline, never the value captured at
lock start. An absent value sends nothing. The software cannot infer or restore a loaded
preset's previous value without a declared baseline. If a lock can end into this unknown
fallback, report `I004` and retain the last sent value until another known value appears.
Authors can resolve this by supplying `set`, a definition default or a score expression.

Global `route <curve>` declarations are not supported. Write automation in
`.mm` and initial values with `set`; requesting routes is an explicit unsupported-feature
error. The supported layers follow the precedence above.

Arbitrate controls per output/channel/final destination, not per alias name. Latest active
lock wins; ties go to earlier part file order, then event identity. With no lock, latest
active expression-region start wins; same-start ties go to earlier part. Overlapping writers
produce `P007` once per relevant passage. Ending a winning layer recomputes the remaining
layers. CC pairs and complete NRPN updates are indivisible message groups for ordering.


## 4. What the backend does with the three files

```
score.mm ──expand/realize──> event IR (notes, lanes, named-parameter streams 0–1)
                                    │
setup ──binding──> part → instrument instance (port, channel, program)
inst  ──mapping──> named parameter → CC / NRPN / pitch bend, range, rate
                                    │
                                    ▼
                    MIDI file (one track per instance)  |  live MIDI  |  software audio
```

### 4.1 Device constraints

The backend enforces device constraints declared in the definition:
- **mono**: one note at a time, last-note priority. With `glide legato`, overlapping distinct
  pitches are a **legato handover** (§4.2); otherwise the old note is ended at the new onset
  (`D002`). A repeated same pitch always retriggers (note-off, then note-on);
- **range**: notes outside the range are octave-folded, with a warning;
- **voices**: voice limit for poly devices (oldest note stolen, `D002`);
- **rate** limits for parameter streams (§2.1);
- per-instance **latency** offsets (`latency:4ms` sends that instance earlier).

Every adaptation keeps the authored logical event and adds an **adaptation record**
(docs/reference/LANGUAGE.md §15.5); `explain` shows both.

### 4.2 MIDI 1.0 output rules (normative for the MIDI 1.0 backend)

These rules are the MIDI 1.0 backend's portable output policy. They are protocol-specific:
they do not define an output policy for MIDI 2.0 or OSC.

1. **Velocity**: note velocity = clamp(round(1 + v · 126), 1, 127). An attack with v = 0 is
   not sent, because a MIDI 1.0 note-on with velocity 0 means note-off; it gets an
   adaptation record.
2. **Same pitch on one channel**: receivers differ in how they handle a second note-on for a
   sounding pitch, so the backend never sends one. For each port, channel and pitch, an
   earlier note ends at the later note's onset (`D003`). **Equal-onset duplicates** merge
   into one note with the higher velocity and the longer gate; ties go to the earlier part in
   file order, then the earlier attack identity (`D003`).
3. **Equal-tick ordering**: at one tick, messages are sent in this order: note-offs, program
   and bank changes, CC / NRPN / pitch bend, note-ons. Within a class, by part file order,
   then pitch ascending.
4. **Legato handover exception**: for a mono `glide legato` instrument, a note-off whose
   note overlaps the next note is not sorted by rule 3. It is sent **immediately after** the
   paired note-on, at the same tick, so the device slides. Controllers at that tick still
   precede the note-on.
5. **Pre-roll**: the file starts early enough that latency, humanize, swing and program lead
   never place an event before tick 0. Score time 0 is marked with a marker event `mm:start`.
6. **Meter**: the normal time signature is written at each section start. A section whose
   extent is not whole bars gets a time-signature event at the **start of its final partial
   bar** whose numerator/denominator equal that bar's length (for example 2/4 for a half bar
   of 4/4), and the normal signature is restored at the next section start. If the partial
   bar's length is not expressible with a power-of-two denominator ≤ 64, no partial
   signature is written and `D004` warns that DAW bar lines will drift from the score.
7. **Clock**: per port, `clock:off|send` (default off for files, send for live play): 24 PPQN
   with Start, Stop and Song Position, so Elektron devices can follow.
8. **Ticks**: 960 PPQN. Exact rational times are rounded to the nearest tick (ties later);
   the ordering rules above apply after rounding.

Required MIDI fixtures (message traces, not audio):

| ID | Fixture | Expected messages |
|---|---|---|
| M01 | Two distinct pitches overlapping on a mono `glide legato` device | note-on B, then note-off A, same tick. |
| M02 | The same on a retriggering mono device | note-off A, then note-on B. |
| M03 | Overlapping same-pitch notes from two parts on one channel | First note shortened to the second's onset; `D003`. |
| M04 | Equal-onset same-pitch duplicates, velocities 0.5 and 0.9 | One note, velocity 114, longer gate; `D003`. |
| M05 | An attack with velocity 0 | No messages; adaptation record. |
| M06 | A 3½-bar section in 4/4 followed by a 4/4 section | 4/4 at section start, 2/4 at bar 4, 4/4 at the next section. |
| M07 | A program change and the first note at score time 0 with `program-lead 500ms` | CC0, CC32, PC, then ≥ 500 ms, then the note. |
| M08 | A lock and a note-on at the same tick | CC before note-on. |

### 4.3 Implicit export setup

Export without `--setup` assigns pitched parts channels in file order, skipping channel 10.
Drum parts share channel 10, with GM note mapping (`kick` 36, `snare` 38, `clap` 39, `hat` 42,
`openhat` 46, `tom`/`lowtom` 45, `hightom` 50, `rim` 37, `ride` 51, `crash` 49, `shaker` 70,
`conga` 64). Unknown drum lanes and more than 15 pitched parts are errors; never wrap channels.
It emits notes only, without programs, controllers or initialization, and one I002 info lists
the inferred mapping. Explicit setups remain required for live playback.

### 4.4 Checks

`mm check song.mm --setup studio.setup` reports:
- parts with no binding;
- parameters an instrument doesn't support;
- notes folded because they fall outside a device's range;
- density above a port's bandwidth;
- overlapping notes on mono devices (`D002`), same-pitch overlaps on one channel (`D003`), and partial bars that MIDI time
  signatures cannot express (`D004`).

`explain` shows, for any bar, the resolved device, channel and CC values next to the
musical events.

---

## 5. Responsibilities of each layer

- The score contains musical material, part roles and named parameter automation.
- An instrument definition maps those parameter names to MIDI messages and declares
  supported notes, voices, ranges and startup controls.
- A setup binds score parts to instrument instances, ports, channels and patches.

Changing MIDI routing or a device patch belongs in the setup. Software preset and
effect controls are documented separately in the renderer guides.
