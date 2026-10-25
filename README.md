# midi-madness

Write music as text. Check and inspect a score, render audio and musical event data,
make a video with matching audio, export a MIDI file or play it through a MIDI setup.

A score describes notes, rhythms, harmony, sections, parts and automation. Software sounds and MIDI device mappings provide two ways to hear the same musical material.

```text
mm 1
song "Hello"
  tempo 120
  key C major
  humanize off
  dynamics flat

motif melody = | C4 E4 G4 E4 |
section A = rest(4 bars)
form = A

part lead
  sound warm-lead
  plays notes melody
```

## Install and try it

You need **Node.js 22.6 or newer** and npm. Clone this repository, then run:

```sh
git clone https://github.com/nucleic-se/midi-madness.git
cd midi-madness
npm ci
npm run mm -- check examples/first_song.mm --setup setups/band/band.setup
npm run mm -- render examples/first_song.mm
```

Open `renders/first_song/mix.wav` to listen. The same directory contains a performance event file and text/JSON render reports. Audio rendering needs no MIDI hardware.

On Linux, installing the native MIDI dependency may require build tools and ALSA headers: `sudo apt-get install build-essential libasound2-dev`. Install ffmpeg if you want MP3 conversion or spectrograms.

## What you can do

| Task | Command |
|---|---|
| Check a software score | `npm run mm -- check song.mm --setup setups/band/band.setup` |
| Render a WAV | `npm run mm -- render song.mm` |
| Render an MP4 with audio | `npm run mm -- video song.mm --out renders/song.mp4` ([video guide](docs/guides/RENDERING_VIDEO.md); requires FFmpeg) |
| Render an excerpt | `npm run mm -- render song.mm --from "bar 1" --bars 4` |
| Audition an approximate excerpt | `npm run mm -- render song.mm --from "bar 65" --bars 4 --preview --warmup-bars 2` ([limitations](packages/render/README.md#approximate-excerpt-previews)) |
| Inspect a part | `npm run mm -- roll song.mm --part lead --bars 1..4` |
| Inspect a bar | `npm run mm -- explain song.mm --bar 1` |
| Export a DAW pack | `npm run mm -- pack song.mm --out renders/song-pack` |
| Export MIDI per part | `npm run mm -- export song.mm --midi-dir renders/song-midi` |
| Export MIDI | `npm run mm -- export song.mm --midi song.mid` |
| List MIDI outputs | `npm run mm -- ports` |
| Play a configured MIDI setup | `npm run mm -- play song.mm --setup studio.setup` |

Save the score above as `song.mm` to try the audio and inspection commands. `export --midi` without a setup writes notes with automatic channels and General MIDI drum mappings. `export --midi-dir` follows the software performance and writes one file per part. Live playback requires a setup for your devices; software presets and effects do not configure a hardware synthesizer.

The language includes reusable motifs and functions, exact musical time, harmony, conditions, curves, templates and file includes. The software renderer adds synths and drums, inserts and effect buses, note paths, microtuning, spatial audio and optional stems and analysis. See [supported features and limitations](docs/SUPPORTED_FEATURES.md).

## Examples

Start with [First song](examples/first_song.mm) or [Filter automation](examples/automation.mm). Full arrangements demonstrate larger scores: [Carbonized](examples/carbonized.mm), [Flourish](examples/flourish.mm), [Hollow Bloom](examples/hollow-bloom.mm), [Copper Meadow](examples/copper-meadow.mm), [Cobalt Trench](examples/cobalt-trench.mm) and [Starling Dusk](examples/starling-dusk.mm).

The [example guide](examples/README.md) has commands for checking and rendering them. Full arrangements take longer to compile and render than the teaching scores.

## Documentation

- [Write your first song](docs/guides/WRITING_A_SONG.md)
- [Render audio](docs/guides/RENDERING_AUDIO.md)
- [Export stems and MIDI to a DAW](docs/guides/EXPORTING_TO_A_DAW.md)
- [Export and play MIDI](docs/guides/USING_MIDI.md)
- [Inspect and revise a score](docs/guides/INSPECTING_SCORES.md)
- [Language, CLI and instrument references](docs/reference/README.md)
- [CLI and library integration](docs/INTEGRATION.md)

The [documentation index](docs/README.md) links to sound controls, effects, spatial audio and library APIs. For development, see [Contributing](CONTRIBUTING.md) and [Architecture](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE).
