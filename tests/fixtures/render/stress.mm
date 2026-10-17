mm 1
song "Render fixture: density stress"
  tempo 140
  key D minor
  seed 8
  humanize off
  dynamics flat

// Density and event-loss stress (see packages/render guides). 8 bars at 140 BPM, far denser
// than any song: 32nd-note seq, arp and hats; 16th-note 4-voice chords; 4-voice pads
// retriggered every 8th; a 303 line with slides; a 16-voice keys arpeggio; and fast cutoff
// modulation on every synth member (a full sine cycle every beat).
// Check: the rendered note-on count equals the IR's, no voice hangs after the last bar, and
// the render stays fast. Musically it is noise; it is not meant to be listened to.

progression loop = i VI III VII
harmony = loop

motif acidriff = | [D2 D3{velocity 1} D2 F2{length 1/16.} G2 . D2{velocity 1} C3 D2 A2{length 1/16.} G2 D2 . F2{velocity 1} D2 D3]{length 1/32, velocity 0.6} |

section dense = rest(8 bars)
form = dense

part seq
  role color
  plays notes steps 1/32: c1 c3 c5 c3
  range C3..C7
  cutoff = across 1 beat: sine 0.2..0.8

part arp
  role high
  plays arpeggio steps 1/32: x
  order 0 1 2 1^ 2 1
  length 75%

part chords
  role bed
  plays chords steps 1/16: x
  voices 4
  length 1/32
  cutoff = across 1 beat: sine 0.2..0.8

part pads
  role bed
  plays chords | x x x x x x x x |
  voices 4
  cutoff = across 1 beat: sine 0.2..0.8

part acid
  role low
  plays notes acidriff
  range D1..D3
  cutoff = across 1 beat: sine 0.1..0.9

part bass
  role low
  plays roots steps 1/16: x
  range D1..D2
  length 75%
  cutoff = across 1 beat: sine 0.2..0.8

part keys
  role bed
  plays notes steps 1/16: c1 c3 c5 c7 c5 c3
  range C2..C8
  length 1/1

part lead
  role front
  plays notes steps 1/16: c5 c3 c1 c3
  range C3..C7
  cutoff = across 1 beat: sine 0.2..0.8

part hat
  lane hat
  plays hits steps 1/32: x

part kick
  lane kick
  plays hits | X . . . X . . . X . . . X . . . |

part snare
  lane snare
  plays hits steps 1/16: o x o x

expect form length 8 bars
