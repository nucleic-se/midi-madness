# Software audio renderer

Render a composition draft directly from the compiler's musical events, without
a MIDI device. `packages/render` handles score extensions, scheduling, files and
analysis; `packages/synth` owns the instruments and DSP.

## Render and inspect

```sh
npm run mm -- render examples/first_song.mm
npm run mm -- render examples/automation.mm --from "bar 1" --bars 4
npm run mm -- render song.mm --solo lead,keys --mute kick
npm run mm -- render song.mm --analysis
npm run mm -- render tests/fixtures/render/modulation-effects.mm
npm run mm -- check examples/automation.mm --setup setups/band/band.setup
```

The default destination is `renders/<score filename>/mix.wav`, with `report.json`
and `report.txt`, plus `mix.events.json`. Default WAVs are stereo 48 kHz, 24-bit PCM; `space binaural` retains that format,
while `space ambisonic 1` writes four-channel 32-bit float ACN/SN3D. Reports include duration,
peaks, note/slide/accent counts, silent members, ignored controls, effect routing,
bus levels/tails and safety-clamp activity. JSON reports also list `dependencies`
(the score, `.mmi` includes and external data files) and their combined `scoreHash`.
The performance sidecar uses the same score hash. Dependency-free scores retain
the SHA-256 of their original bytes. See [includes and provenance](../../docs/reference/TOOLING.md#includes-and-provenance).

### Performance sidecar

Every mixed WAV render also writes `<wav-stem>.events.json`, including renders
with reports disabled. This versioned `midi-madness-performance` document saves
the actual scheduled inputs passed to audio synthesis: synth note-on/off/control
events, generated attacks, drum hits/controls, note locks/paths, effect-bus
controls, and backend settings/defaults. It also retains score structure and
provenance. Internal grouped-stem passes do not write separate event sidecars.

Use the mixed WAV or its timing-preserving MP3 conversion with this event stream
to experiment with graphics synthesis; individual stems are unnecessary. Event
sample coordinates and ordering are preserved verbatim. Convert to playback time
with `(event.sample - audio.originSample) / audio.sampleRate`. For excerpts,
earlier events/controls are retained to establish held-note and parameter state.
`audio.frames` describes the exact mixed WAV length, including its retained tail;
`scoreOffsetSample` locates score time zero on the backend timeline.

Controls are raw parameter values, with null meaning reset to the backend
default. Graphics effects can bind the same values to different parameters and
response curves. The scheduled inputs and recorded control envelopes do not
contain oscillator samples, post-DSP audible levels or effect-return waveforms.
Release lifetime is available in the envelope records described below. The payload contract is exported from
`src/performance.ts`; score rationals serialize as exact fraction strings.

World-space scores add a `world` object with the listener's position and
orientation lanes. Each track also records its spatial frame: world-frame tracks
carry `x/y/z` position lanes, and listener-frame tracks are head-locked. Each
track records `resolved` envelope inputs: the resolved synth preset and voice
count, or the drum lane model. Audio evaluates these same lanes per sample. See
[World space and the listener](SPATIAL.md#world-space-and-the-listener) for the
axes, lane semantics and compatibility rules.

Each track also carries `envelopes`: the amplitude and filter-envelope values each
note (or drum hit) actually had, recorded during synthesis. They include
retriggers, releases, legato hand-offs and voice stealing, so graphics can seek to
any time and see the envelope the audio used. Recording only observes; it does
not change the audio.

Use `--events-envelopes none` to omit recorded envelopes and avoid collecting or
simplifying them during synthesis. Notes, hits, controls, resolved presets and
timing remain available; consumers cannot recover the exact voice lifetimes or
envelopes from those inputs alone. The default is `full`.
`--events-parts lead,kick` exports only those rendered parts in `tracks` and
`score.parts`, and only collects their envelopes. It does not solo the audio or
change stems, analysis, or the shared bus/listener context. Names must identify
rendered parts, including any `--solo`/`--mute` selection. Explicit export settings
are recorded in the optional `capture` object of the version-1 sidecar; the
default export retains its existing structure.

Dense `per`/data lanes and arithmetic over them use prepared sample-coordinate
lookups. Exact fractions still define the timeline, region ownership and lane
boundaries. Numeric interpolation preserves the exact evaluator's output;
unsupported expressions or coordinates beyond safe integer arithmetic fall back
to exact evaluation. This optimization also applies to effect, world-position
and listener lanes. It does not skip earlier audio when rendering an excerpt.

| Option | Behavior |
|---|---|
| `--out PATH` | Choose the WAV path and report directory |
| `--from SECTION\|LABEL\|BAR\|TIME --bars N` | Render an excerpt with original song bar numbers |
| `--solo part,part` / `--mute part,part` | Select member names, including their sends |
| `--tail SECONDS` | Maximum release/effect tail; default 12, range 0–120 |
| `--events-envelopes full\|none` | Include recorded note/hit envelopes (default full), or skip their capture and export |
| `--events-parts part,part` | Select event-export parts without changing the audio mix |
| `--stems-by part` | Capture post-insert/post-gain stereo part stems in one synthesis pass, with peak/RMS and six-band spectral measurements; no ffmpeg required |
| `--stems-by group` | Write float stereo group contributions in `stems/`; supports stereo/binaural, rejects ambisonics |
| `--analysis` | Add float stems, spectrograms, bar/section RMS/peak measurements and an HTML listening page |
| `--no-analysis` | Disable analysis and report files; overrides `--analysis` |
| `--setup PATH` | Use a software setup; default `setups/band/band.setup` |

Opening rests remain in the file. Excerpts currently render from song start and
crop afterward, so held notes and effect state survive. ffmpeg is needed for
spectrogram images and MP3 conversion; WAV rendering and level measurements do
not require it. Use `npm run renders:mp3` to convert local `mix.wav` files.
When a render report is present, conversion checks current score dependencies
against the recorded hash and rejects stale renders; render again after editing
an include or external lane.

## Instruments and score controls

The default setup has eleven named synth bindings, role-based bindings and
sixteen synthesized drum lanes. Pitched parts match their name, then role, then
the `*` fallback (`init`); `sound NAME` selects a preset explicitly. Presets use numeric native units internally and explicit defaults;
score controls generally use normalized values, with documented native exceptions.
Section-keyed controls compile to song-clock value lanes; see [score workflows](WORKFLOW.md#controls-by-section).
Envelope times additionally accept ms/s and explicit note durations; insert/bus
stage reports expose measured gain changes. See [instrument parameters](INSTRUMENT_PARAMS.md)
and [gain staging and EQ](INSERTS.md#drive-compensation-eq-and-stage-measurements).
The [sound guide](SOUNDS.md) lists the available presets and pluck/choir controls.

- [Instrument parameters](INSTRUMENT_PARAMS.md): oscillators, voice filters, mono/poly
  and unison overrides, two LFOs, modulation envelopes, voice locks and drum controls.
- [Modulation](MODULATION.md): audio-rate LFOs, pitch/tempo synchronization,
  per-note pan, wide bends, ring modulation and tuned combs.
- [Buses](EFFECTS.md): named delay/reverb, routing, sends, throws and automation.
- [Inserts and tuning](INSERTS.md): ordered effects, filter/phaser/flanger controls,
  note-triggered bus ducking, buffer cuts, tuning systems and gain above preset levels.
- [Workflow](WORKFLOW.md): file includes, typed templates, literal loops, per-span sequences and
  listening-feedback snapshots.

All thirteen insert types also work as wet-only bus stages. Reverb is currently
bus-only. Normalized values retain their documented mappings; fixed native
literals and top-level per lists work for supported fields. Native units inside
arbitrary expressions are not supported. Out-of-domain effect warnings explain
what normalized endpoints mean.

## Articulation and draft limitations

Mono articulation follows written onsets/gates. Humanize changes performed note
onsets, but cannot create unwritten overlaps or erase written slides. Same-pitch
legato preserves its gate without counting as a pitch slide.

This is a fast draft renderer with provisional preset/mix levels and an
instantaneous stereo-linked per-sample peak clamp at 0.95. This safety ceiling
is not a compressor or mastering limiter. It does not mix or master a track.
Instruments, filters, reverb and drums are synthesized approximations rather
than exact vintage circuit/room emulations. Slow automation uses a 250 Hz grid;
fast periodic shapes use 3 kHz; LFO modulation runs at audio sample rate.

Note pan/tuning, LFO/modulation, filter envelopes, FM index, fold, sync/ratio,
pulse width and filter FM have independent voice locks. Other synth locks follow
the winning member-control value. Drum controls are captured per hit. See
[Instrument parameters](INSTRUMENT_PARAMS.md) for routes, ranges and lock units.
A new drum hit replaces its lane's previous hit, and closed hats choke open hats, including hits at the same tick.
Separate parts using one lane currently have separate instances. Voice stealing
reuses released voices before held ones; there is no dedicated steal crossfade.

Analysis measures RMS/peak dBFS. It does not measure LUFS, masking, pitch or
onsets. Insert reverb, audio-driven sidechain compression, mastering and full unit
arithmetic are not supported. Hardware calibration is not required for software rendering. Live MIDI and combined-file export use separate MIDI setups; per-part DAW export
follows the software performance. Software sound/effect configuration does not
translate to hardware automatically.

## Score defaults

A pitched part with no role defaults to `bed`, whose register is MIDI 48–72.
Out-of-range notes fold by octaves. Set a suitable `role` or explicit `range` for
high/low lines; render warnings include these pitch folds.

Level is gain relative to the selected sound, not a loudness target. Drum models
and synth presets have different output levels. With `velSens = 1`, amplitude
scales as `velocity^1.5`. Use `--analysis` to inspect peak and RMS levels by part,
bar and section. Spectral centroid is not measured.

Mono preset stacks share one voice and may become slides. The checker/renderer
warns; use `mono off` and `voices 8` for chords. Humanize preserves the written
mono articulation: it cannot introduce unwritten slides.

`tuning just chord` takes its root from declared harmony, not played stacks.
Static-root harmony warns. Write a progression or use explicit tuning/cents.
Unused implicit `echo`/`room` buses are omitted from reports; they remain available
for sends. Explicitly declared buses remain visible even when silent.

## Language and rendering primitives

See [curves, data, per-note paths, ratchets, grains and grouped stems](PRIMITIVES.md),
[spatial output](SPATIAL.md), and [literal profile 1](../../docs/reference/LITERAL_V1.md).
`mm help primitives`, `mm help spatial` and `mm help literal` show these guides.

## Single-pass part stems

`npm run mm -- render song.mm --stems-by part` writes 32-bit float stereo WAVs
under `parts/` and `report.json.partStems` measurements. Complete bus returns
are written under `bus-returns/` with the same measurements in
`report.json.busStems`. A return includes its full effect chain, return gain,
ducking and inputs routed from upstream buses, before master processing.
Only selected parts
are captured. Files share the mix origin, frame count and tail length. Stereo
and binaural output are supported; ambisonic stems are rejected.

The tap follows part inserts and part gain, before shared effect returns and
master processing. These are dry part contributions, not isolated full mixes;
they do not include shared reverberation/delay or a share of nonlinear master
processing, and are not guaranteed to sum to the final mix. Grouped stems keep
their existing separate-render contribution behavior: each group is rendered
in isolation, then a residual correction is allocated so stems sum to the mix.
This correction is not a physical attribution of nonlinear effects. No estimated
per-part wet shares are produced.

Each part report contains unweighted RMS and peak dBFS (silence floor -200 dBFS),
and six spectral bands: 0–80, 80–250, 250–1000, 1000–4000, 4000–12000 and
12000–24000 Hz. Band mean-square energy and relative fractions are estimated
from 50%-overlapping sine-windowed 2048-point FFTs averaged across stereo
channels; boundaries have finite frequency resolution. Squared window weights
sum to one, with padded ends, so transient energy survives block boundaries.
Band mean squares sum to the time-domain stereo mean square within rounding. RMS is not LUFS.
Overlap observations list bands where multiple parts each have at least 15%
of their spectral energy and overall RMS above -80 dBFS. They describe the
whole excerpt, not simultaneous masking or artistic quality.

Parts plus complete bus returns reconstruct the pre-master stereo mix within
float rounding; applying master processing separately to stems does not generally
reconstruct the processed mix. Bus-to-bus sends are already included in each
receiving return and should not be added a second time.

Capture adds one reusable stereo buffer and streamed float-file storage, not
one full render per part. Finalization reads each cropped file for measurements.
`--analysis` remains optional and adds the existing spectrogram/listening page;
`--no-analysis` suppresses reports but still writes requested stems.

## DAW interchange

`mm pack song.mm --out renders/song-pack` writes matching part MIDI and dry float
stems, complete bus returns, a draft mix, sound reference and section/import notes.
`mm export song.mm --midi-dir renders/song-midi` prepares the same software note
performance without synthesis. See [DAW export](../../docs/guides/EXPORTING_TO_A_DAW.md)
for timing tolerance, preroll, pitch bend, CC mappings and audio-only limitations.
