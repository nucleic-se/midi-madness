mm 1
song "First MIDI experiment"
  tempo 110
  humanize off
  dynamics flat
section A = (| C4 E4 G4 C5 |).repeat(4)
form = A
part lead
  plays melody
  cutoff = across section: ramp 0.2..0.8
