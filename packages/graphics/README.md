# Graphics

Version 0.5.1 adds a browser-free piano-roll frame renderer through `video.js`.
`createPianoRoll(events, options).frame(mediaSeconds)` returns RGB24 pixels from
the version-1 performance sidecar, with scheduled note gates and drum markers.
It does not own audio or an encoder. The CLI's `mm video` command combines these
frames and software-rendered audio into an MP4 using local FFmpeg. See the
[video guide](../../docs/guides/RENDERING_VIDEO.md) for usage and limitations.

Shared evaluation comes from `@midi-madness/foundation` (currently 0.2.0):
interpolation and `ControlLane` are imported from its `/curves` entry point,
and numeric bindings use its `/parameters` validation/resolution. Import those
utilities directly from foundation rather than from graphics' performance module.
Internal curves use `hold`; the performance sidecar adapter translates external
`step` values. Headless math has one implementation across music and graphics.
Bindings support explicit `sum` writers and optional destination descriptors;
the host remains responsible for validating authored ranges before playback.

Reusable data/time evaluation, visual mappings, a structure inspector and composable graphics effects. Applications supply their own performance data, media and scene configuration.

From the repository root:

```sh
npm run graphics:build
npm run graphics:check
```

The package compiles TypeScript from `src` to `dist`, including declarations. Build output is ignored by Git. Three.js `0.180.0` is its exact peer dependency. Colour management is on: hex colours are sRGB and are converted to linear light, and lights use physical units (candela). Consumers must install that dependency or supply compatible browser import maps. OrbitControls uses the dependency's `three/examples/jsm/controls/OrbitControls.js` path.

## Modules

- `engine.js`: headless collections, absolute-time frames, and numeric signals with shared interpolation and explicit pre-first policy. The caller chooses the time unit and data shape.
- `bindings.js`: map numeric sources into effect parameter packets; one source can drive multiple destinations. Missing/null values let an effect use its defaults.
- `mappings.js` and `types.js`: reusable coordinate mappings and inspector layer contracts.
- `renderers/graphics.js`: shared WebGL scene/camera lifecycle and effect composition. At most one effect may declare camera ownership, and one may declare environment ownership.
- `renderers/effects.js`: the `GraphicsEffect` contract: `load`, `render`, and `dispose`.
- `renderers/inspector.js`: full-structure viewing, layers, picking, and orbit controls.
- `renderers/composition.js`: place geometry effects within a composition.
- `renderers/tunnel.js`, `metaballs.js`, `ribbons.js`, `resonators.js`, and `plasma.js`: reusable numeric-parameter-driven effects. Effects do not identify songs or interpret musical tracks.

Use individual module imports for headless applications so they do not load graphics dependencies:

```ts
import { StructureEngine } from '@midi-madness/graphics/engine.js';
import { bindParameters, control } from '@midi-madness/graphics/bindings.js';

const engine = new StructureEngine(
  {
    values: [
      { at: 0, value: 0 },
      { at: 4, value: 1 },
    ],
  },
  {
    collections: {},
    signals: { level: { data: 'values', time: (p) => p.at, value: (p) => p.value } },
  },
);
const parameters = bindParameters(engine.frame(2), [
  {
    effect: 'heart',
    parameter: 'radius',
    source: control('level'),
    map: (value) => 0.5 + (value ?? 0),
  },
]);
```

The package root also exports the public APIs for applications that use graphics. Audio transport, source-format adapters, song-specific control mappings, and media loading belong to the consumer. Seeking is deterministic when effects and caller-provided source/mapping callbacks depend only on the absolute frame and their inputs. Browser/WebGL verification remains separate from TypeScript checks.

## Positioned performance playback

`performance.js` is a headless contract for source-format adapters and visual instruments. It adds world-space positioned voices, a moving listener, parameter paths, authoritative envelope inputs and historical sampling. Import this subpath directly in workers or Node; it does not import Three.js.

```ts
import { PerformanceEngine, performanceClock } from '@midi-madness/graphics/performance.js';

const clock = performanceClock(events.audio);
// An adapter supplies resolved voices/controls using clock.seconds(event.sample).
const engine = new PerformanceEngine({
  voices: [{
    id: 'seq/stone-0/attack-0', track: 'seq',
    start: 0, gateEnd: 1, end: 2,
    pitch: 42, velocity: 0.8,
    parameters: { x: 0, y: 2, z: -10 },
  }],
  listener: {
    x: [{ time: 0, value: 0, curve: 'linear' }, { time: 4, value: 5 }],
  },
});
const frame = engine.frame(audio.currentTime);
const history = engine.sample(audio.currentTime - 0.25, audio.currentTime, 1000);
```

### Adapter contract

- All times are **media seconds**, including control points, voice start/gateEnd/end, envelope timelines and listener lanes. Negative times preserve pre-excerpt state. Voice path `start` is the exception: it is an offset from that voice's start; duration is seconds. `performanceClock` converts exact backend sample coordinates using the audio origin, without rounding.
- Coordinates are right-handed: **+X right, +Y up, forward -Z**, metres. Positive yaw turns right; positive pitch looks up. World positions remain fixed when the listener moves. Audio integration must convert to these axes explicitly; the audio ambisonic channel convention is a separate concern.
- Each voice ID identifies one resolved voice lifetime, not just a MIDI key or instrument. The adapter owns voice allocation, mono/legato/retrigger rules, note-off pairing, choke rules and release-tail end times. Intervals are half-open `[start,end)`; held is true only before gateEnd.
- Parameter precedence is track defaults → track automation → per-voice parameters → per-voice paths. Missing automation uses the default; null restores it. Controls default to step interpolation. Curves belong to the outgoing segment. Resolve simultaneous control events in backend order before constructing a lane.
- Voice pitch and `parameters.pitch` use MIDI semitones, including fractional tuning. Convert native pitch paths in cents to absolute MIDI semitones in the adapter. The engine does not reinterpret raw score syntax or synth knob units.
- Envelope callbacks return **source-time** amplitude and filter-envelope state from the synth integration. They must be pure functions of absolute time and resolved voice history. `envelopeTimeline` consumes exported/replayed envelope values; the producer declares interpolation. Missing envelopes remain `null`, so consumers can distinguish unavailable state from silence. This is not an audible-level meter and does not reconstruct oscillators, filters, modulation, bus returns or synth envelope state from preset names.
- `frame(t)` returns world positions, listener-local positions, direction, distance, gate state and envelope values. Visible source geometry uses source time. `propagationSeconds` is a direct-path timing aid; it does not claim to reproduce the moving audio delay tap or effects returns.
- `sample(from,to,rate)` includes both endpoints and has an allocation limit. Choose enough samples for the fastest paths you render. It supplies historical frames for trails/exposure integration, not a blur effect or anti-aliasing guarantee. Backward seeking requires no reset. Envelope callbacks must preserve this property.

### Positioned-performance instruments

These effects read an adapted performance (`adaptPerformance`) and the frame time
in media seconds. They hold no musical meaning: track selection and mappings are
the caller's.

- `ListenerCameraEffect` owns the camera. It places the camera at the listener's
  position, with rotation order YXZ, y = −yaw and x = pitch. The camera's view
  space equals `relativePosition`.
- `MonolithEffect` draws a column under each positioned voice.
  - The column's top is the source position.
  - Columns hold where their last voice left them.
  - Seams glow with the amplitude envelope and run hotter with the filter envelope.
  - Without envelopes it falls back to a gate approximation and reports it in
    `envelopeSource`.
  - State at any time is derived from data, so seeking backwards is exact.
- `SweepBloomEffect` draws one shell per drum track.
  - The shell radius follows the hit's pitch sweep in octaves (lane model plus
    hit locks).
  - Each hit resets the shell, as the lane resets its voice.
  - Brightness uses an exported hit envelope when supplied, otherwise the drum
    lane model (`envelopeSource`).

- `PerformanceStage`: a drop-in alternative to `GraphicsRenderer`.
  - HDR (half-float) scene, bloom, ACES filmic tone mapping, vignette, and grain
    seeded by media time.
  - Effects that use custom shaders take part in scene fog.
- `HarmonicSkyEffect` owns the environment.
  - The level-weighted pitch classes of the selected tracks, placed on the circle
    of fifths, set the sky and fog hue; their energy sets the brightness.
  - Silence returns to the reference hue.
- `TrailEffect` draws a light streak along a track's position lanes over a time
  window. A source that stops moving retracts its trail.
- `TetherEffect` draws filaments from an origin to a moving track. The shape changes
  only on that track's attacks; curl follows a control lane.
- `VoicePointsEffect` draws glowing points at sounding voices, sized by level.

Cinematic set and neon instruments:

- **`PerformanceStage`:** a film pipeline.
  - **Passes:** HDR scene, bloom, a scene-linear musical grade, ACES output, display-space
    vignette and grain, then SMAA.
  - **Grade:** an optional `look(time)` callback supplies the two-tone tint, exposure lift
    and RGB split from the performance.
  - **Lighting:** a neon studio environment map for physically based reflections, and
    soft shadows.
- **`MonolithEffect` with `style: 'meter'`:** black obsidian pillars
  (`MeshPhysicalMaterial`, clearcoat) lit by scene lights.
  - A segmented LED strip on each face fills with the voice's amplitude and is
    coloured by pitch.
  - Neon runs along the vertical edges.
- **`environment.js`:** static set pieces and floor.
  - `WetGroundEffect`: a lit floor under an additive HDR mirror, with ripples.
  - `BackdropEffect`: skyline silhouettes, stars and a planet.
  - `GroundMistEffect`: mist that drifts with a wind track's position.
  - `PlinthEffect`: stepped, with edges lit by a track's level.
- **`neon.js`:**
  - `VoiceLightsEffect`: real point lights at sounding voices, from a fixed pool.
  - `HaloRingsEffect`: a source's orbit drawn as a ring, with a comet at the source.
  - `BeamEffect`: vertical light to or from voices.
  - `SparkBurstEffect`: per-attack particles that are pure functions of attack and
    age.
- **`SweepBloomEffect`:** can add shock rings at the sweep radius and a point light
  that flashes with each hit.

Envelope sources are reported as `exported`, `gate-approximation`, `lane-model` or
`idle` (nothing sounding).

Exported envelopes (`tracks[].envelopes`, see the render package's SPATIAL.md)
can be attached through `adaptPerformance`'s `resolveVoice` hook: extend
`voice.end` to the record's `end` and set
`envelopes: envelopeTimeline(amplitude, filter)`.

The listener/world-source export and resolved envelope production belong to the audio integration. This module deliberately does not guess new export field names or import the synth's filesystem-dependent preset registry. Effect implementations declare their parameter catalogue; an application can supply this performance engine alongside its structure frame data.

### Renderer export adapter

```ts
import { adaptPerformance } from '@midi-madness/graphics/performance-adapter.js';

const playback = adaptPerformance(await response.json());
const frame = playback.engine.frame(audio.currentTime);
const attacks = playback.attacksBetween(previousTime, audio.currentTime);
```

The version-1 adapter converts backend samples to media seconds, world/listener lanes, world-position locks and paths, and step controls including resets. Native pitch paths interpolate in cents **before** converting to MIDI semitones, preserving exponential/logarithmic curves. Old polar sources remain listener-relative even when the listener moves. Each scheduled attack preserves its original event and the track's resolved model as `source` and `model`; no synth runtime or preset files are imported.

The default `engine` contains scheduled **note gates**, not reconstructed DSP voices. Its envelopes remain null and it does not invent release duration or voice-allocation rules. Percussion is available in `attacks` and the half-open `attacksBetween(from,to)` window; backward seeks should query the desired historical window, not the reversed previous/current interval. No trigger fires merely because a frame was queried twice.

Use `adaptPerformance(document, { resolveVoice(voice, attack, track) { ... } })` to supply resolved voice lifetime and authoritative envelopes, or return null to omit a scheduled voice. The callback receives the complete original track, including controls and resolved preset/drum model. It is called for notes and drum hits. A drum candidate has zero gate/lifetime by default; the resolver must provide its meaningful lifetime and pitch before including it as a voice. Full mono/legato/stealing/choke reconstruction remains an audio-side responsibility; a per-attack callback alone does not implement those rules. Audio integrations can instead build `PerformanceDefinition` directly from resolved voice histories.

Run adapter regressions with `npm --prefix packages/graphics test`. Engine regressions are in `tests/graphics-performance.test.ts` and run with the repository's normal tests.

## Embedded monument

`MonumentEffect` owns a stable `THREE.Group` containing a resonator foundation,
ring-ribbon crown and plasma heart. Its default configuration borrows the host
camera and lighting. `ownsCamera` and `lighting` are explicit standalone opt-ins;
lights affect the entire scene. The effect owns no renderer, audio element or
animation loop. The host calls `load`, `render` and `dispose`.

```ts
import { MonumentEffect } from '@midi-madness/graphics/renderers/monument.js';
const monument = new MonumentEffect('monument', {
  channels: [{ id: 'lead', color: '#63e7de' }],
  clock: { secondsPerUnit: 1, secondsPerBar: 2 },
  placement: { position: [0, 0, -5], rotation: [0, 0.2, 0], scale: [0.5, 0.5, 0.5] },
});
monument.load(engine, { scene, camera });
monument.render(engine.frame(mediaSeconds), { 'heart.pulse': 0.8, 'heart.hitAge': 0.1 });
// On scene removal:
monument.dispose();
```

The caller declares seconds per frame-time unit and seconds per bar. Animation
phase is `time * secondsPerUnit / secondsPerBar`, independently of trigger ages
in seconds. A caller may supply `frame.animationTime` explicitly for a musical
phase map. Placement uses parent-space XYZ position, Euler XYZ rotation in
radians, and nonzero XYZ scale. Embedded evaluation leaves the borrowed camera
unchanged. Reload first disposes the previous instance; failed loads clean up
partial geometry. Disposal deduplicates owned geometry/materials, releases owned
textures, and preserves host objects.

All effects declare `parameters` (empty for effects without numeric controls).
Descriptors include units, defaults and bounds. Monument addresses use
`foundation.*`, `crown.*` and `heart.*`, for example `crown.lead.energy`.
`bindingDestinations(effects)` supplies descriptors for `bindParameters`;
renderers validate routed packets and reject unknown destinations. The numeric
monument parts reject unknown and out-of-range direct parameters too. There is
no ignored `crown.pulse` control. Defaults restore each frame when values are
omitted. Consumers should choose supported profile mappings explicitly.

`monumentBindings` from `sources/monument.js` is headless. Its typed selectors
adapt a caller's note format; channels, all tracks, percussion tracks and clock
units are explicit. It supplies active-note energy, normalized pitch, bipolar
pan and percussion-onset envelopes, including after the note gate ends.
Simultaneous percussion hits resolve in source order, latest wins. Missing hits
produce zero pulse and an idle age of eight seconds. This is a visual activity
model, not a reconstruction of audible DSP levels. Format parsing, track-name
heuristics, song profiles and media loading stay in applications.

Three is a peer so a host and all effects share one runtime instance. Types are
generated against real `@types/three@0.180.0`; no ambient `any` Three declarations
are shipped. TypeScript hosts also need those Three declarations. Public exports
are enumerated; internal cleanup helpers are not package entry points.

Ribbons, rings and plasma test world depth; their transparent/additive materials
do not write depth. The plasma shaders include Three's tone-mapping/output
chunks, so offscreen linear HDR rendering can feed the host's final output pass.
The host owns tone mapping and output conversion. These material choices still
require visible review in the final host and through a camera orbit; type checks
and CPU tests alone do not establish visual correctness.

Run `npm run graphics:demo` at the repository root to open the synthetic performance fixture. It serves only examples, built shared
modules and Three build/addon modules on loopback. Use media time, camera orbit,
exposure and resource reload controls to check occlusion and color. The fixture
provides a diagnostic stage for inspecting the effect.

The fixture's **Capture PNG** control retains and exposes an actual WebGL frame.
Reproducible captures also accept `?time=0.1&orbit=25&exposure=1&capture` (seconds,
orbit degrees, exposure). Drawing-buffer preservation is confined to this
diagnostic fixture. It is not enabled for application rendering.

Export the reviewed package for a consumer after committing source:

```sh
node scripts/pack-shared.mjs graphics /absolute/path/to/consumer/vendor
```

`monumentParameters(channelIds)` from `parameters.js` exposes the same catalogue
to headless project validation without importing Three or constructing effects.
