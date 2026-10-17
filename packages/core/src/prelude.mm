// ── time: cut, slice, offset ──────────────────────────────────────────────
define delay(x: timed, d: span)              = rest(d)  x
define truncate(x: timed, d: span)           = x.loop(extent(x) - d)
define window(x: timed, a: span, b: span)    = x.rotate(a).loop(b - a)
define pad(x: timed, s: span)                = x  rest(s - extent(x))

// ── texture: lines in parallel ────────────────────────────────────────────
define canon(x: notes, d: span)              = together(x, x.delay(d).truncate(d))
define double(x: notes, step: steps)         = together(x, x.shift(step))
define octaves(x: notes)                     = together(x, x.octave(+1))

// ── cadences: written harmony, not inferred ───────────────────────────────
// the arrival is an argument, so one helper serves every key and cadence:
// verse.cadence(V i), verse.cadence(V I), verse.cadence(V), verse.cadence(V VI), verse.cadence(iv i)
define cadence(p: harmony, ending: harmony)  = p.truncate(extent(ending))  ending

// ── part gestures and presets ─────────────────────────────────────────────
define duck(source: part, amount: percent):
  level = 1 - trigger(source, decay 1/4) * amount

define riser():                      // one held tonic per section, opening over it
  plays notes across section: 1
  cutoff = across section: ramp 0..1
  level = across section: ramp 0.2..1

define drone():                      // one held tonic and fifth per section
  plays notes across section: 1+5

define entry-hit(where: condition):
  plays hits | X . . . |
  play when first bar of section and where
