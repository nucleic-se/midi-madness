# Literal score profile 1

`literal 1` declares stable meaning for literal score notation. It is useful for
interchange and for scores that need explicit compatibility guarantees. See the
[language reference](LANGUAGE.md) for notation and the
[renderer guide](../../packages/render/README.md) for sound controls.

## Declare the profile

Place the declaration in the song block:

```mm
mm 1
song "Practice piece"
  literal 1
  tempo 100
  meter 4/4
  key C major
  humanize off
  dynamics flat

motif melody = | C4 D4 E4 G4 |
rhythm beat = | x . x . |
phrase verse = melody melody
section A = verse
form = A

part melody
  role front
  range C0..C9
  plays notes melody
```

Profile 1 freezes the meaning of the existing literal language and the
extensions documented in [note primitives](../../packages/render/PRIMITIVES.md).
It accepts literal notes/hits/values, rests and holds, subdivisions and inline
`across` tuplets, stacks, duration/gate/velocity/parameter locks, motifs,
rhythms, phrases, sections and form, repeat/fit/length/shift operations, and
literal automation (`across` shapes and `per` values). Typed templates may emit
this subset, or you can write it directly.

`literal 1` is an explicit compatibility declaration, not a restricted parser
mode. Other language constructs may appear beside literals. Unsupported profile
numbers produce an error. `mm 1` scores without a declaration continue working.

## Compatibility contract

- Written durations use exact rational whole-note time. One beat is 1/4 and one
  bar is the meter numerator/denominator. Fractional durations retain their value.
- Bar slots divide the bar equally unless explicit weights/subdivisions apply.
  `_` extends a preceding event; `.` is silence. Chord stacks share an onset.
- Explicit gates determine articulation; humanize cannot invent mono overlaps.
  Set `humanize off` when exact output timing is required.
- Default role/register and velocity/energy behavior remain part of the language
  contract. Set `range`, `dynamics flat` and velocities explicitly for a neutral
  literal interchange target; pitches otherwise fold to the role's register.
- Automation resets, repetition and wrap interpolation follow the documented
  rules. Native parameter domains and normalized mappings must be documented.
- Additive syntax is allowed within profile 1. A semantic change needs a new
  profile or an explicitly documented migration; it cannot silently
  reinterpret a valid profile-1 score.
- Compiler event meaning is stable; presets and DSP may improve. Renderer changes
  affecting sound must be recorded separately from language compatibility.
  Reproducible audio also requires the same engine, presets, setup and data files.

The regression fixture `tests/fixtures/render/literal-v1.mm` contains 512 fully written
attacks, with explicit ranges, gates, velocities and deterministic settings.
The focused suite checks its event fingerprint and quantized audio fingerprint.
A failure must be investigated; updating the expected hashes alone is not a fix.
Audio fixes may update the audio baseline with a documented reason while retaining
the event contract.

Large literal scores are supported without recursive expansion per attack.
Software rendering warns above 256 attacks per bar rather than rejecting a dense
score. Native generators remain compact until backend scheduling; generator
counts are bounded at 65,536 per event and grain overlap at 256 voices. These
resource bounds produce diagnostics/errors rather than silent truncation.
