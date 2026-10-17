# Render fixtures and listening tracks

Small scores that isolate timing, voices, controls and effects. Header comments
state the listening intent. Compiler/DSP regression tests cover selected behavior;
these scores also support listening checks without rendering a full song.

```sh
npm run mm -- check tests/fixtures/render/timeline.mm --setup setups/band/band.setup
npm run mm -- render tests/fixtures/render/timeline.mm
npm run mm -- render tests/fixtures/render/modulation-effects.mm --analysis
```

| Score | What to check |
|---|---|
| `primitives.mm` | Curves, independent pitch/filter paths, ratchets, grains, group tags and binaural motion |
| `literal-v1.mm` | 512 literal attacks; versioned event and quantized audio fingerprints |
| `timeline.mm` | Opening rests, quarters and triplets; the first kick is at 4.000 s (sample 192000) |
| `drums.mm` | Sixteen drum lanes, closed-hat choke, tuning and a groove |
| `acid.mm` | Accents, written slides, octave leaps and filter/envelope sweeps |
| `mono.mm` | Retriggers, legato, held-note return and glide |
| `poly.mm` | Chords, releases, voice pressure and overlapping stabs |
| `params.mm` | Individual synth-control sweeps |
| `levels.mm` | Each member alone, drums together, then the full mix |
| `stress.mm` | Dense parts, render speed and stuck/dropped-note investigation |
| `effects.mm` | Named buses, routing, throws, feedback and pre-fader sends |
| `modulation.mm` | Pitch/tempo LFOs, AM, fast pan, wide bends, ring and comb |
| `inserts.mm` | Ordered chains, automation, gate, tuning, ducking and a cut at 19.5 s |
| `modulation-effects.mm` | Dry, filter/autofilter, phaser, flanger, tuned flanger and a bus |
| `instrument-params.mm` | Oscillators, filter FM, two LFOs, modulation envelope, unison, voice locks and drum pitch/noise |
| `new-sounds.mm` | Plucked strings, vowel positions and the two together |
| `workflow.mm` | Generated voices, per-span timbre sequences and pattern rates |

The original isolation scores use `humanize off` and `dynamics flat` to retain
exact grid timing and velocities. Other scores may deliberately demonstrate
performance settings. Ordinary synth controls are generally normalized; software
extensions accept the native literals described in the renderer guides.

`levels.mm` and `stress.mm` can warn with P004 when chord-relative lines fold back
into range. Hardware setup warnings depend on the selected device mappings;
software setup checks do not validate a hardware patch.

Section energy scales velocity by `0.4 + 0.6 * energy / 9` unless dynamics is flat.
That can put a written drum `X` below the accent threshold in a quiet section.
Use fixed dynamics when accent counts must be exact.

For teaching scores, see `examples/first_song.mm` and `examples/automation.mm`.
