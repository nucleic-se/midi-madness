# Templates, per-bar controls and listening notes

## Share definitions and generated material

File includes expand before templates, software settings and external data lanes.
Put shared buses, templates or generated material in `.mmi` fragments:

```text
include "shared/buses.mmi"

part acid
  restart never
  sound acid-303
  include "gen/acid.body.mmi"
```

The fragment's lines gain the indentation of the include line. Include paths and
`data "..."` paths resolve relative to the file containing them. Nested includes
are supported; cycles report the chain. Fragments cannot contain an `mm 1`
header or `song` block, and `.mmi` files are excluded from song discovery.

A fragment can hold a part body, lane definitions or shared settings. Keep the
`mm 1` header and `song` block in the main score.
Use `npm run --silent mm -- expand song.mm > expanded.mm` to inspect the inlined
source; `mm expand song.mm --to section` retains the form-inspection view.
Templates and data expressions remain in the printed source for later compilation.
Formatting the main score preserves its include directives.

## Expand typed part templates

```text
template pendulum(n: number, note: notes):
  sound ks-pluck
  plays notes | note{pan -0.75} . note{pan 0.75} . |.fast((8 + n) / 8)
  cutoff = 0.65 + n * 0.025

for n, note in [0 G3, 1 B3, 2 D4]:
  part pend-{n} = pendulum(n, note)
```

Templates contain ordinary part fields and `when` blocks. Invoke one with
`part name = template(arguments)`, with or without a loop. Definitions may appear
after their uses. Parameters support `number`, `percent`, `notes`, `hits` and `span`.
Scalar arguments use constant arithmetic; fractions remain exact in arithmetic
expressions. Numeric locks receive their scalar decimal value. Quotes and comments
are preserved, as are parameter names used as field labels.

`for` takes a literal list of rows, with one value per variable. Parenthesize a
multi-token value, e.g. `(G3 B3)` or `(1 + 2)`. Names interpolate `{variable}`;
the resulting name must be a valid identifier. Duplicate generated names report
`R004` at the loop's source location. Nested loops are supported, with limits of
16 levels, 1024 generated parts and 50000 expanded lines.

Expansion produces normal parts before realization. Event provenance records the
template, resolved arguments, definition line and invocation line. `check`,
`explain`, MIDI scheduling and software rendering use the same expanded music.
Software fields such as `sound` and inserts still require the software target.
Formatting preserves authored templates/loops.

## Step or glide through values

```text
bend = per 2 bars: 0, 0.0098, 0.0196, 0.0294
velocity = velocity * (per 1 bar: 1, 0.75, 0.5, 0.875)
vowel = per 2 bars smooth: 0, 0.25, 0.75, 1
plays hits beat.fast(per 1 bar: 1, 1.5, 2, 1)
```

`per S:` holds each constant scalar for S and loops from the use's reset.
`smooth` interpolates to the next value over S, including last-to-first at wrap.
Values may be constant arithmetic; live expressions within the value list are
not supported. Spans accept bars, beats or whole-note fractions, including dotted/triplet
fractions. They must be positive. Use parentheses when embedding a list in another
expression or a multi-argument call.

Inside a part's pattern operations, values are sampled at cycle starts. A step
boundary ends the current partial pattern and restarts it with the new value,
keeping changes on the written grid. Notes beyond that partial pattern are omitted;
explicit gate lengths retain their usual rules. Per rates in song form are rejected.
Named signals containing per sequences also work as rate arguments.

Software delay/reverb/insert automation supports native literals in a top-level
per list, e.g. `delay.time = per 4 bars: 1/16, 3/32, 1/8` or
`insert.filter.cutoff = per 2 bars: 800Hz, 3kHz`. Pluck decay lists accept `ms`/`s`.
Other values retain the field's existing normalized/native convention; full unit
arithmetic is not supported.

## External lanes and continuous automation

Use [JSON/CSV data lanes](PRIMITIVES.md#data-lanes) when another tool authors
control values. Keep the lane files with the score: paths resolve relative to
the containing score or fragment, and the render report records dependency hashes.
Include and lane edits change the score provenance hash. Data lanes loop and
interpolate like `per`; they do not import timed note events.

The top-level `listener` block and bus automation honour `restart` just like
part automation. Use `restart never` for one continuous song-long lane instead
of resetting it at every section. Listener fields and axes are documented in
[spatial audio](SPATIAL.md#world-space-and-the-listener).

## Keep listening feedback with its score version

```sh
npm run mm -- feedback examples/first_song.mm "the bass masks the melody" --at 0:04
npm run mm -- feedback examples/first_song.mm "keep this return" --at "bar 3"
npm run mm -- feedback examples/first_song.mm --json
```

Adding feedback writes `<song>.feedback.json` and stores a self-contained source
snapshot under `<song>.feedback/<content-hash>.mm`, with includes expanded and
external data lanes inlined. Entries record the dependency list and retain their original bar,
section/occurrence, sounding members, compiler version and content hash. Without
`--at`, a note applies to the whole song. With no text, the command only reads the
ledger and marks which entries refer to older versions. It never moves an old
note to a guessed position in a new arrangement.

Compare a saved feedback source with the current score
using `mm diff <snapshot> <current>`; resolving feedback entries or automatic
revision attribution is not supported. No user listening notes are generated by the
tool itself.

The listening fixture `tests/fixtures/render/workflow.mm` demonstrates generated
plucked voices, stepped timbre/pick position, a morphing choir, and changing rim
rates in eight bars. Render it with the usual `mm render` command.
