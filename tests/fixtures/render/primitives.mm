mm 1
song "Phrase motion"
  literal 1
  tempo 112
  key C major
  seed 1
  humanize off
  dynamics flat
  space binaural
  space distance inverse, air on, reverb room

section verse = rest(4 bars)
section chorus = rest(4 bars)
form = verse chorus

part melody
  sound warm-lead
  mono off
  group melody
  range C4..C6
  level.db = -3
  space.az = across 4 bars: ramp -70..70
  plays notes | C5{pitch -> E5 over 1/8, cutoff 0.2 -> 0.7 over 1/4 curve exp} D5 E5 G5 |
  when in chorus:
    plays notes | G5 E5{pitch 0ct -> -100ct over 1/8} D5 C5 |

part keys
  sound fm-keys
  group harmony
  range C3..C5
  level.db = -8
  plays notes | C4+E4+G4 _ _ _ | F3+A3+C4 _ _ _ |
  lfo2.hz = across 8 bars: exp 1..32
  lfo2.pan = 0.15

part snare
  lane snare
  level.db = -12
  group drums
  plays hits | . x . x |
  when in chorus:
    plays hits | . x . x{ratchet 4, ratchet.decay 0.15, ratchet.curve 0.8} |

part cloud
  sound fm-keys
  group harmony
  range C3..C6
  level.db = -6
  plays notes (across 4 bars: C5{grains 128, grain.size 40ms, grain.scatter 0.2, grain.pitchjitter 10ct, grain.pan 0.7})
