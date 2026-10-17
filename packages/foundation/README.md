# Performance foundation

Headless time, curves, envelopes and parameter evaluation for music and graphics applications.
No DOM, Three.js, file access, MIDI or synth dependencies.

Public entry points are `/time`, `/curves`, `/envelopes`, and `/parameters`
(also exported at root). `/time` provides generic `Rational` arithmetic, explicit whole-note/quarter-note-beat
conversion, decimal beat-timeline preparation, media/score-origin conversion,
and the injected-clock `createPlayback` with its `PlaybackTransport` interface.

`/curves` owns outgoing interpolation (`linear`, `hold`, `smoothstep`, `ease-in`,
`ease-out`, `exp`, `log`), indexed lanes, prepared immutable `ControlLane`, beat
curve sampling and explicit loop phase. `step` is an external spelling translated
to `hold` by an adapter. Lanes can use a source default or hold their first value
before the first point; a reset restores the source default and never becomes an
interpolation endpoint. Native exp/log interpolation happens before unit conversion.

`/envelopes` evaluates caller-owned triggers with explicit latest/sum, tie,
velocity and optional ceiling policies. Callers retain cue/gate history and provide
ages in a consistent coordinate. Duration is half-open; idle resumes at its end.
`sampleTriggeredEnvelope` is a beat-curve convenience for authored cue histories.

`/parameters` provides native-range mapping, descriptor/default validation,
explicit replacement/sum writer validation and frame-local contribution resolution.
Numeric zero, `RESET` and `UNAVAILABLE` are distinct. Reset removes a writer;
remaining sums still apply, and no remaining writer delegates to authored base.
Unavailable data requires an explicit base or native-unit numeric fallback, or
fails. Bounds validation accounts for optional writers disappearing independently.
No base value is implicitly added to a sum and no output is silently clamped.

Application source unions, scene/cue ownership and actual parameter catalogues
remain application/effect concerns. `ParameterDescriptor` supplies their common
shape; it does not invent defaults for an effect that has not declared them.

`Rational.fromNumber` preserves the number's decimal spelling, including exponent
notation; it does not reconstruct an intended fraction from a rounded number.
`beatTimeline` sums positive durations exactly during preparation and converts
each resulting boundary once. Runtime samples remain ordinary numbers.

Playback uses quarter-note beats and an injected millisecond clock. Stop resets
its origin and tempo history; repeated Play does not restart it. This transport
does not implement pause or arbitrary seeking. Historical `secondsAt` queries
use the tempo at that beat; future queries project the latest tempo.

`mediaClock` maps backend samples to media seconds and score beats using explicit
`originSample`, `scoreOffsetSample`, sample rate and fixed quarter-note BPM.
Pre-excerpt coordinates remain signed. Sample conversion is continuous, without
rounding; integer quantization belongs at the eventual backend boundary.

From the midi-madness root:

```sh
npm ci
npm run foundation:test
npm run foundation:check
```

Root installation builds foundation through `prepare`; root tests, checks and
the music CLI also build it before importing its installed ESM exports.

To export a versioned dependency for another application, commit the foundation source and run:

```sh
node scripts/pack-shared.mjs foundation /absolute/path/to/consumer/vendor
```

The export records its source commit and npm artifact integrity alongside the
versioned tarball. It refuses dirty foundation source and existing artifact
versions. Install that tarball in the consuming application with `npm install ./vendor/FILE.tgz` and
retain the tarball, provenance and lockfile. Do not edit generated files or reuse
a version for changed contents. No registry publication is needed.
