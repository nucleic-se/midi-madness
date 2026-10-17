# Reference

These pages describe the score language, command-line interface and instrument configuration. For a step-by-step introduction, start with [Writing a song](../guides/WRITING_A_SONG.md).

| Reference | Use it for |
|---|---|
| [Language](LANGUAGE.md) | Syntax, semantics and execution contracts |
| [CLI](TOOLING.md) | Commands, flags, diagnostics and structured output |
| [Instruments and setups](INSTRUMENTS.md) | MIDI definitions, parameters, routing and device constraints |
| [Literal profile 1](LITERAL_V1.md) | Stable literal-score meaning and compatibility |

## Common language topics

- [File includes](LANGUAGE.md#file-includes)
- [Song settings](LANGUAGE.md#5-song-block)
- [Notes, hits and durations](LANGUAGE.md#6-timed-literals)
- [Pattern operations](LANGUAGE.md#7-operations)
- [Sequences and functions](LANGUAGE.md#8-sequences-alternation-and-functions)
- [Harmony](LANGUAGE.md#9-harmony)
- [Curves and signals](LANGUAGE.md#10-curves-and-signals)
- [Conditions](LANGUAGE.md#11-conditions)
- [Parts](LANGUAGE.md#12-parts)
- [Expectations](LANGUAGE.md#14-expectations)

## Backend references

Software-specific settings are documented with the [audio renderer](../../packages/render/README.md). MIDI mappings are documented in [Instruments and setups](INSTRUMENTS.md). The [supported-feature overview](../SUPPORTED_FEATURES.md) distinguishes their capabilities and limitations.
