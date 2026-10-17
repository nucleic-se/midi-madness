# Writing a song

This lesson builds an eight-bar score with melody, chords, bass and drums. Run `npm ci` in the repository root first; the [README](../../README.md#install-and-try-it) covers installation.

## 1. Save a complete score

Save this as `song.mm`, or copy [first_song.mm](../../examples/first_song.mm):

```text
mm 1
song "First song"
  tempo 100
  key C major
  humanize off
  dynamics flat

motif melody = | C4 D4 E4 G4 | E4 _ D4 _ |
motif bassline = | C2 . G2 . | F2 . G2 . |
motif chords = | C3+E3+G3 _ _ _ | F3+A3+C4 _ _ _ |
rhythm pulse = | x . x . |
rhythm backbeat = | . x . x |

section verse = rest(4 bars)
section chorus = rest(4 bars)
form = verse chorus

part lead
  sound warm-lead
  range C4..C5
  plays notes melody
  when in chorus:
    plays notes melody.octave(+1)
    range C5..C6

part bass
  sound round-bass
  range C2..C3
  plays notes bassline

part keys
  sound fm-keys
  range C3..C5
  plays notes chords
  reverb = 0.2

part kick
  lane kick
  plays hits pulse

part snare
  lane snare
  plays hits backbeat
```

## 2. Read the notation

`mm 1` selects the language version. The `song` block supplies tempo and key. Here, `humanize off` retains written timing and `dynamics flat` avoids section-energy velocity scaling.

Each bar has four equally spaced slots. `C4` starts a note, `_` extends the preceding event, `.` is a rest, and `C3+E3+G3` starts a chord. Motifs and rhythms define reusable material; the parts repeat it across the form.

The two sections each reserve four bars. `form = verse chorus` orders them into an eight-bar timeline. A `when in chorus` override raises the melody by an octave while the other parts continue. Explicit `range` settings keep pitches in their intended registers.

Software parts select a `sound`; drum parts select a `lane`. Use a polyphonic preset such as `fm-keys` for chords. The [sound list](../../packages/render/SOUNDS.md) documents preset choices.

## 3. Check and listen

```sh
npm run mm -- check song.mm --setup setups/band/band.setup
npm run mm -- render song.mm
```

Listen to `renders/song/mix.wav`. The directory also contains `mix.events.json`, `report.json` and `report.txt`. The reports identify member activity and ignored controls.

Inspect or isolate the melody:

```sh
npm run mm -- roll song.mm --part lead --bars 1..4
npm run mm -- render song.mm --solo lead --out renders/song-lead/mix.wav
```

## 4. Add automation

Add this under `part lead`, alongside its existing section override:

```text
  cutoff = 0.5
  when in chorus:
    cutoff = across section: ramp 0.5..0.8
```

The fixed value sets the verse filter; the chorus ramps it over that section. Most ordinary controls are normalized to 0–1, but native extensions have field-specific units. Consult [instrument parameters](../../packages/render/INSTRUMENT_PARAMS.md) before changing a control's range.

## 5. Reuse a fragment

Create `parts/lead.mmi` containing these unindented lines:

```text
cutoff = 0.5
plays notes melody
```

Replace the lead's corresponding `plays` line with an include, keeping its other fields and chorus override:

```text
  include "parts/lead.mmi"
```

The include supplies indentation. Nested include and data paths resolve relative to their containing file. Fragments cannot contain an `mm 1` header or a `song` block.

```sh
npm run mm -- expand song.mm
npm run mm -- check song.mm --setup setups/band/band.setup
```

## Next steps

- [Render an excerpt, analysis or stems](RENDERING_AUDIO.md).
- [Inspect events and compare revisions](INSPECTING_SCORES.md).
- [Export or play MIDI](USING_MIDI.md).
- [Look up language syntax](../reference/LANGUAGE.md).
- [Try a complete demo arrangement](../../examples/README.md).
