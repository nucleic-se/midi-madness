# Inspecting and revising scores

Use the CLI to check notation and inspect the events a score produces. These examples use the included first-song score; run commands from the repository root.

## Check errors and warnings

```sh
npm run mm -- check examples/first_song.mm --setup setups/band/band.setup
npm run mm -- check examples/first_song.mm --setup setups/band/band.setup --json
```

Diagnostics include a code, severity and source location. Some include suggested edits or measured values. Errors cause exit status 1; usage and I/O failures use 2. Warnings do not make a command fail. See the [diagnostic catalog](../reference/TOOLING.md#33-diagnostic-catalog).

## Look at the realized music

```sh
npm run mm -- roll examples/first_song.mm --part lead --bars 1..4 --harmony
npm run mm -- explain examples/first_song.mm --bar 5 --part lead --positions
npm run mm -- at examples/first_song.mm "bar 5"
npm run mm -- metrics examples/first_song.mm
```

`roll` shows pitches or a drum grid. `explain` inspects harmony, events and controls at a bar. `at` locates a bar or timestamp in the form, and `metrics` summarizes sections and event density. `--harmony` adds declared chord/key changes, including changes within a bar;
JSON adds `result.harmony` with per-bar `changes` containing exact `time`, `beat`,
`key` and `chord` values. A null chord means no harmony statement is installed
there (the engine still supplies its default tonic for chord-based parts).
`--positions` adds event onset bars/beats to `explain`. Beat numbers start at 1 and count quarter notes in every meter; 6/8 contains
three quarter-note beats per bar. With a MIDI setup, inspection can also show resolved device bindings and output load.

`expand` prints source with file includes expanded and data paths resolved:

```sh
npm run mm -- expand examples/first_song.mm
```

Expansion is a source-inspection step; use `check` to validate its result.

## Compare versions

For your own `song.mm`, save an accepted baseline:

```sh
npm run mm -- accept song.mm
```

After editing, compare against it:

```sh
npm run mm -- diff song.mm --since accepted
```

Acceptance writes `song.mm.accepted/` with expanded source, frozen external data and metadata. `diff` compares realized events and control streams; it is an ordered comparison, not an alignment by musical similarity. You can also compare two score files or use `--since` with a Git revision.

## Keep listening feedback

```sh
npm run mm -- feedback song.mm "the lead is too quiet" --at "bar 5"
npm run mm -- feedback song.mm
```

Feedback records the note against the current source hash and a self-contained score snapshot. Existing notes remain associated with their original version and location. The tool does not automatically resolve feedback after an edit.

See [CLI reference](../reference/TOOLING.md) for command flags, JSON fields and the files each command writes.
