# Spatial audio

Spatial audio is an optional software-renderer feature. Ordinary scores remain
stereo with their existing pan behavior. It does not create meshes or scenes.

```mm
song "Moving melody"
  tempo 120
  space binaural
  space distance inverse, air on, reverb room

part melody
  space.az = across 4 bars: ramp -180..180
  space.el = 15
  space.dist = 3
  plays notes | C4{space.dist 8 -> 1 over 1/4, length 1/2} E4 . . |
```

Output choices are `space stereo`, `space binaural`, and `space ambisonic 1`.
Coordinates accept ordinary numbers: azimuth −180..180 degrees (0 front,
positive clockwise/right), elevation −90..90 degrees, and distance 0.1..100 m.
They support automation, per-note locks and paths. Positioned voices are point
sources, so their spatial position replaces ordinary pan/unison stereo placement.
When azimuth is omitted, ordinary pan supplies a position within the front
hemisphere. Synth note motion is independent per voice. Drum positions follow each lane's
current hit; overlapping hits on one drum lane retain that lane's existing choke
and retrigger behavior. Drum per-note paths are not supported.

`space distance inverse` enables inverse-distance gain beyond 1 m and physical
propagation delay at 343 m/s. A changing distance changes the delay tap and
produces Doppler automatically; no extra pitch curve is necessary. Fast motion
can produce pronounced pitch changes. `air on` adds frequency-dependent distance
attenuation; `air off` disables it. `reverb room` adds a distance-derived send to
that named bus (which must exist). Propagation also delays the reverb input.
Room settings still come from the ordinary bus definition. Allow enough tail
for the distance delay and effect decay.

Binaural output uses a lightweight analytic head model: interaural delays up to
0.65 ms, far-ear head shadow and front/back/elevation pinna coloration. It is an
initial listening model, not a measured or individualized HRTF. Front/back and
elevation perception vary by listener and headphones; tune this from listening.

## World space and the listener

A part can instead place its sources in **world space** with `space.x`,
`space.y` and `space.z` (metres), and a song can move the **listener** through
that world. The renderer derives listener-relative azimuth, elevation and
distance for every voice at every sample, so moving the listener never moves the
sources, and Doppler follows relative motion even when only the listener moves.

```mm
listener
  x = 0
  y = 1.7
  z = across 8 bars: ramp 30..12
  yaw = across 8 bars: ramp 0..45

part stone
  space.x = 10
  space.y = 2
  space.z = 0
  plays notes | C4{space.y -2 -> 4 over 1 bar} . . . |
```

The coordinate system is right-handed and Three.js-compatible; consumers
can use the exported axes without depending on a scene or graphics package:

| Axis / angle | Meaning |
| --- | --- |
| `+x` | right (east) |
| `+y` | up |
| `-z` | forward (north); `+z` is toward a default viewer |
| `yaw` | degrees; 0 faces `-z`; positive turns clockwise seen from above, toward `+x` |
| `pitch` | degrees, −90..90; positive looks up. There is no roll. |

The `listener` block is a top-level block with indented automation for `x`, `y`,
`z` (−1000..1000 m), `yaw` (−3600..3600°, unwrapped so ramps can orbit) and
`pitch`. It accepts the same expressions and `when` blocks as part automation.
Without it, the listener stays at the origin facing `-z`.

Rules:

- **Frame per part.** A part using `space.x/y/z` anywhere (automation, note locks
  or paths) is a world-frame part. A part using `space.az/el/dist`, or no spatial
  controls, keeps the existing listener-relative behaviour: it is head-locked and
  unaffected by listener motion. Mixing both
  coordinate families in one part is an error.
- **World defaults.** Unset world coordinates are 0. Pan does not position
  world-frame voices; each voice is a point source.
- **Locks and paths** on `space.x/y/z` override the part's position for that
  voice, exactly like other voice controls. Drum hits can lock positions per hit.
  Drum per-note paths remain unsupported.
- **Distance** is clamped to 0.1..250 m for gain, air and propagation. Listener-relative
  `space.dist` keeps its 0.1..100 m domain.
- **Level at the source.** For world-frame parts, member `level`/`level.db`
  automation (and drum lane level) is applied before propagation, so a source
  that gets quieter is heard getting quieter after its travel time. Member
  high-pass, comb, chorus and inserts remain member stages after spatialization,
  as for every part. Head-locked parts keep member level as a listener-side fader,
  unchanged.

### Position and listener lanes

World positions and the listener pose are exported and rendered from the same
**lanes**: sorted points `{ sample, value, curve }`. A point's `curve` describes
the segment that follows it: `linear` interpolates to the next point and `step`
holds until the next point. Before the first point the value is the default
(0), and after the last point it holds. Lanes start at backend sample 0, so the
pre-roll before score time zero uses the value at score time zero.

Automation is sampled on the renderer's control grid (250 Hz, or 3 kHz for fast
shapes) plus every automation boundary. A jump at a boundary is written as a
`step` point one sample before it, followed by the new value. Collinear points
are then removed (tolerance 0.1 mm, 0.001°). Audio evaluates these exact lanes
per sample, so graphics evaluating the same lanes sees the positions the audio
used.

### Export contract (`mix.events.json`)

The additions are optional fields, so the document remains
`midi-madness-performance` version 1 and existing consumers keep working.

- `world`: `{ version: 1, units: 'm', axes, listener }`. `listener` holds lanes
  for `x`, `y`, `z`, `yaw` and `pitch`; an absent lane means the default 0.
- `tracks[].space`: `{ frame: 'world' | 'listener', position? }`. For world-frame
  tracks, `position` holds the `x`, `y` and `z` lanes; those controls are not
  repeated as `set` events. Note locks and note paths stay on their `on` events
  and override the lane for that voice. A listener-frame track's world position
  is the listener pose applied to its azimuth/elevation/distance at the same
  sample.
- `tracks[].resolved`: the data needed to evaluate envelopes the way the synth
  does. Synth tracks carry the fully resolved `preset` (after score overrides)
  and the allocated `voiceCount`. Drum tracks carry the lane model:
  `basePitch`, `pitchDecay`, `baseDecay`, `trimDb`, `pan` and `roomDb`.
  Envelope controls in `events` (for example `attack`, `filter.decay`) are knob
  values; the synth's `knobTime` mapping converts them to seconds.

- `tracks[].envelopes`: the envelope values the backend actually produced, as lanes
  (simplified within 0.001). They're authoritative for retrigger, release, legato
  hand-off and voice stealing.
  - **Synth tracks:** one record per note lifetime:
    `{ id, on, end, amplitude, filter }`.
    - `id` and `on` match the note's `on` event.
    - `end` is the sample where the voice fell silent, was stolen or was handed
      over legato.
    - `amplitude` is the amp envelope stage (0..1, or the grain window), before
      velocity, note level, member level and tremolo.
    - `filter` is the filter envelope (0..1), before `envamount`.
    - A resumed mono note can have more than one record.
  - **Drum tracks:** one record per hit: `{ hit, on, end, amplitude }`.
    - `hit` indexes `hits`.
    - `amplitude` is 1 at the attack and includes chokes.
    - It ends at the next hit or after 3 × decay.
    - Velocity and accent scale it separately: `(0.2 + 0.8·v^1.5)`, +3 dB when
      accented.

Sample coordinates are unchanged:
`seconds = (sample - audio.originSample) / audio.sampleRate`. Geometry and
light should use source (emission) time; audio is heard at arrival time, which
includes the propagation delay `distance / 343` when distance is enabled. The
spatial voice is a moving delay tap: at each output sample it reads the source
signal `distance / 343` earlier and applies the gain, air and direction of the
geometry **at that output sample**. For moving sources this differs slightly from
emission-time geometry (this is the standard approximation; it produces Doppler).

First-order ambisonic output writes a four-channel 32-bit float WAV in **ACN/SN3D
W,Y,Z,X** order. Y is left, Z is up and X is front. Use an ambisonic decoder to
listen; generic four-channel playback interprets these as speaker channels.
Dry voices encode their directions; bus returns and the residual from member
inserts are omnidirectional in W. The output has a linked 0.95 safety ceiling
across its four channels. Reports identify the mode and channel count. Optional
analysis remains a stereo monitoring view, not four-channel analysis.
