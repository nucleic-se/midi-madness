mm 1
song "First song"
  tempo 100
  key C major
  humanize off
  dynamics flat

motif melody = | C4 D4 E4 G4 | E4 _ D4 _ |
motif bassline = | C2 . G2 . | F2 . G2 . |
motif chords = | C3+E3+G3 _ _ _ | F3+A3+C4 _ _ _ |
rhythm pulse = | x . x . |
rhythm backbeat = | . x . x |

section verse = rest(4 bars)
section chorus = rest(4 bars)
form = verse chorus

part lead
  sound warm-lead
  range C4..C5
  plays notes melody
  when in chorus:
    plays notes melody.octave(+1)
    range C5..C6

part bass
  sound round-bass
  range C2..C3
  plays notes bassline

part keys
  sound fm-keys
  range C3..C5
  plays notes chords
  reverb = 0.2

part kick
  lane kick
  plays hits pulse

part snare
  lane snare
  plays hits backbeat
