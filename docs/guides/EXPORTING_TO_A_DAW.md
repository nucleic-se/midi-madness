# Exporting to a DAW

Use a remix pack to take a software-rendered score into Ableton Live or another
DAW for editing and finishing:

```sh
npm run mm -- pack examples/first_song.mm --out renders/first-song-pack
```

The output directory must be new or empty. A pack contains:

| File or directory | Contents |
|---|---|
| `mix.wav` | 24-bit stereo draft reference |
| `stems/parts/` | One 32-bit float WAV per part, after its inserts and gain |
| `stems/bus-returns/` | Complete shared-effect returns as 32-bit float WAVs |
| `midi/` | One single-track `.mid` per part, with matching stem filenames |
| `midi/report.json` | Timing precision, note counts and MIDI representation losses |
| `README.md` | Import instructions, tempo, key and section bars/times |
| `pack.json` | Verified alignment, stem measurements and render metadata |
| `sound-sheet.json` | Resolved synth/drum settings, inserts and buses for reference |
| `mix.events.json` | Versioned software-performance sidecar |

`--tail 12` sets the maximum tail budget in seconds, as with rendering; the final
crop follows the rendered signal and pending effects. The default is 12 seconds.
`--setup` selects an optional **software** setup. No MIDI instrument bindings,
ports, connected devices or ffmpeg are required. Stereo and binaural scores can
produce packs; ambisonic stems are unsupported.

## Import and alignment

Place all files at the same Arrangement position and disable audio warping when
preserving the original performance. Retain leading and trailing silence. Every
WAV has the same frame count and sample rate. All MIDI files carry the same tempo,
meter metadata and end tick. MIDI ticks and integer-microsecond tempo metadata
introduce a small measured difference from the audio timeline; the report gives
the actual duration difference and a validated tolerance.

Humanization can place a note before score bar one. The renderer preserves those
notes with a short preroll; the same offset is kept in the MIDI. The pack README
and `audio.scoreOffsetSample` identify where score bar one falls in the files.
Align that point when placing the music on a DAW's bar grid. File time zero and
score bar one are not always the same point.

In Live, import the first MIDI file into Arrangement and accept its tempo
information. Keep that Set tempo for the remaining imports. Live's import behavior
and clip boundaries can depend on the import method: verify the common end against
`pack.json`, especially trailing empty MIDI clip space. MIDI markers are included;
the README's section list is the portable section map. See Ableton's
[tempo-map import instructions](https://help.ableton.com/hc/en-us/articles/360003387979-Importing-a-tempo-map).

Sum the part stems and complete bus returns to reconstruct the **pre-master**
stereo mix, within float rounding. This includes bus-to-bus routing and ducking.
Do not add the reference mix to that sum. The reference mix uses the renderer's
existing instantaneous safety clamp, so a hot mix can differ from the stem sum.
The clamp is not a true-peak limiter or a mastering chain. Float stems retain
headroom above 0 dBFS; lower their level in the DAW as needed.

Shared nonlinear effects cannot be divided into exact individual wet stems.
Complete bus returns preserve the rendered shared effects without claiming that
each part has an independently attributable wet share.

## Editable MIDI and expression

Per-part MIDI uses the same software score preparation, native event expansion,
preroll and note/control schedulers as rendering. Ratchets and grains become
editable notes, and written mono legato remains overlapping after MIDI tick
quantization. Grain windows, voice stealing, oscillator/filter modulation, inserts
and shared-effect processing remain audio behavior. The loss report identifies
these differences; MIDI is not an audio reconstruction format.

Each pitched part uses MIDI channel 1 in its own file. Drums use channel 10 with
General MIDI note mappings. `boom`, `zap` and `noise` use explicitly reported
approximations. Load your own synth or Drum Rack and check its note mapping;
GM data does not configure the rack or select instruments automatically. See
[Ableton's MIDI-file guide](https://help.ableton.com/hc/en-us/articles/209068169-Understanding-MIDI-files).

Pitch/cents paths and fractional tuning become 14-bit pitch bend, sampled at
250 Hz. `--bend-range 24` sets the receiving bend range in semitones (integer
1–96, default 24). The file sends pitch-bend-sensitivity RPN messages; also set
that range manually if the destination does not honor them. Values outside the
range are clipped and reported. The report states bend and timing resolution.

Pitch bend is channel-wide. If overlapping notes need independent bends, this
export omits their conflicting per-note bends and reports the affected overlap;
it retains any shared part bend. MPE export is unsupported. Overlap alone cannot
recreate portamento: enable mono/legato and the intended glide on the receiving
synth. Repeated overlapping notes of the same MIDI pitch are reported because
note-off handling depends on the instrument.

## Optional CC automation

```sh
npm run mm -- pack examples/automation.mm --out renders/automation-pack --cc
```

`--cc` adds `midi/cc-map.json` and 7-bit controller lanes:

| Software parameter | CC | Source range |
|---|---:|---|
| cutoff | 74 | 0–1 |
| resonance | 71 | 0–1 |
| level | 11 | 0–1 |
| level.db | 7 | −60 to +12 dB |
| pan | 10 | −1 to +1 |
| reverb | 91 | 0–1 |
| delay | 93 | 0–1 |
| named sends | 20–31 | 0–1; up to 12 names, sorted |

Values are linearly mapped from the stated source range into 0–127. These are
normalized automation mappings; they do not recreate a filter, gain law, synth
patch or effect chain in another instrument. Map them manually in the destination.
Null values restoring a software default are omitted and reported rather than
replaced with an arbitrary CC value. Unmapped controls and voice-local locks/paths
are reported. Without `--cc`, no automation CC lanes are written; pitch-bend range
RPN messages still accompany pitch expression.

## Export MIDI without rendering audio

```sh
npm run mm -- export examples/first_song.mm --midi-dir renders/first-song-midi
```

This compiles the software performance without synthesis. Filenames are
`<score-file>-<part>.mid`, using percent encoding for filename safety. `--cc`,
`--bend-range` and an optional software `--setup` work as above. This route has no
fifteen-part limit because every part has its own file.

MIDI-only files end at the common score end, including preroll. Packs instead pad
all MIDI files to the actual audio crop, including the tail. Re-exporting into a
MIDI directory removes obsolete files listed by that directory's previous export
report; unrelated files are preserved. A new report is written only after the
export succeeds.

For a combined MIDI file or hardware-specific mappings, use
`mm export song.mm --midi song.mid [--setup studio.setup]`. That backend retains
its own instrument mappings, channel allocation and expression limitations; see
[Using MIDI](USING_MIDI.md).
