# Examples

Start with the small teaching scores, or try a complete demo arrangement.

## Teaching scores

| Score | Demonstrates |
|---|---|
| [First song](first_song.mm) | Eight bars with melody, chords, bass, drums and a section override |
| [Filter automation](automation.mm) | A four-bar filter ramp on a repeating phrase |

## Demo arrangements

| Score | Language and renderer features |
|---|---|
| [Carbonized](carbonized.mm) | Synth automation, layered percussion and effect buses |
| [Flourish](flourish.mm) | Multiple acid synth voices, modulation and detailed percussion |
| [Hollow Bloom](hollow-bloom.mm) | Layered synths, modulation and detailed event articulation |
| [Copper Meadow](copper-meadow.mm) | Modal harmony, synth automation and rhythmic layers |
| [Cobalt Trench](cobalt-trench.mm) | Just intonation, delay automation and dense rhythmic passages |

These are complete arrangements. They are larger than the
teaching scores and take longer to compile and render. Each score is standalone
and uses the built-in software instruments.

## Check and render

```sh
npm run mm -- check examples/first_song.mm --setup setups/band/band.setup
npm run mm -- check examples/carbonized.mm --setup setups/band/band.setup
npm run mm -- render examples/hollow-bloom.mm --bars 8
```

Omit `--bars 8` to render the full arrangement. Audio, performance sidecars and
reports go under ignored `renders/`. See the [renderer guide](../packages/render/README.md)
for rendering options. MIDI playback requires a separate device setup; a score's
software sounds and effects are not hardware instrument mappings.

The renderer fixtures in `tests/fixtures/render/` cover individual sound, effect,
spatial and event features. MIDI routing has a separate score at
`setups/example/smoke.mm`.
