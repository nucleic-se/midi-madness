mm 1
song "Filter automation"
  tempo 120
  key C major
  humanize off

section A = rest(4 bars)
form = A

part lead
  sound warm-lead
  range C4..C5
  plays notes | C4 E4 G4 E4 |
  cutoff = across 4 bars: ramp 0.2..0.8
  level = 0.6
