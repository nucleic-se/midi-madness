# Rendering audio

The software renderer plays a score through built-in synth and drum models and writes a WAV. It does not need a MIDI device. Run commands from the repository root after `npm ci`.

## Check and render

```sh
npm run mm -- check examples/first_song.mm --setup setups/band/band.setup
npm run mm -- render examples/first_song.mm
```

`render` uses `setups/band/band.setup` by default. Supplying that setup to `check` validates software sounds, inserts and bus routing as well as the musical score.

The default output directory is based on the score filename:

```text
renders/first_song/
  mix.wav
  mix.events.json
  report.json
  report.txt
```

Default audio is stereo, 48 kHz, 24-bit PCM. Reports include duration, peak level, member activity, ignored controls and effect-bus information. The event file contains scheduled performance inputs and recorded envelopes; it is not a recording of post-effect audio levels.

## Choose an excerpt or destination

```sh
npm run mm -- render examples/first_song.mm --from "bar 5" --bars 2 --out renders/excerpt/mix.wav
npm run mm -- render examples/first_song.mm --solo lead --out renders/lead/mix.wav
```

`--solo` and `--mute` accept comma-separated part names. They also affect those parts' effect sends. `--tail N` sets the maximum appended tail in seconds, from 0 to 120; the default is 12. The renderer measures and trims quiet tails within that limit.

By default, an excerpt is rendered from the song's start and then cropped,
retaining effect and held-note state. A late excerpt can therefore take longer
than its output duration suggests. Separate destinations keep comparison renders
from replacing one another.

For an approximate audition, add `--preview`:

```sh
npm run mm -- render song.mm --from "bar 65" --bars 4 --preview --warmup-bars 2 --events-envelopes none
```

Audio processing begins two score-meter bars before the excerpt, then the warm-up
is cropped away. `--warmup-bars` defaults to 2 and accepts nonnegative integers;
0 begins directly at the excerpt. Preview requires both `--from` and `--bars`.
It defaults to `renders/<song>/preview/mix.wav`, separate from the regular mix.

**The preview can sound different throughout the excerpt.** Notes and hits that
started before warm-up are absent, including held notes and release tails.
Earlier effects, spatial delays and DSP random/modulation state are not restored.
Increasing warm-up may help but cannot guarantee an exact match. The whole score
still compiles, so complex scores may retain substantial setup time. Reports and
events identify the result as approximate. Verify final levels, transitions and
tails using an ordinary render. See [preview details](../../packages/render/README.md#approximate-excerpt-previews).

## Add analysis or stems

```sh
npm run mm -- render examples/first_song.mm --analysis
```

Analysis adds a listening page, member stems, spectrograms and peak/RMS measurements by bar and section. Spectrograms require ffmpeg. RMS measurements are unweighted dBFS, not LUFS.

Use `--stems-by part` for dry part stems and complete bus-return stems from one
synthesis pass, with peak/RMS and six-band energy measurements in the report.
This does not require ffmpeg. Shared returns stay separate from parts; see
[part stems and measurement semantics](../../packages/render/README.md#single-pass-part-stems).

Use `--stems-by group` for contributions tagged by part/note groups; see [grouped stems](../../packages/render/PRIMITIVES.md#grouped-stems). Grouped stems support stereo and binaural output. `--no-analysis` disables reports and analysis; the mixed WAV's event sidecar is still written.

## Convert to MP3

With ffmpeg on your PATH:

```sh
npm run renders:mp3
```

This scans `renders/` for `mix.wav` files. See the [CLI reference](../reference/TOOLING.md#includes-and-provenance) for dependency provenance: changing a score, included fragment or data lane requires a matching new render before conversion when a render report is available.

## Adjust the sound

Set `sound` under a part to select a [preset](../../packages/render/SOUNDS.md). Use [instrument controls](../../packages/render/INSTRUMENT_PARAMS.md), [modulation](../../packages/render/MODULATION.md), [inserts](../../packages/render/INSERTS.md) and [effect buses](../../packages/render/EFFECTS.md) for sound shaping.

For binaural, ambisonic or moving-source output, see [Spatial audio](../../packages/render/SPATIAL.md).
