# Language reference: midi-madness score format 1

Reference for the midi-madness score format 1 language. Consult the renderer guides for
software controls and backend limitations.
Use [Instruments and setups](INSTRUMENTS.md) for device mappings and [CLI reference](TOOLING.md) for commands. For a walkthrough, start with [Writing a song](../guides/WRITING_A_SONG.md).

MUST/SHOULD/MAY use their RFC 2119 meanings. Examples include standalone scores
and fragments that need the surrounding definitions indicated by their context.
Examples marked `// error:` demonstrate rejected input. Appendix B and the
regression fixtures define the executable contract.

The score declares musical material and performance controls. The compiler applies
the documented operators and defaults; it does not add compositional transitions
or rewrite harmony.

## Contents

- [File includes](#file-includes)
- [Sound restyling](#sound-restyling)
- [First look](#1-a-first-look) and [lexical rules](#2-lexical-rules)
- [Types and event model](#3-model)
- [Statements](#4-statements) and [song settings](#5-song-block)
- [Timed literals](#6-timed-literals) and [pattern operations](#7-operations)
- [Sequences and functions](#8-sequences-alternation-and-functions)
- [Harmony](#9-harmony)
- [Curves and signals](#10-curves-and-signals)
- [Conditions](#11-conditions) and [parts](#12-parts)
- [Silence](#13-silence) and [expectations](#14-expectations)
- [Execution contracts](#15-execution-contracts)
- [Grammar](#appendix-a-grammar), [fixtures](#appendix-b-required-fixtures), [Euclidean rhythms](#appendix-c-euclidean-rhythms-normative) and [prelude](#appendix-d-prelude-normative)
- [Software renderer extensions](#software-renderer-extensions)

---

## File includes

    include "kits/psy-drums.mmi" // shared definitions

    part acid
      restart never
      sound acid-303
      include "gen/acid.body.mmi"

An `include "<path>"` occupies its own line, with an optional trailing `//`
comment. File loading expands it textually before templates, data lanes, software
settings or parsing. The include line's indentation is added to every fragment
line. Paths resolve relative to the file containing the include; nested includes
are allowed. Cycles report the chain. A file may be included repeatedly; ordinary
duplicate-definition checks still apply.

Use `.mmi` for fragments: song discovery scans `.mm` files only. Fragments must
contain neither an `mm 1` header nor a `song` block. `data "..."` lanes in a
fragment resolve relative to that fragment. Diagnostics identify the original
file and line, followed by the include chain. String-based core APIs continue to
accept plain, already expanded mmdsl; file entry points use `loadScore`.

`mm expand song.mm` prints the include-expanded source with absolute data paths,
so it can be saved elsewhere and checked or rendered with the same meaning.

## Sound restyling

A derived score can reuse a complete score and change its sound without copying
its notes or form. Load it through a file command or `loadScore`:

    mm 1
    include score "base.mm"

    restyle group keys
      sound warm-lead
      cutoff = 0.6

    restyle part lead
      sound fm-keys
      insert = eq gain 3dB
      when in chorus:
        cutoff = 0.8

    restyle fx
      bus echo = delay time 1/8, feedback 0.3

    restyle bus echo
      return = 0.4

`include score` imports a complete `mm 1` score, including its song and form,
in place of the include line. The imported header is validated and omitted.
A derived file has its own `mm 1` header, exactly one top-level `include score`
before its restyle blocks, and no other top-level declarations. Layers can import
other layers. Paths, cycles, dependency hashes and diagnostic locations follow
the ordinary include rules. Indented fragment includes may supply restyle fields.
`mm expand` emits a standalone score with the overrides already applied.

`restyle part NAME` selects an explicitly declared part. `restyle group NAME`
selects whole explicit parts whose direct `group` declaration names that group;
per-note groups do not select parts. Template/loop-generated targets are
unsupported and report an error. Unmodified generated parts can coexist with
explicit targets. Overrides apply in order, with outer layers applied last.

Part patches accept static `sound`, `mono`, `voices` and `unison` settings,
`insert = ...`, and sound/control assignments: cutoff, resonance (`res`),
envelopes, level, pan, drive, oscillators, modulation, sends, insert controls and
spatial controls. They cannot change note material, range, group, lane, role,
velocity, length, restart or rate. Musical fields remain inherited.
Duplicate fields within a patch are errors. Values use the ordinary parameter
syntax and validation, including native units and section-keyed lanes.

A direct field replaces the matching direct field or is added if absent. Existing
conditional fields remain active and can override a changed direct value.
To change them, include the same `when ...:` condition and the specific fields;
unmentioned fields, including conditional `plays`, remain inherited. Conditions
match by text with normalized whitespace. Restyle bodies use two spaces and
conditional fields four spaces; nested conditions are unsupported.

`restyle fx` replaces the entire `fx` declaration block, or adds it if absent.
It accepts bus declarations only. `restyle bus NAME` changes controls and ducking
for a declared bus or the built-in `room`/`echo` buses. Existing sends and bus
controls remain inherited: replacement chains must preserve their referenced bus
and stage names or update the corresponding controls. Ordinary renderer
validation reports invalid references.

String-based parsing and rendering APIs accept the expanded source, as with
ordinary file includes. Source files are not modified by loading a derived score.

## 0. Principles

1. **Clarity over compactness.** Words over symbols where they help reading.
2. **Inspectable output.** Scores, diagnostics and realized events are available to
   people and external tools.
3. **Relationships are material.** A motif, its answer and its development are named, so the
   intent survives edits.
4. **Closure.** Every operation returns a typed value that can be named, transformed and used
   anywhere that type is accepted.
5. **Position, not history.** Conditions, alternation, clocks and randomness are functions of
   position and identity, never of evaluation order or counters.
6. **What you write is what plays.** No hidden rewrites: no automatic cadences, approach notes,
   entries or transitions. The few defaults (voice leading, dynamics, humanize) are visible
   in `explain` and switchable.
7. **Scores never contain MIDI.**
8. **Explicit backends.** MIDI setups and software sound controls have separate
   mappings; software effects do not become MIDI device commands.

---

## 1. A first look

```
mm 1
song "Language example"
  tempo 112
  meter 4/4
  key E dorian
  seed 3

motif  call   = | 1@3 3@3 4 5 | 7@2 5@2 4@4 |          // scale degrees: E G A B | D B A
motif  rise   = | c1 c3 c5 c3 | c5^@2 c3@2 |            // chord tones: follows the harmony
rhythm five   = steps 1/16: x . x x .                    // a 5/16 cycle against 4/4
signal accent = across 3 bars: sine 0..1

define answer(m: notes, step: steps) = m.fragment.shift(step)

phrase theme  = call  answer(call, +2)
section A     = theme  theme.where(last note of phrase: shift(+1))

form    = A  A.modulate(+2)
harmony = i IV v VII

part lead
  role front
  plays melody
  velocity = 0.55 + accent * 0.4

part arp
  role high
  plays notes rise.on(five.loop(2 bars))                 // chord tones re-voiced by the 5/16 rhythm

part kick
  lane kick
  plays hits | X . . . X . . . X . . . X . . . |

part pad
  role bed
  plays chords
  use duck(kick, 60%)                                    // prelude: sidechain from the kick
```

---

## 2. Lexical rules

### 2.1 Lines, blocks, comments, operators

- One statement per line. A block is the deeper-indented lines that follow; spaces only (a
  tab is `S010`). `//` starts a comment. `#` is only a sharp.
- Binary operators (`+ - * /`) in expressions MUST have a space on both sides. A sign
  against a number belongs to the number, and `/` without spaces is a fraction: `1/16` is a
  duration, `8 / 4` a division. A missing space in an expression is `S030`, with both readings
  offered as fixes. (Inside timed literals `+` stacks notes, §6.3.)

### 2.2 Identifiers and reserved words

- Letters, digits, `_` and `-`, starting with a letter; `-` only between letters or digits.
  Case-sensitive.
- **Reserved** (`S040`, with a suggestion): statement keywords (`mm song motif rhythm signal
  progression phrase section form define harmony curve when part silence expect`) and the
  joining words (`as in of on by with from to at for every since after before not and or
  always rest across steps`). Unit words (`bar`, `beats`, `pulse`, …) only follow numbers,
  so they stay usable as names.

### 2.3 Numbers and durations

- Integers `3`, `-2`. Decimals with a leading digit: `0.35` (`.35` is `S020`).
- Percentages `40%`. Fractions `1/16`. Ranges `0.2..0.9`, `2..4`, and open ranges `E4..`,
  `..C5` where stated.
- Durations: `1/16`, `1/8.` (dotted), `1/16t` (triplet), `2 beats`, `3 bars`,
  `1 bar + 1/8`, `2 pulses`, `2 steps` (on a step grid), and the context spans `section` and
  `phrase` (the current one's length). A **beat** is a quarter note in every meter.

---

## 3. Model

### 3.1 Types

| Type | Values | Binding keyword |
|---|---|---|
| `notes` | Timed note events with pitch spellings | `motif` |
| `hits` | Timed events without pitch (optional semitone offsets) | `rhythm` |
| `values` | A function of time | `signal` |
| `harmony` | Timed chord symbols | `progression` |

Scalars: `number`, `steps`, `semitones`, `span`, `percent`. Spans support `+`, `-` and
multiplication by a number (`extent(x) - 1 bar`, `2 * 1/8`); a negative span is `R011`.
**Zero spans are valid**: cropping or filling to zero (`.loop(0 bars)`, `rest(0 bars)`,
`.repeat(0)`, `.window(a, a)`) gives an **empty value** of the same type with extent 0, which
is the identity for sequencing. Zero or negative *speed factors* (`.fast(0)`, `.slow(0)`) and
`.fit(0 bars)` on a non-empty value are still `R011`.
In expressions, a percent reads as a fraction (`50%` is 0.5). Every timed value has an exact
**extent** (a rational duration ≥ 0), including empty ones: `rest(4 bars)` has extent 4 bars.

**Typed silence.** `rest(d)` takes its type from the context, and each type defines what
silence means:
- `notes`, `hits`: no events;
- `harmony`: `N` (no chord): chord adapters are silent, chord tones fall back to degrees;
- `values`: **absent**. An absent signal makes arithmetic absent too; a parameter whose
  expression is absent falls through to the next layer (§12.6); a comparison with an absent
  value is false.

So `delay`, `pad` and every other prelude definition built on `rest` have defined boundaries
for all four types.
Phrases, sections and the form are timed values with structure (unit boundaries, labels).
A sequence that mixes types is `R003`.

### 3.2 Events

A note or hit event has an **identity** (§15.1), a **nominal onset** (exact rational time),
a **written span** (holds included), a **gate** (the span after `length`), a **pitch
spelling** (notes) resolved to a pitch at its onset (§6.3, §9.3), a **velocity**, and
**parameter locks**. Swing and humanize shift the **performed** onset only; they never change
semantics.

### 3.3 Three stages

1. **Structure**: parse, resolve names and types, expand functions, build the form, harmony,
   keys and curves.
2. **Events**: realize each part's events from its own material, harmony, curves and
   conditions. **A part never reads another part's events here**, so no cycles exist.
3. **Controls**: fields that sample signals (velocity expressions, parameters), `trigger`
   signals from other parts' stage-2 onsets, and lock resolution.

**The no-cycle rule** (enforced): a signal is **event-derived** if its definition contains
`trigger`, directly or through any alias, signal, function or field function. Event-derived
signals are allowed only in stage-3 positions: part parameter expressions (`cutoff = …`,
`level = …`) and `velocity = …`. They are `C007` in every stage-2 position: event options,
`play when`, override headers, `.where` conditions, `.velocity(…)` on material, and any
binding used as material. So stage 2 never reads stage 3, and no cycle can form.

### 3.4 Determinism and query invariance

The same score, seed and engine version give the same events. Realizing the whole song or
querying any window yields the same events: a query returns each intersecting event with its
full span and looks back as far as needed (sustains, triggers, voicings). An onset is never
re-attacked by a later query.

### 3.5 Laws

1. Sequencing values of one type yields that type, with extent = the sum of extents.
2. Naming an expression and using the name is identical to writing it inline: same events,
   same random draws.
3. `.fit(s)` yields extent exactly `s`, including for empty values.

---

## 4. Statements

| Statement | Does |
|---|---|
| `mm 1` | Version (first line). |
| `song "…"` + block | Global settings (§5). |
| `motif n = …` / `rhythm n = …` / `signal n = …` / `progression n = …` | Bind a value of that type: a literal, a sequence or any expression. |
| `phrase n = <sequence>` | A unit with a phrase boundary. |
| `section n = <sequence>` | An arrangement unit. |
| `form = <sections>` | The main timeline. Exactly one. |
| `define n(params) = <expr>` | A value function (§8.3). |
| `define n(params):` + block | A field function: reusable part fields (§8.3). |
| `harmony [in <sections or labels>] = <harmony>` | Install harmony (§9.2). |
| `curve n = …` | A section-keyed signal (§10.1). |
| `when n = <condition>` | A named condition (§11). |
| `part n` + block | A part (§12). |
| `silence before <sections> for <span>` | A gap (§13). |
| `expect …` | Checkable intent (§14). |

---

## 5. Song block

```
song "Title"
  tempo 112                 // quarter notes per minute, constant
  meter 7/8 pulses 2+2+3
  key E dorian
  seed 3
  humanize 4ms              // or off (default 4ms)
  dynamics energy           // or flat (default energy, §10.1)
```

- Pulses default to quarters for d = 4, dotted quarters for 6/8, 9/8, 12/8, and the
  numerator's grouping otherwise. Pulses drive accents, `.thin`, `on pulse` and the `pulse`
  span; beats measure time.
- Modes: major, minor, dorian, phrygian, lydian, mixolydian, locrian, harmonic minor,
  melodic minor. Defaults: tempo 100, meter 4/4, C major, seed 1.

---

## 6. Timed literals

### 6.1 Placement

```
| x x x x |                        // fitted: a bar divided by four
| 1 3 5 _ | 4 _ 3 . |              // two bars
across 3 beats: x x x x x          // explicit quintuplet
steps 1/16: x . x x .              // stepped: a 5/16 cycle
steps 1/8 smooth: 0.2 0.5 0.9 0.5  // stepped values, interpolated
across 1 bar: ramp 0..1            // a shape with period 1 bar
```

- `across section: …` and `across phrase: …` take the current section's or phrase's length
  as their extent, so `plays notes across section: 1+5` is one held chord per section
  occurrence. They are valid only directly in a part's `plays` or field expressions (`R010`
  elsewhere), where that context exists.
- A bar literal ends at its last `|`.
- An unbracketed `across` or `steps` list runs to the end of the line or to the first `,` or
  `)` at its level. Parenthesize it to chain operations or sequence it:
  `(steps 1/16: x . x x .).rotate(1/16)` (`S031` otherwise).

### 6.2 Elements

| Element | Meaning | Types |
|---|---|---|
| `E4`, `C#5`, `Bb3` | Absolute pitch, **C4 = MIDI 60** (`B#3` = 60, `Cb4` = 59). | notes |
| `F`, `G#` | Pitch name without octave, nearest to the previous note. | notes |
| `1` … `7`, `3b`, `4#` | **Scale degree** of the current key, 1 = tonic; `b`/`#` alter it chromatically. | notes |
| `c1 c3 c5 c7 c9` | **Chord tone** of the installed chord at the note's onset (§6.3). | notes |
| `a+b+c` | A stack: simultaneous notes, e.g. `c1+c3+c5` or `E4+B4`. | notes |
| `x X o` | Hit at velocity 0.8 / 1.0 / 0.4. Notes default to 0.8. | hits |
| `x+7`, `x-5` | Hit with a semitone offset (used by `plays roots`, §12.2). | hits |
| `0.4`, `-0.3` | A value. | values |
| `.` | Rest. | notes, hits |
| `_` | Hold the previous note, hit or value, across bar lines and sequence elements. Nothing to hold is `T002`. | all |
| `[ … ]` | Binary subdivision of one slot. | all |
| `< a b >` | Alternation (§8.2). | all |
| `(across 1 beat: …)` | Inline tuplet in one slot. | all |

### 6.3 Pitch resolution

Pitch spellings resolve at each note's onset, in the pitch context of that moment (key and
installed chord, §9):
- **Chord tones**: `c1` root, `c3` third, `c5` fifth, `c7` seventh, `c9` ninth of the chord,
  with the chord's own quality (`c3` of `iv` is a minor third). If the symbol has no seventh
  or ninth, the diatonic one above the root is used. With `N` (no chord), chord tones are
  degrees 1, 3, 5, 7, 9.
- **Octave**: a degree, chord tone or octave-less name takes the octave **nearest to the
  previous note in the same literal** (ties go down). The first note of a literal is placed
  in the octave nearest the centre of the part's explicit range or role register (ties go down). Without a part register, standalone material uses octave 4 (C4..B4). `^` raises and `v` lowers a resolved note by an octave: `c5^`,
  `7v`. In a stack, each later note is placed **above** the one before. "Previous" means
  the previous realized event from the same literal, in timeline order, so resolution
  follows operations such as `.on`, `.reverse` and `.rotate`.
- Absolute pitches never change with the harmony.

So `| c1 c3 c5 c3 |` arpeggiates whatever chord is installed. Under `i` in E dorian it plays
E G B G; under `IV` it plays A C# E C#.

### 6.4 Modifiers

- `@3` **weight**: the element occupies three slots. A bar's slot count is the sum of its
  weights, and each slot is the bar divided by that count.
- `*2` **ratchet**: two equal attacks within the element's span.
- `(k,n)`, `(k,n,r)` **Euclid**: n equal slots with k onsets by the Bjorklund algorithm of
  Appendix C. Rotation r moves the pattern r steps earlier (left), mod n:
  `x(3,8)` = `x . . x . . x .`, `x(3,8,2)` = `. x . . x . x .`.

### 6.5 Event options `{ … }`

After an element or bracket, comma-separated: conditions (combined with `and`, §11),
`chance 40%` or `chance 40% fixed` (§11.4), field values (`velocity 0.9`, `length 1/8`), and
parameter locks (`cutoff 0.9`). Options on a bracket apply to each element inside.

### 6.6 Shapes

- `ramp a..b`, `sine a..b`, `triangle a..b`, `saw a..b`, `square a..b`,
  `random a..b every <step>`, `hold v`.
- The period L is the `across` span (`across 2 bars`, `across section`); a bare shape has
  L = 1 bar. A shape repeats with period L wherever it is used.
- Phase p = (t − origin) mod L. For `across section` and `across phrase`, the origin is the
  current section or phrase start and L its length; otherwise the origin is the use's reset
  (§12.3).
- `ramp`: a + (b − a)·p/L. `sine`: a + (b − a)·(1 − cos 2πp/L)/2 (starts at a). `triangle`
  rises a→b over the first half and falls back. `saw`: b − (b − a)·p/L. `square`: a for the
  first half, b for the second. `random a..b every s`: sample i = floor(p/s), drawn at
  (use, cycle, i) and held.
- Stepped values hold; with `smooth` they interpolate linearly to the next step, and the last
  step interpolates to the first.

### 6.7 No silent tuplets

Every slot at every nesting level (counted by weight) must last a binary duration: 2^k whole
notes or dotted (3 · 2^k). Otherwise write `across` or `steps 1/16t` (`T001` reports the
measured durations). Euclid expansions and alternation branches are checked separately.

---

## 7. Operations

Chained with `.name(args)`, applied left to right. Each is valid only on the listed types
(`R010` otherwise). Pitch operations are applied after resolution at each note's onset, so
`.shift` on chord tones moves the resolved pitch along the scale.

| Operation | Types | Effect | Extent |
|---|---|---|---|
| `.shift(+2)` | notes, harmony | Move by scale steps (`steps`). | = |
| `.transpose(+3)` | notes | Move by semitones; harmony unchanged. | = |
| `.octave(+1)` | notes | Move by octaves. | = |
| `.invert` | notes, values | Notes: mirror around the first note, in the scale. Values: v ↦ a + b − v. | = |
| `.reverse` | all | Retrograde. | = |
| `.rotate(1/8)`, `.rotate(2 steps)` | all | Begin that far into the cycle; content moves earlier and wraps. | = |
| `.fast(2)`, `.slow(2)` | all | Exact time scaling. | ×½, ×2 |
| `.fit(8 bars)` | all | Scale to that extent. | = s |
| `.loop(8 bars)` | all | Repeat to fill; the last cycle is cut. | = s |
| `.repeat(4)` | all | Four copies in sequence. | ×4 |
| `.fragment` | all | Repeat the first half to fill the extent. | = |
| `.thin` | notes, hits | Keep attacks on pulses, plus the last attack. | = |
| `.peak(bar 3)` | notes | Raise the highest note of bar 3 by two scale steps. | = |
| `.extend(2 bars)` | notes | Hold the last note longer. | + |
| `.mute` | notes, hits | Remove events, keep the extent. | = |
| `.recurse(n)` | notes | n times: replace each note by its bar's whole figure, fitted into the note's span and moved so its first note lands on the note's pitch (scale steps). n ≤ 3. | = |
| `.vary(k)`, `.vary(rhythm)`, `.vary(pitch)` | notes, hits | Seeded variation (§15.2). | = |
| `.seed(n)` | all | Use seed n for random draws inside this expression. | = |
| `.where(<condition>: ops)` | notes, hits | Apply ops only to events where the condition holds (§11.5). | = |
| `.velocity(expr)`, `.accent(0.2)` | notes, hits | Set velocity / add to it. | = |
| `.length(span \| percent)`, `.lengthen(1/8)` | notes, hits | Set gate / add to it. | = |
| `.rhythm` | notes | The onsets, spans and velocities as `hits`. | = |
| `.on(<hits>)` | notes | Re-voice: each hit takes the next note (stacks stay stacks), cycling; rests are skipped. Onsets, spans and velocities come from the hits. | hits' |

**`.vary` contract** (normative): type and extent are kept; onsets stay on the input's slot
grid; pitches stay in the scale. `vary(rhythm)` keeps the pitch sequence; `vary(pitch)` keeps
the onsets. `vary(k)` changes `min(k, 9) × 10%` of the attacks (rounded up), chosen by draws
at (`vary`, identity, attack). Changed attacks move by ±1–2 scale steps, or merge with or split
from a neighbour slot. The exact procedure is fixed per engine version and documented in
`mm help vary`.

Speed factors must be positive and spans non-negative (`R011`; zero spans give empty values, §3.1); bars must exist (`R012`). More than 64
attacks per bar in one part is `D001`, which names the operation chain.

---

## 8. Sequences, alternation and functions

### 8.1 Sequences and labels
Elements separated by spaces form a sequence, with extent equal to the sum. `as <name>` labels
an occurrence (`hook as second-pass`). Sections may have any exact extent; bar lines restart
at each section start, so a section of 3½ bars ends with a half bar.

### 8.2 Alternation

`<a b c>` picks branch `(n − 1) mod 3`, where n is the **cycle number of what encloses it**:
- in a part pattern: the pattern's cycle number since its reset (§12.3);
- in installed harmony: the progression's loop number within the occurrence;
- in `.loop` or `.repeat`: the copy number;
- in material placed in a sequence: 1 + the number of earlier occurrences of the same material
  in the current section occurrence.

So `phrase p = k <x y>` placed twice plays `k x`, then `k y`. All branches must have equal
extent (`T005`), or write `<a b>.fit(2 bars)`.

### 8.3 Functions

```
define answer(m: notes, step: steps) = m.fragment.shift(step)
define call-and-answer(m: notes, gap: span) = m  rest(gap)  answer(m, +2)
```

- **Value functions** (`= <expr>`) return a value. Calls: `answer(sigh, +2)`, or method
  style `sigh.answer(+2)`, where the receiver is the first argument. So library functions
  read like built-in operations.
- **Field functions** (`:` + an indented block of part fields) are reusable part settings
  with parameters:

  ```
  define pumped(source: part, amount: percent):
    level = 1 - trigger(source, decay 1/4) * amount
  part pad
    role bed
    plays chords
    use pumped(kick, 60%)
  ```

  `use f(args)` in a part or override block expands the fields in place. Fields are applied
  in the order written, and a later line replaces an earlier one, so lines after `use`
  override it. A field-function body contains fields only (no override blocks, no `use`).
- **Parameter types**: `notes`, `hits`, `values`, `harmony`, `timed` (any of those four; the
  result has the argument's type), `steps`, `semitones`, `span`, `number`, `percent`, `part`
  (a part name) and `condition` (substituted in parentheses).
- No recursion (`R002`). Free names resolve where the function is defined.
- Each call site is a separate use: random draws inside include the call site, so two calls
  vary independently. Deterministic bodies equal their inline expansion.

### 8.4 Composition primitives

Three primitives make the library in Appendix D possible:

| Primitive | Meaning |
|---|---|
| `extent(x)` | The exact extent of a timed value, as a span. With span arithmetic it measures and cuts: `x.loop(extent(x) - 1 bar)`. |
| `together(a, b, …)` | Parallel composition of timed values of one type, `notes` or `hits` (mixed types or `harmony` are `R003`). All start together; the extent is the longest; shorter ones are silent after their end. Events keep their identities, so two lines stay two lines. |
| Functions over `harmony`, `part` and `condition`, and field functions (§8.3) | Cadence helpers, gestures and presets become definitions. |

Everything else in Appendix D is written with these and the operations of §7.

---

## 9. Harmony

### 9.1 Chord symbols

Roman numerals relative to the key. The numeral is a degree of the current mode; `b`/`#`
prefixes alter the root. Case gives the quality: uppercase major, lowercase minor; `o`
diminished, `+` augmented. Suffixes: `7` (dominant on major, minor seventh on minor,
diminished seventh on `o`), `maj7`, `6`, `9`, `sus2`, `sus4`, `add9`, `ø7`. Inversions by bass
tone: `I/3`, `V/5`. Secondary chords: `V7/V`. `N` is no chord. Unknown symbols are `H001`,
with the grammar and the nearest symbol.

```
progression verse = i v VI iv
progression turn  = ii7 V7/V V7 i every 2 bars
```

Default rate: one chord per bar; `every 2 bars`, `twice per bar`, `every 1/2 bar` set it.
Progressions accept `shift`, `fit`, `fast`, `slow`, `loop`, `repeat`, `reverse`, sequences
and alternation.

### 9.2 Installing harmony

```
harmony           = verse
harmony in B      = III VII <VI iv> V
harmony in climax = verse.shift(+2)
```

The most specific match applies (a label beats its section); otherwise the default. An
installed progression restarts at each matching occurrence, loops if shorter, and is cut if
longer. With no `harmony` statement, the tonic chord holds throughout.

### 9.3 Modulation

`.modulate(n)` on a section reference in `form` (elsewhere `R015`) moves that occurrence's key
by n semitones, same mode. Every note whose **onset** lies in the occurrence moves exactly
once: degrees and chord tones resolve in the moved key and harmony; absolute pitches are
transposed by n. A note carried in from before keeps its pitch. `.transpose` stays local.

### 9.4 Voice leading

`plays chords` voicings minimize total semitone movement from the previous voicing within the
part's range (ties: the lower voicing). The first voicing is close position from the bottom of
the range. This is always on; it is the only harmonic decision the engine makes.

---

## 10. Curves and signals

### 10.1 Curves

```
curve energy = intro 2..3, A 4..6, climax 9..8, coda 2..1, others 5
curve bright = across song 3 5 9 4
```

- A curve is a section-keyed `values` signal on a 0..9 scale. `a..b` ramps linearly across
  each occurrence; a single value is constant; labels beat sections; unlisted units take
  `others` (default 5). `across song v1 v2 …` spaces the values evenly over the form.
- In arithmetic, a curve reads as value / 9; in conditions it compares on 0..9
  (`energy > 6`; `=` means within ±0.5).
- **`energy` is the only built-in meaning**: with `dynamics energy`, velocities are multiplied
  by 0.4 + 0.6 · energy / 9 (§12.6). Any other name is just a signal.

### 10.2 Signals

Signals are `values`: literals (§6.1, §6.6), curves, `trigger(…)`, and arithmetic over them.
Sequencing places signals in time (`signal s = a b`).

### Section-keyed parameter lanes

```text
cutoff = by section: verse 0.3, chorus 0.8, * 0.5 smooth 1 bar
```

`by section:` compiles constant scalar choices into a song-clock value lane.
A form label takes precedence over its original section name, then `*` supplies
a fallback. Repeated uses of a section share its choice; label a form occurrence
with `as` to give it a different choice. Entry order does not affect precedence.
Duplicate or unknown selectors and uncovered form sections are errors. Values
can use constant arithmetic, constant bindings and value-function parameters;
time-varying signals cannot serve as target constants.

Without `smooth`, each target takes effect at its section boundary. With a
positive musical span, later targets are approached linearly from the value at
that boundary. The first target applies immediately. An interrupted ramp starts
its next transition from its current value; an unchanged target continues its
existing ramp. The value reached at song end holds. Smoothing uses the parameter's
existing numeric domain, not a new physical-unit interpolation rule.

The compiler uses exact rational section/smoothing durations to build an ordinary
`per song S:` lane (or `per song S smooth:`). This clock follows song position
and ignores part restarts. Plain `per S:` retains its existing use-reset clock.
Both explicit forms loop; the section compiler includes end-hold points so its
lane does not wrap during the song. A compiled section lane is limited to 65,536
values; excessively fine grids produce an error rather than truncated output.

For `form = A B A`, with A lasting one bar and B two bars:

```text
cutoff = by section: A 0.2, B 0.8 smooth 1 bar
// Equivalent over this form:
cutoff = per song 1 bar smooth: 0.2, 0.2, 0.8, 0.8, 0.2, 0.2
```

Hold/smooth lanes, named signals and value functions use the same implementation.
Rates inside part plays may use song-clock lanes; dynamic lanes still cannot
define the form whose sections they depend on. Querying a window retains the
same values as realizing the complete song. Software fields that accept native
insert/bus/envelope literals also accept those literals as section targets.

### 10.3 Expressions

- Sources: numbers, signals, curves, `min`, `max`, `clamp(x, lo, hi)`, `pick(<condition>, a, b)`,
  parentheses.
- **Precedence**: `*` and `/` before `+` and `-`, each left-associative. `0.55 + accent * 0.4`
  is `0.55 + (accent * 0.4)`; `8 / 4 / 2` is 1.
- `cycle(0.9 0.6 0.7)` gives a value per attack, cycling from the part's reset (velocity
  patterns).
- A literal assigned to a parameter must lie in its domain (0..1, or -1..1 if bipolar,
  docs/reference/INSTRUMENTS.md). A computed expression is checked by interval arithmetic: if it can leave
  the domain, that is warning `P006` and the value is clamped. A possibly-zero divisor is
  `R013`.

### 10.4 `trigger`: onsets as a signal

```
signal pump = trigger(kick, decay 1/4)
signal hit  = trigger(snare, attack 1/64 decay 1/8, unscaled)
```

- `trigger(<part>, <envelope>[, unscaled][, sum])` is 0 except after each stage-2 onset of the
  part, where the envelope runs: `decay d` (1 → 0 linearly over d), `attack a decay d`, or
  breakpoints `env 0, 1 at 1/64, 0.3 at 1/8, 0 at 1/2`.
- Each envelope is scaled by its onset's **stage-2 velocity** (the literal and material
  operations, before the part's `velocity =` and dynamics) unless `unscaled`. Overlaps restart the
  envelope by default; `sum` adds (clamped to 1).
- A part may use a trigger of any part, itself included, because triggers read stage-2 onsets
  and are used at stage 3.

Sidechain pumping is then an ordinary parameter: `level = 1 - pump * 0.5`.

---

## 11. Conditions

### 11.1 Grammar

`not` > `and` > `or`, with parentheses. `in a, b` is one atom meaning `(in a or in b)`; the
comma list binds tighter than every operator, so `in build, build2 and bar < 8 of section`
applies to both.

### 11.2 Atoms

| Atom | True when |
|---|---|
| `every X of Y [unit] [since reset]` | `((n − 1) mod Y) + 1 = X`. |
| `every A..B of Y …` | `A ≤ ((n − 1) mod Y) + 1 ≤ B`. |
| `euclid K of Y …` | Step `((n − 1) mod Y) + 1` of E(K, Y) (Appendix C) is an onset. |
| `after N …` | `n > N`. |
| `in <name>, …` | Inside a section, phrase, motif or label with that name. |
| `bar 3 of <unit>`, `bar 5..6 of <unit>`, `bar > 4 of <unit>`, `bar < 8 of <unit>` | Bar number in the unit (`section` or `phrase`), from 1. |
| `first bar of <unit>`, `last bar of <unit>` | |
| `fill bar` | The last bar of a section. |
| `first note of <unit>`, `last note of <unit>` | The event is the unit's first / last attack (`bar`, `phrase`, `section`). |
| `highest note of <unit>`, `lowest note of <unit>` | The event has that unit's highest / lowest pitch (ties: all). |
| `on pulse`, `off pulse` | The onset lies on / off a pulse. |
| `energy > 6`, `<signal> > 0.7` | Curve (0..9) or signal sampled at the nominal time. |
| `<named>`, `always` | A named condition (acyclic, `C004`); true. |

Comparisons: `<`, `<=`, `>`, `>=`, `=`. Bounds: `Y ≥ 1`, `1 ≤ X ≤ Y`, `1 ≤ A ≤ B ≤ Y`,
`0 ≤ K ≤ Y` (`C005`). Note atoms need an event: in `play when` and override headers they are
`C006`. Signals there are sampled at the bar start. Event-derived signals are `C007` in
every condition (§3.3).

### 11.3 Position numbers

`n = floor((t − reset) / unit) + 1`, with t nominal (for `play when` and overrides, the bar
start).

| Context | Default n |
|---|---|
| Events in material (motifs, phrases) | the material's occurrence number in the section (§8.2) |
| Events in a part pattern | the pattern's cycle number since its reset (§12.3) |
| `play when`, override headers | bars since the section start |

Explicit units: `bars`, `beats`, `pulses`, `cycles`. Explicit resets: `since section`,
`since phrase`, `since song`, `since <label>`, `since restart`.

### 11.4 Chance

A chance passes when its draw u satisfies u < p. `chance p` draws per attack and cycle (a new
decision each repeat); `chance p fixed` draws once per source event (the same decision at
every repeat and use).

### 11.5 `.where`

```
section A  = theme  theme.where(last note of phrase: shift(+1), lengthen(1/8))
motif lift = hook.where(highest note of bar: accent(0.2))
rhythm hats = steps 1/16: x x x x
rhythm hat = hats.where(off pulse: velocity(0.5))
```

The condition is evaluated per event, against the value at that point in the chain. The
listed operations apply to the matching events only: `shift`, `transpose`, `octave`,
`velocity`, `accent`, `length`, `lengthen`, `mute`, and parameter locks (`cutoff 0.9`). Others
are `R010`.

---

## 12. Parts

### 12.1 Shape

```
part bass
  role low
  plays roots | X . . x . . x . |
  range D2..C#3
  length 1/16.
  play when groove
  level = 1 - pump * 0.55
  when in drop:
    plays roots | . x x x . x x x+12 . x x x . x x x+12 |
    length 1/32.
```

### 12.2 `plays`

| `plays` | Meaning |
|---|---|
| `melody`, `melody.<ops>` | The form's notes (the material of its sections), optionally transformed. |
| `line <notes>` | A notes expression placed from the song start, not cycled (an independent line that can cross sections). Silent after its extent; cut at the form's end. |
| `notes <notes>` | A notes expression cycled as a pattern. |
| `chords`, `chords <hits>` | Voice-led chords of the installed harmony, held per chord or played on hits. |
| `roots <hits>` | The chord root (or inversion bass) on each hit, plus the hit's semitone offset. |
| `arpeggio <hits>` | Chord tones of the voicing in `order`, one per hit. |
| `hits <hits>` | Drum hits on the part's `lane`. |

Any expression of the right type may follow, inline or named: `plays hits five.rotate(1/16)`.

### 12.3 Clocks, resets, gates

- A cycled pattern's phase is (t − reset) mod its extent. The reset defaults to the **section
  start**. `restart every 8 bars` resets at section start + k · 8 bars; `restart every phrase`
  at phrase starts; `restart never` at the song start.
- Signals in a part's fields share the part's reset, except `across section|phrase` shapes
  and curves (§6.6, §10.1).
- `play when <condition>` is a gate. It filters attacks at their onset; a note that started
  sounds to its end. The clock keeps running while the gate is closed.

### 12.4 Override blocks

`when <condition>:` blocks replace the fields they list, for the bars where the condition
holds. They are evaluated at each bar start, and at the exact start of `in <label>` regions.
Later blocks win per field. A replacing `plays` pattern enters at its current phase, or at its
start with `restart on entry` in the block. `explain` shows which block supplied each field.

### 12.5 Fields

| Field | Meaning |
|---|---|
| `role front\|bed\|low\|color\|high\|pulse` | Default register (§12.7) and setup binding. |
| `lane <name>` | Drum lane (docs/reference/INSTRUMENTS.md §1.3). |
| `range D2..C#3`, `range E4..`, `range ..C5` | Notes and roots outside are folded to the nearest octave inside (ties down), **before** hit offsets apply, so `x+12` still jumps an octave (`P004` when folding happens). Default: the role's register. |
| `octave +1` | Octave offset after `range`. |
| `length 1/8` / `length 50%` / `length legato` | Default gate: absolute, a percentage of the written span, or held to the next attack. A bare number is `R003`. |
| `voices 3`, `order 0 1 2^` | Chord size (default 3, or 4 when the symbol has a seventh); arpeggio order (indices of the voicing from the lowest, `^` up an octave, `v` down; cycles over the hits). |
| `restart …` | §12.3. |
| `play when <condition>` | §12.3. |
| `swing 58%`, `swing 58% on 1/8` | Every second step of the grid (default 1/16) starts at 58% of the step pair. 50% is straight, 66.7% a triplet feel. Performed timing only. |
| `humanize 4ms\|off`, `dynamics energy\|flat` | Override the song settings for this part. |
| `use f(args)` | Expand a field function here (§8.3). |
| `velocity = <expr>` | Replaces velocity, sampled per attack; inside it, `velocity` is the incoming value (`velocity = velocity * 0.8`). |
| `<param> = <expr>` | A named instrument parameter (docs/reference/INSTRUMENTS.md §1). |
| `sound NAME` | Select a fixed software preset; MIDI patch selection belongs in the setup. |

Gate precedence is explicit literal option > material `.length`/`.lengthen` > part `length` > written-span default. Humanize changes attack timing, but never creates a new mono or same-pitch overlap; only written overlaps become device slides.

### 12.6 Event fields and parameters

Velocity is built in order: the literal (`x X o`, `{velocity …}`) → material operations →
the part's `velocity =` → override blocks → `dynamics energy` → clamp to 0..1.

For each instrument parameter, the value at time t comes from the highest active layer:
**locks** (`{cutoff 0.9}`, over the event's gate) > the part's **expression** >
declared setup/instrument fallback values. MIDI fallback behavior is specified in
`docs/reference/INSTRUMENTS.md` §3.2. When a lock ends, the expression's *current*
value or declared baseline applies.
At one instant: lock end, then lock start, then expression changes. Locks from two parts on
one channel-wide parameter: the most recently started wins (same start: earlier part in the
file), with warning `P007`.

### 12.7 Roles

| Role | Default register |
|---|---|
| `front` | C4..C6 |
| `bed` | C3..C5 |
| `low` | E1..G3 |
| `color` | G3..G5 |
| `high` | C5..C7 |
| `pulse` | as written (drums) |

A part with a `lane` defaults to `pulse`; otherwise to `bed`.

---

## 13. Silence

```
silence before drop, drop2 for 1/2 beat
```

Removes attacks starting in the window before each listed section start and cuts notes
sounding into it.

---

## 14. Expectations

```
expect form length 32 bars
expect drop length 16 bars
expect lead range D4..F5
expect bass range in drop D2..C#3 at device
expect hat onsets per bar in drop between 6 and 12
expect in break: no kick
expect in bridge: lead, pad
```

- Measured on realized events (stage 3); `at device` after device adaptation (requires
  `--setup`).
- Section and label expectations hold for every occurrence.
- `onsets` counts distinct attack times; notes sustaining into a region don't count.
  `in X: a, b` requires at least one attack of each part in X; `no a` requires none.

---

## 15. Execution contracts

### 15.1 Identity
- **Path**: (name, ordinal among same-named siblings) from the form: `form/A#2/theme#1`.
  Labels (`as`) give stable names; `in <label>` matches every occurrence.
- **Source identity** of an event: the literal it comes from (its binding, or its file position
  if inline) and its slot and ratchet index. **Instance identity**: path, call sites, cycle
  number and source identity.

### 15.2 Randomness
- Before addresses are computed, names are replaced by their definitions and functions are
  expanded at their call sites (so Law 2 holds).
- **Address**: `["mm2", seed, purpose, …instance identity, operation ordinal]`, serialized as
  canonical JSON (RFC 8785: no whitespace, integers in decimal, rationals as `"p/q"` strings in
  lowest terms) in UTF-8. The operation ordinal counts from the chain's root literal. `seed` is
  the song seed, or the nearest enclosing `.seed(n)`.
- **Generator**: SHA-256 of the address; the first 8 bytes (big-endian) seed SplitMix64, which
  seeds xoshiro256**. The k-th draw at an address is the k-th output; floats are
  `(next() >> 11) · 2⁻⁵³` on unsigned 64-bit integers (BigInt in TypeScript).
- Purposes: `vary`, `chance`, `humanize`, `random`.

### 15.3 Time
Exact rationals (whole notes) until performance and device scheduling.

### 15.4 Boundaries
- Notes sounding at a section end, pattern restart or override change finish naturally.
- `.fit`, `.loop`, `silence` and the form's end cut notes at their boundary.
- A hold at a cycle's start continues the previous cycle's last note in the same part; in the
  first cycle it is silent.

### 15.5 Provenance
Every event records its source, the operation chain, the path and call sites, the pitch
resolution (spelling → chord or key → pitch), the override block, and **suppression records**
when conditions, chance, gates or silence removed it. Device changes add **adaptation
records** (docs/reference/INSTRUMENTS.md §4). This powers `explain`, `diff` and the feedback loop.

---

## 16. Tools

`docs/reference/TOOLING.md` specifies the `mm` CLI: `check`, `roll`, `explain`, `at`, `metrics`, `diff`,
`query`, `expand`, `format`, `fix`, `help`, `schema`, `render`, `export`, `play`, `feedback`,
`accept`.

**Acceptance.** `mm accept` marks the version you approved. It writes `<song>.accepted/`
containing:
- `source.mm`: the expanded accepted source, with external data lanes inlined, so
  the accepted version remains recoverable after dependencies change or disappear;
- `metadata.json`: the stored source's SHA-256, the dependency provenance hash and
  dependency list, the git revision and whether the working tree was
  **dirty** (if git is present), the engine version, and a SHA-256 digest of each part's
  realized events.

`diff --since accepted` always compares against the stored `source.mm`, never against git, so
it works for uncommitted and dirty states. Feedback entries keep their own frozen
source snapshots for the version on which the note was recorded. A
digest that no longer matches under the current engine is `L003`. There is no
lock file: determinism comes from the seed and the engine version.

---

## Appendix A. Grammar

```
file       = "mm" "1" NL { statement }
statement  = song | binding | structure | form | define | harmony | curve | when
           | part | silence | expect
binding    = ("motif" | "rhythm" | "signal" | "progression") name "=" seq
structure  = ("phrase" | "section") name "=" seq
form       = "form" "=" seq
define     = "define" name "(" [ param { "," param } ] ")" ( "=" seq | ":" NL INDENT { field NL } DEDENT )
param      = name ":" type
harmony    = "harmony" [ "in" name { "," name } ] "=" seq
when       = "when" name "=" condition
part       = "part" name NL INDENT { field NL | override } DEDENT
override   = "when" condition ":" NL INDENT { field NL } DEDENT

seq        = element { element }
element    = expr [ "as" name ]
expr       = product { ( "+" | "-" ) product }        // spaces required around operators
product    = term { ( "*" | "/" ) term }
term       = primary { "." opname [ "(" args ")" ] }
primary    = name | literal | call | per-values | section-values | "(" expr ")" | "<" seq ">" | "rest" "(" span ")"
per-values = "per" [ "song" ] span [ "smooth" ] ":" expr { "," expr }
section-values = "by" "section" ":" section-value { "," section-value } [ "smooth" span ]
section-value = ( name | "*" ) expr
call       = name "(" [ args ] ")"
args       = seq { "," seq }                         // an argument may be a sequence: cadence(V i)
where-args = condition ":" op { "," op }               // for .where
literal    = bars | "across" span ":" ( items | shape ) | "steps" span [ "smooth" ] ":" items | shape
bars       = "|" items "|" { items "|" }
items      = item { item }                            // unbracketed: ends at NL, or "," / ")"
item       = atom { "+" atom } [ "@" int ] [ "*" int ] [ "(" int "," int [ "," int ] ")" ] [ "{" options "}" ]
atom       = pitch | degree | chordtone | hit | number | "." | "_" | "[" items "]" | "<" items ">"
           | "(" "across" span ":" items ")"
condition  = cterm { "or" cterm }
cterm      = cfactor { "and" cfactor }
cfactor    = "not" cfactor | "(" condition ")" | atom-condition     // §11.2
```

## Appendix B. Required fixtures

| ID | Fixture | Expected |
|---|---|---|
| G01 | `0.55 + 0 * 0.4`; `2 * 0.75 - 1`; `8 / 4 / 2`; `(0.55 + 0) * 0.4` | 0.55; 0.5; 1; 0.22. |
| G02 | `a -1` as a sequence; `a -1` in an expression | Two elements; `S030`. |
| G03 | `steps 1/16: x . x .rotate(1/16)` | `S031`, fix `(steps 1/16: x . x .).rotate(1/16)`. |
| G04 | `length 0.2` | `R003`, fixes `length 20%` and `length 1/16`. |
| G05 | `part pad-1`; `rhythm pulse`; `part with` | Valid; valid; `S040`. |
| P01 | `C4`, `B#3`, `Cb4`; `\| E4 G C \|` | 60, 60, 59; E4 G4 C5. |
| P02 | `\| c1 c3 c5 c3 \|` under `i` then `IV` in E dorian | E4 G4 B4 G4; A4 C#5 E5 C#5. |
| P03 | `\| 1 3 5 7v \|` in D dorian | D4 F4 A4 C4. |
| P04 | `\| c1+c3+c5 \|` under `V7/V` in C major | D4 F#4 A4 stacked upward. |
| P05 | `c3` under `N` in C major; `c7` under `IV` in C major | E4; E (diatonic seventh above F). |
| P06 | `\| c1 c3 \|.shift(+1)` under `i` in A minor | B4 D5. |
| T01 | `\| x x x \|` in 4/4 and 6/8; `\| x x [x x x] x \|` in 4/4 | `T001`; valid; `T001`. |
| T02 | `\| E4@3 G@3 A B \|` in 4/4 | Dotted quarter, dotted quarter, eighth, eighth. |
| T03 | Appendix C vectors; `x(3,8,2)`; `x(3,8,10)` | As listed; `. x . . x . x .` twice. |
| T04 | A 5/16 pattern with `restart every 8 bars`, gated off in bars 3–4 | Silent in bars 3–4; bar 5 continues at phase 4/16. |
| T05 | An override replacing a 5-step pattern with a 7-step one in bars 5–6 | Both at their current phase; with `restart on entry`, step 1 at bar 5. |
| T06 | `swing 60%` on `steps 1/16: x x x x` | Steps 2 and 4 performed 1/80 bar late; nominal onsets unchanged. |
| T07 | `across 2 bars: sine 0..1` at 0, 1 bar, 2 bars; `across section: ramp 0..1` in an 8-bar section at bar 5 | 0, 1, 0; 0.5. |
| T08 | A 1-bar `cutoff = across 1 bar: ramp 0.2..0.8` over 8 bars | Eight identical ramps. |
| C01 | `every 4 of 4`, 8 bars | Bars 4 and 8. |
| C02 | `every 2..3 of 4`, `not every 1 of 4`, `euclid 3 of 8`, 16 bars | {2,3,6,7,10,11,14,15}; all but {1,5,9,13}; n ∈ {1,4,7} mod 8. |
| C03 | `harmony in B = III VII <VI iv> V`, B is 8 bars | Bars 3 and 7: VI, then iv. |
| C04 | `\| x <x o> \|` as a part pattern, 4 bars | Beat 3: x, o, x, o. |
| C05 | `phrase p = k <x y>`; `section s = p p` | k x k y. |
| C06 | `chance 50%` vs `chance 50% fixed` in a motif repeated 4× | Independent vs identical. |
| C07 | `play when in build, build2 and bar < 8 of section` | Bars 1–7 of both sections. |
| C08 | `play when last note of bar` | `C006`. |
| C09 | `.where(last note of phrase: shift(+1))` then `.reverse` | The shifted notes are the former last notes, now first. |
| L01 | `rhythm r = five.rotate(1/16).vary(1)` by name vs inline | Identical events and draws. |
| L02 | `rest(4 bars).slow(2).fit(3 bars)` | Extent 3 bars, no events. |
| L03 | A function with `.vary(1)` called twice; a deterministic function vs its body | Different variations; identical events. |
| L04 | `hook.vary(1)` vs `hook.vary(1).seed(7)` | Different variations; each stable across runs. |
| L05 | `rise.on(five)` with 4 notes and a 5-step rhythm over 1 bar | Notes 1 2 3 4 1 … on the rhythm's onsets. |
| S01 | `trigger(kick, decay 1/4)` queried in two halves vs whole | Identical values across the split. |
| S02 | A part using its own trigger in `level =` | Valid. |
| H01 | `A.modulate(+2)` with roots, chords, a degree note, an absolute note, a `line` note starting inside, and one carried in | All move +2 exactly once, except the carried note. |
| H02 | `.transpose(+3)` inside a modulated occurrence | Notes +5; harmony +2. |
| H03 | `V7/V`, `bVII`, `viio`, `I/3` in C major | D F# A C; Bb D F; B D F; E bass under C E G. |
| H04 | `range D2..C#3` with `x+12` | Root folded into the range, then +12. |
| H05 | Changing one chord under voice leading | `diff` shows the following voicings changing until they coincide again. |
| X01 | `2 * sweep - 1` to bipolar `pan`; `pan = 1.5` | Valid; error. |
| X02 | `velocity = 0.55 + accent * 0.4` on a motif with `.accent(0.2)`; `velocity = velocity * 0.8` | Replaces; scales. |
| F01 | `extent(\| x x \| x x \|)`; `rest(1 bar).loop(extent(hook) - 1/2 bar)` with a 2-bar hook | 2 bars; extent 1½ bars, no events. |
| F02 | `together(a, b)` with a 2 bars, b 3 bars | Extent 3 bars; a silent after bar 2; identities kept. |
| F03 | `hook.window(1 bar, 2 bars)`; `hook.truncate(1/2 bar)`; `hook.delay(1/8)` | Bar 2 of hook; hook minus its last half bar; 1/8 rest then hook. |
| F04 | `use duck(kick, 50%)` then `level = 1` on the next line | `level` is 1 (later line wins); `explain` shows both sources. |
| F05 | `verse.cadence(V i)` with `verse = i v VI iv`; `pop.cadence(V I)` with `pop = I vi IV V` | i v V i; I vi V I. |
| F08 | `play when pump > 0.5` with `signal pump = trigger(kick, decay 1/4)`; the same through an alias `signal p2 = pump * 2`; `.where(pump > 0.5: …)` | `C007` in all three. `level = 1 - pump` is valid. |
| F09 | `rest(1 bar)` as notes, harmony and values: `delay(x, 1 bar)` for each | No events; `N` for one bar; absent for one bar (the parameter falls through to the next layer). |
| F10 | A part with `use drone()` in an 8-bar section | One attack at bar 1, held 8 bars. |
| F11 | Every prelude definition and every snippet in this document | Parses and passes `mm check`. |
| F12 | `verse.cadence(i v VI iv)` (ending as long as the progression); `x.loop(0 bars)`; `.fast(0)` | Equals the ending (truncate gives an empty value); empty, extent 0; `R011`. |
| F13 | `mm accept` with uncommitted edits, then edit again and `mm diff --since accepted` | The snapshot holds the exact accepted source with `dirty: true`; the diff shows only the later edit. |
| F06 | `use entry-hit(in drop, drop2)` | Hits only in bar 1 of drop and drop2. |
| F07 | A user `define delay(…)` | `R004`: prelude names cannot be redefined. |

MIDI output fixtures are in docs/reference/INSTRUMENTS.md §4.2.

## Appendix C. Euclidean rhythms (normative)

```
E(k, n):                         // 0 ≤ k ≤ n
  if k == 0: return n rests
  if k == n: return n onsets
  a = k copies of [onset]; b = (n − k) copies of [rest]
  i = k; j = n − k
  while min(i, j) > 1:
    if i > j:  a, b, i, j = [a[x] ++ b[x] for x < j], a[j..], j, i − j
    else:      a, b, i, j = [a[x] ++ b[x] for x < i], b[i..], i, j − i
  return concat(a) ++ concat(b)
```

| E | Pattern | E | Pattern |
|---|---|---|---|
| (0,8) | `........` | (5,9) | `x.x.x.x.x` |
| (1,4) | `x...` | (5,12) | `x..x.x..x.x.` |
| (2,5) | `x.x..` | (5,16) | `x..x..x..x..x...` |
| (3,4) | `xxx.` | (7,12) | `x.xx.x.xx.x.` |
| (3,5) | `x.x.x` | (7,16) | `x..x.x.x..x.x.x.` |
| (3,7) | `x.x.x..` | (9,16) | `x.xx.x.x.xx.x.x.` |
| (3,8) | `x..x..x.` | (11,16) | `x.xx.xx.xx.xx.xx` |
| (4,7) | `x.x.x.x` | (13,16) | `x.xxxx.xxxx.xxxx` |
| (4,9) | `x.x.x.x..` | (8,8) | `xxxxxxxx` |
| (5,8) | `x.xx.xx.` | (4,12) | `x..x..x..x..` |

## Appendix D. Prelude (normative)

The prelude is part of every song. It is written in mmdsl, so every definition here must
pass `mm check`. Its names cannot be redefined (`R004`). `mm help <name>` prints the source,
and `explain` shows expansions with their call sites.

```
// ── time: cut, slice, offset ──────────────────────────────────────────────
define delay(x: timed, d: span)              = rest(d)  x
define truncate(x: timed, d: span)           = x.loop(extent(x) - d)
define window(x: timed, a: span, b: span)    = x.rotate(a).loop(b - a)
define pad(x: timed, s: span)                = x  rest(s - extent(x))

// ── texture: lines in parallel ────────────────────────────────────────────
define canon(x: notes, d: span)              = together(x, x.delay(d).truncate(d))
define double(x: notes, step: steps)         = together(x, x.shift(step))
define octaves(x: notes)                     = together(x, x.octave(+1))

// ── cadences: written harmony, not inferred ───────────────────────────────
// the arrival is an argument, so one helper serves every key and cadence:
// verse.cadence(V i), verse.cadence(V I), verse.cadence(V), verse.cadence(V VI), verse.cadence(iv i)
define cadence(p: harmony, ending: harmony)  = p.truncate(extent(ending))  ending

// ── part gestures and presets ─────────────────────────────────────────────
define duck(source: part, amount: percent):
  level = 1 - trigger(source, decay 1/4) * amount

define riser():                      // one held tonic per section, opening over it
  plays notes across section: 1
  cutoff = across section: ramp 0..1
  level = across section: ramp 0.2..1

define drone():                      // one held tonic and fifth per section
  plays notes across section: 1+5

define entry-hit(where: condition):
  plays hits | X . . . |
  play when first bar of section and where
```

Notes:
- `cadence` replaces the last `extent(ending)` of a progression with the ending, so the
  author names the arrival explicitly (`V I` in major, `V i` in minor).
- `riser` and `drone` attack once at each section start. If their gate opens later in a
  section, they stay silent until the next section (gates filter onsets, §12.3).
- `canon` truncates the delayed copy, so the result keeps the original extent.

## Software renderer extensions

### Load-time templates and value sequences

The core language accepts typed part templates and literal-row `for` loops, which
expand into ordinary parts before resolution. Generated events retain template
arguments and source provenance. The expression `per S: v1, v2, ...` holds constant
scalar values for span S, then loops from the use reset; `per S smooth:` interpolates
through every step, including the wrap. Pattern-operation arguments are sampled at
cycle starts and restart the pattern at step boundaries. This applies inside part
plays; dynamic per rates in song form are rejected.

Exact supported syntax, expansion limits and workflow examples are in
`packages/render/WORKFLOW.md`. The executable fixture is
`tests/fixtures/render/workflow.mm`, with focused checks in `tests/workflow.test.ts`.

Software parts can select a fixed preset with `sound <name>`, including `ks-pluck`
and `choir`. Their `pluck.*`, vowel/formant and `lfo.vowel` controls use ordinary
parameter expressions; fixed pluck decay times and formant shifts accept `ms`/`s`
and `st` literals. See `packages/render/SOUNDS.md` and the executable score
`tests/fixtures/render/new-sounds.mm`. Sound changes inside conditional `when` overrides and MIDI
transport of preset selection are not supported. Derived-score `restyle` blocks
can replace a part's static sound selection.

`mm render` and `mm check --setup setups/band/band.setup` accept named effect buses,
ordered insert chains, note-triggered bus ducking, `silence ... and cut fx`, and song
tuning (`equal`, five-/seven-limit `just from <pitch class>` or `just chord`, and
explicit twelve-class `cents` tables). A pitch suffix such as `G3-13.69ct` lowers
to a `cents` lock; cents are additive to the tuning declaration and member bend.
Tuning is captured at attack and remains independent for overlapping voices.
Independent suffixes inside a `+` chord are unsupported. The MIDI-setup backend
does not transport this tuning declaration. Per-part DAW export encodes fractional
tuning as channel bend with reported overlap/range limits; see
[DAW export](../guides/EXPORTING_TO_A_DAW.md).

These extensions lower to the existing AST in the software score adapter. Ordinary
core commands and the MIDI-setup backend do not accept the extra declaration syntax.
Per-part DAW export uses the software adapter. Exact supported
fields and bounds are in `packages/render/INSERTS.md` and `packages/render/EFFECTS.md`.
The executable syntax examples are `tests/fixtures/render/inserts.mm` and
`tests/fixtures/render/effects.mm`; focused scheduling/routing checks are in
`tests/processing.test.ts`.

### Note primitives and spatial extensions

The grammar above describes the core language. The following software extensions
are defined in their linked references, including syntax and backend limits:

- [Curves and arithmetic](../../packages/render/PRIMITIVES.md#exponential-curves-and-arithmetic):
  `exp`/`log` shapes, right-associative `^`, and `pow(a, b)`.
- [External data lanes](../../packages/render/PRIMITIVES.md#data-lanes): containing-file-relative
  JSON/CSV numeric arrays with explicit grid and hold/smooth interpolation.
- [Per-note paths](../../packages/render/PRIMITIVES.md#per-note-paths),
  [ratchets](../../packages/render/PRIMITIVES.md#ratchets) and
  [synth grains](../../packages/render/PRIMITIVES.md#synth-grains): independent voice
  motion and bounded, deterministic attack generation. Ratchets lower for MIDI;
  independent voice paths and grains require software rendering.
- [Group tags](../../packages/render/PRIMITIVES.md#grouped-stems): part defaults and
  per-note overrides, with `mm render --stems-by group`.
- [Spatial declarations and listener automation](../../packages/render/SPATIAL.md):
  stereo/binaural/first-order ambisonic output, world or listener-relative source
  coordinates, and song-level `listener` lanes. These declarations require the
  software target; they do not create MIDI hardware spatial control.
- [Literal profile 1](LITERAL_V1.md): `literal 1` in the song header declares the
  compatibility contract; it does not restrict the parser to a subset.

Executable regression fixtures are `tests/fixtures/render/primitives.mm` and
`tests/fixtures/render/literal-v1.mm`. Focused suites also cover native units,
spatial motion, world coordinates, envelope exports and grouped stems.
