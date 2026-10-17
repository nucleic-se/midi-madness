# CLI reference

Command reference for `mm`. See the [language reference](LANGUAGE.md)
and [instrument/setup reference](INSTRUMENTS.md) for score and device syntax.
Commands below use `mm` as shorthand for `npm run mm --` from the repository root.

## Find a command

- Check and inspect: check, expand, roll, explain, at, metrics, query.
- Compare and record: diff, accept, feedback.
- Edit layout or inspect fixes: format, fix.
- Produce output: render, export, play, ports, panic.
- Get reference information: help, schema.

See the [command table](#2-commands) for flags and files written. Task guides cover
[rendering](../guides/RENDERING_AUDIO.md), [MIDI](../guides/USING_MIDI.md) and
[inspection](../guides/INSPECTING_SCORES.md).

## 1. Output and file handling

Commands print human-readable output by default. `--json` returns a shared envelope
with a command-specific result, diagnostics and summary counts. `mm schema <command>`
describes that envelope; it does not specify every command result field.

`check`, inspection, help, schema, diff and fix do not modify scores. `fix` lists
available edits for the caller to apply. `format` rewrites the main score's layout;
`accept` and `feedback` save versioned source records. `render` and `export` write
their requested audio/MIDI outputs. `play` and `panic` send MIDI messages.

Diagnostics include source locations, and may add musical paths, measured values,
possible causes and mechanical edits. The exact fields depend on the diagnostic.
Read-only commands can be used from an editor, script or interactive session.

## 2. Commands

| Command | Purpose | Writes |
|---|---|---|
| `mm check <song>` | Parse, expand, realize, verify `expect`; list diagnostics (§3.1). | — |
| `mm expand <song>` | Print plain source with includes expanded and data paths resolved; `--json` adds dependency provenance. | — |
| `mm expand <song> --to section` | Inspect section occurrence paths, onsets and extents; JSON also contains bars and total extent. | — |
| `mm explain <song> <name\|path> [--bar N] [--part P] [--positions]` | Inspect a passage and its resolved events (§4). | — |
| `mm at <song> <time\|bar>` | Map "1:40" or "bar 37" to section, occurrence, phrase, bar, beat, and the parts sounding. | — |
| `mm roll <song> [--part P] [--bars A..B] [--harmony]` | Text piano roll; drum lanes as a step grid. | — |
| `mm metrics <song>` | Per section: length, energy, ranges, events per bar per part, repetition, density. | — |
| `mm diff <a> <b>` / `mm diff <song> --since accepted\|<git rev>` | Musical diff (§5). | — |
| `mm fix <song>` | Lists available diagnostic edits; applying them is manual. | — |
| `mm format <song>` | Normalize indentation and whitespace, preserving authored tokens, comments and include directives. | main score |
| `mm accept <song>` | Mark the approved version: expanded source with frozen data lanes, dependency hashes, git revision and dirty flag, engine version and per-part digests in `<song>.accepted/` (docs/reference/LANGUAGE.md §16). | `<song>.accepted/` |
| `mm help [topic]` | Documentation (§6), including the source of every prelude definition. | — |
| `mm schema <command>` | JSON envelope schema labelled for the command; result payloads are generic object/array values. | — |
| `mm query <song> --from <t> --to <t>` | Windowed realization (docs/reference/LANGUAGE.md §3.4); for checking query invariance. | — |
| `mm render <song> [--from <section\|bar> --bars N] [--out mix.wav] [--stems-by group] [--no-analysis]` | Software audio rendering; default setup `setups/band/band.setup`. | WAV and minimal reports |
| `mm export <song> [--setup <setup>] --midi out.mid` | MIDI file through instrument definitions and a setup. | MIDI file |
| `mm play <song> --setup <setup> [--from "bar N" \| --bars A..B] [--loop] [--clock send\|off]` | Live MIDI playback, controller chase and range looping. | — |
| `mm ports` | List physical/virtual MIDI outputs; no messages sent. | — |
| `mm panic --setup <setup>` | Explicit note-offs and CC123/120 on the setup channels. | — |
| `mm feedback <song> "<text>" [--at 1:40]` | Log listener feedback against the current version, resolved to paths (§7). | feedback log |

For software validation, use `check song.mm --setup setups/band/band.setup`; this
selects software sound, insert and bus checks. Plain `check` checks the score
without a software or MIDI setup. Check results include
`validation: { target: "core" | "software" | "midi", software: boolean }`.
Plain checks warn with `I005` when they encounter software settings they do not
validate. An unknown software preset, insert or bus setting is a score error
(exit 1) when checked against the software setup or rendered. Diagnostics retain
included-file locations; errors in template-generated fields point to the invocation.

Common flags: `--json` and `--quiet`. `--quiet` suppresses human results while
retaining diagnostics. Output is plain text. `--setup <file>` adds instrument
checks to check/inspection commands, fix, format, accept and diff; render, export,
play and panic also accept it. `help alias` requires a setup.

Options are checked per command. Unknown, duplicate or irrelevant options and
missing values are usage errors. `expand --to` accepts only `section`; `render
--bars` takes a positive count, while `roll`/`play --bars` accept a bar or ascending
`A..B` range. `render --tail` accepts 0–120 seconds. Use `play --from` or `--bars`
to select its range. `--clock` accepts `send` or `off`.

The software renderer defaults to stereo 48 kHz, 24-bit audio at
`renders/<song>/mix.wav`, plus `mix.events.json`, `report.json` and `report.txt`.
`space binaural` also writes stereo PCM; `space ambisonic 1` writes four-channel
32-bit float ACN/SN3D. The event sidecar is written even with `--no-analysis`;
it contains exact backend sample timing, source events, spatial lanes and
recorded control envelopes. See [spatial output](../../packages/render/SPATIAL.md).
`--stems-by group` writes stereo float group contributions independently of
`--analysis`; ambisonic grouped stems are unsupported. See
[grouped stems](../../packages/render/PRIMITIVES.md#grouped-stems). `--setup` chooses a
software setup; `--tail N` sets the maximum release/effect tail (default 12 s).
`--solo lead,keys` includes only those members; `--mute kick` removes named members,
including their sends. Automation retains the original song context. `--analysis`
adds float WAV stems, mix/section/part spectrograms, and per-bar RMS/peak measurements
under `analysis/`, with an HTML listening page. It requires ffmpeg for images.
`--no-analysis` omits report files and analysis and overrides `--analysis`. Full renders retain opening rests; excerpts render
from song start internally and then crop. Reports list duration, peak, silent
scheduled members, slides, accents and ignored controls. Current draft DSP
shortcuts are documented in `packages/render/README.md`.

**Exit codes** (every command): 0 when there are no errors (warnings and infos allowed),
1 when there are errors, 2 on usage or I/O failure. Live Ctrl-C performs cleanup and exits 130.

**JSON envelope** (every command with `--json`): one object on stdout,

```json
{
  "schemaVersion": "1",
  "command": "check",
  "file": "song.mm",
  "engine": "1.0.0",
  "result": { "stage": "realized", "validation": { "target": "core", "software": false } },
  "diagnostics": [],
  "summary": { "errors": 0, "warnings": 0, "infos": 0 }
}
```

This compact example illustrates the envelope; successful checks also return
source dependency and provenance fields in `result`.

`result` is the command-specific payload. `mm schema <command>` describes the
shared envelope and diagnostic shape, with a generic object/array result. Diagnostics appear in every
command's envelope, so external tools can read diagnostics without parsing terminal text.

## 3. Diagnostics

### 3.1 Format

Run `npm run mm -- check tests/fixtures/G04.mm` to see an error with two fixes.
The command exits with status 1:

```text
error[R003]: length 0.2 needs a span or percent
  --> tests/fixtures/G04.mm:3:10 (part lead)
 3 |   length 0.2
   |          ^^^
   = measured: {"value":"0.2","required":["span","percent"]}
   = fix: use a percentage of the written span → 20%
   = fix: use a sixteenth-note gate → 1/16
   = help: mm help R003
1 errors, 0 warnings, 0 infos
```

With `--json`, each diagnostic has `code`, `severity`, `message`, `span`,
`causes`, `fixes` and `help`. Optional fields include `file`, a musical `path`,
`measured` values and the `includedFrom` chain. Locations use one-based lines and
columns; edit paths may be absolute. Empty `causes` or `fixes` arrays mean none
were supplied. See `mm schema check` for the shared shape.

### 3.2 Diagnostic behavior

Unknown names can suggest similar definitions. Repeated references to the same
missing name are combined where the resolver can do so. Fixes describe exact edits;
no edit is applied by `check` or `fix`. Some diagnostics carry measured values or
a musical occurrence path; these fields are not present for every error.

Compiler checks collect diagnostics where compilation can continue. Structural
include failures and unreadable dependencies stop file loading at the first
failure, with the original file location and include chain.

### 3.3 Diagnostic catalog

| Code | Severity | Condition |
|---|---|---|
| `S001`–`S099` | error | Syntax: unexpected token, unclosed `[`/`<`/`{`/`(`, bad indentation, unknown keyword (with a suggestion). Includes: invalid directives, cycles, forbidden fragment headers/song blocks and unreadable include/data dependencies. Notable: `S010` tab character; `S020` decimal without a leading digit (`.35`); `S030` binary operator without spaces; `S031` unparenthesized `across`/`steps` literal followed by an operation or sequence item; `S040` reserved word used as a name. |
| `R001` | error | Unknown name (with suggestions and kind). |
| `R002` | error | Recursive definition or function (shows the cycle). |
| `R003` | error | Type mismatch: binding keyword vs expression type, a sequence mixing types, an unnamed mixed-type overlay, the wrong interval unit, a bare number where a unit is required (`length 0.2`), or an invalid software sound/effect setting. |
| `R004` | error | Duplicate name, a redefined prelude name, or an ambiguous selector where one occurrence is required (`explain`); lists the candidates. |
| `R010` | error | Operation not valid on this type, or a zero-extent value with events passed to `.fit`/`.loop`/`.fragment`. |
| `R011` | error | Non-positive speed factor (`.fast(0)`), negative span, or `.fit(0 bars)` on a non-empty value. Zero-span crops are valid and give empty values. |
| `R012` | error | Bar argument outside the material (`.peak(bar 5)` on a 4-bar motif). |
| `R013` | error | Possibly-zero divisor in an expression. |
| `R015` | error | `.modulate` outside a section reference in `form`. |
| `T001` | error | Silent tuplet: a slot duration is not binary (shows the measured durations). |
| `T002` | error | `_` hold with nothing to hold in the same literal or sequence. |
| `T005` | error | Alternation branches with unequal extents (add `.fit`). |
| `H001` | error | Unknown chord symbol (shows the accepted grammar and the nearest symbol). |
| `C001` | error | Unknown condition atom (with suggestions). |
| `C003` | warning | A condition is never true / always true in this song (lists where it was evaluated). |
| `C004` | error | Cycle among named conditions. |
| `C005` | error | Condition bounds out of range (`every 5 of 4`, `euclid 9 of 8`). |
| `C006` | error | An event-local atom (`with`, `without`, event-derived signal) in a region-resolved override condition. |
| `P001` | warning | A part never sounds. |
| `P002` | warning | An override block never applies. |
| `P003` | info | An override block is shadowed by a later block on every bar. |
| `P004` | warning | Notes outside the role's or the `range`'s register were folded (lists count and bars). |
| `P006` | warning | An expression's computed range can leave the destination domain; it will be clamped. |
| `P007` | warning | Overlapping locks or expressions on one channel-wide parameter (lists parts and bars). |
| `D001` | error | Density limit exceeded (shows the operation chain, e.g. `seed.recurse(2)` inside `A.recurse`). |
| `D002` | warning | Mono instrument receives overlapping notes (with `--setup`). |
| `D003` | warning | Same pitch overlapping on one channel: the earlier note was shortened, or equal-onset duplicates were merged (with `--setup`). |
| `D004` | warning | A partial bar cannot be written as a MIDI time signature; DAW bar lines will drift (export). |
| `X001` | error | An `expect` failed (shows expected vs measured). |
| `L003` | warning | A part's realized events no longer match the accepted digest under the current engine. |
| `C007` | error | An event-derived signal (containing `trigger`, directly or through aliases or functions) in a stage-2 position: event options, `play when`, override headers, `.where`, material. |
| `I001` | warning | Parameter in the vocabulary but not supported by the bound instrument (with `--setup`). |
| `I002` | error | Part has no binding in the setup (with `--setup`). |
| `I003` | error | Parameter name is neither in the standard vocabulary nor defined by any instrument in the setup (with suggestions). |
| `I005` | warning | Plain core check encountered software settings that require a software setup for validation. |
| `F001` | info | Non-canonical spelling; `format` would rewrite it. |

## 4. `explain`

`mm explain song.mm --bar 37 [--part lead] [--positions]` inspects one realized bar. A positional
section name or occurrence path selects its first bar; ambiguous names report
candidates. The result lists harmony, curves, sounding parts, source spans,
pattern operations and suppressed events. `--positions` adds each event's onset
bar and beat to human output and a `position` object in JSON. Beats start at 1 and count quarter notes, matching `at` and the shared time
contract. This also applies in meters such as 6/8 (three quarter-note beats per
bar). Fractional beats remain exact rational values. `--setup` adds device bindings,
articulation and sampled MIDI parameters/messages. `--json` exposes the same
information as structured fields. Recursive explanations of every inherited
choice and default are not supported.

## 5. `diff`: a musical diff

```sh
mm diff before.mm after.mm
mm diff song.mm --since accepted
mm diff song.mm --since HEAD~1
```

Diff compares realized events in order within each named part. It distinguishes
changed/added/removed events from events whose musical content is unchanged but
whose onset moved, and records whether the part's control streams changed.
Human output summarizes counts per part; JSON contains event details and the
before/after total extent. This is an ordered comparison, so inserting an event
can produce several subsequent changes; it does not align passages by musical
similarity.

`--since accepted` reads the frozen accepted source. Git-revision comparisons
load the main score and its dependencies from that revision. The `file@revision`
notation is not a CLI input syntax; use `--since`.

## 6. Help

`mm help` lists supported topics. A topic returns its matching reference section,
a dedicated command/feature guide, or the source of a prelude definition. Examples:

```sh
npm run mm -- help invert
npm run mm -- help conditions
npm run mm -- help T001
npm run mm -- help chord-tones
npm run mm -- help sound
npm run mm -- help sound choir
```

`--json` wraps the same text in the normal result envelope. An unknown topic is a
usage error. Some topics return a whole section or diagnostic catalog rather than
an entry dedicated to one word. Normative language snippets have regression tests;
not every help topic is a standalone executable score.

## 7. The feedback loop

```sh
npm run mm -- feedback song.mm "the bass gets muddy here" --at 1:40
npm run mm -- feedback song.mm --json
```

- The log (`<song>.feedback.json`) stores the text, the time, the resolved paths and parts,
  the frozen source content hash, dependency list and engine version. It is the per-song record of
  what the listener said about which exact version.
- Source snapshots are kept in `<song>.feedback/<content-hash>.mm`.
  Includes and external data values are inlined in each snapshot.
  Run `mm feedback <song>` without text to read the ledger; older score versions are
  marked. A note without `--at` applies to the whole song. The sounding list uses
  written note gates, not reconstructed release/effect tails.
- `mm at` answers the same question without logging it.
- After a revision, use `mm diff song.mm --since <rev>` to inspect the changed
  events and controls alongside the saved feedback. Feedback is not automatically resolved.

## 8. Backend inspection

Inspection commands use the compiler/backends and return structured data. Human
output formats those results and diagnostics for the terminal.

### MIDI controller adaptation (`D006`)

The renderer fits interior controller samples to the configured output budget. `D006` reports
the stream and total samples kept/dropped. `rate:` is an upper bound, not an overload remedy.
Notes and required controller values retain priority; `D005` is an error only when required
traffic exceeds capacity. `explain --setup` includes normalized and encoded parameter values
at the selected bar's start and end, wire messages and adaptation records.

`metrics` omits silent parts per section; `metrics --all` includes them.

### Composer feedback

`check song.mm --setup studio.setup` reports slides/unwritten slides per mono part and all
shared channels. `metrics song.mm` reports musical duration; with `--setup`, it adds average
and peak output load/headroom per section. Peak uses rolling 100 ms and 1 s windows of the
planned MIDI traffic plus configured clock, excluding startup. This is a calculated budget.
JSON metrics returns `{durationSeconds, duration, sections, ports}`.

`help alias pluck --setup studio.setup` lists resolved device capabilities without MIDI I/O.
`help acid` explains mono articulation and points to instrument mappings.

Mono note stacks produce D002 with stack size/channel and a score source location. Slide
counts reflect emitted handovers. Note-map drum sharing is summarized as one drum kit; JSON
retains the participating parts plus `kind`, `instrument`, and `laneCount`. Pitched or mixed
channel sharing remains explicit.

`mm help names` lists reserved grammar words, prelude functions and naming namespaces.

Software extensions: `mm help primitives`, `mm help spatial`, `mm help literal`.
`mm render song.mm --stems-by group` writes float stems by part/note group and
adds group levels to the report. See [the renderer primitives guide](../../packages/render/PRIMITIVES.md).

## Includes and provenance

`mm expand song.mm > expanded.mm` prints plain mmdsl after recursive file includes,
including any software settings. Relative data paths are made absolute so the
output can be saved anywhere. Templates and data expressions remain ordinary
mmdsl for the later compiler stages. Form inspection remains available through
`mm expand song.mm --to section`. The structure view returns sections and
bars; other `--to` values are rejected. Source
expansion alone does not run compiler checks; use `mm check` to validate the output.

`mm check song.mm --json` lists `result.dependencies` and `result.scoreHash`.
Render reports list the same dependency provenance, and the performance sidecar
uses the same score hash. Each dependency records its absolute path, SHA-256 and
kind (`score`, `include` or `data`). Repeated dependencies appear once. The hash
covers the ordered hashes and paths relative to the main score; moving an entire
score tree preserves its hash. A score with no includes or data files keeps the
SHA-256 of its original bytes.

MP3 conversion checks current dependencies against render provenance when a
render report is available. Source changes require a new render before conversion.

Acceptance saves `<song>.accepted/source.mm` and `metadata.json`: the source has
both includes and external lanes expanded, and metadata records the original
dependency list and provenance hash. Listening-feedback snapshots also freeze
external lanes and record dependencies. Later edits to those files cannot alter
the stored version. `diff --since <git revision>` reads includes and data from
that same revision.
