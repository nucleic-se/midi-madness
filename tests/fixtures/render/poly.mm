mm 1
song "Render fixture: poly voices and tails"
  tempo 120
  key C major
  seed 5
  humanize off
  dynamics flat

// Poly voices, stealing and release tails (see packages/render guides). 120 BPM.
// - held (pads, 8 voices): a 4-note chord held 2 bars, then silence for its 1.5 s release.
// - steal (pads): a 10-note stack. Pads has 8 voices: the 2 oldest notes are stolen with a
//   5 ms fade (no click). Count the voices sounding: 8.
// - stabs (chords): short 4-note stabs; each release overlaps the next stab.
// - keys (fm-keys, 16 voices): a sustained arpeggio whose notes all ring together.
// - end: the last pad chord is held to the end of the song. The render must continue after
//   the last bar until the tail falls below -90 dBFS (pad release 1.5 s plus reverb).

section held  = rest(3 bars)
section steal = rest(2 bars)
section stabs = rest(2 bars)
section keys  = rest(2 bars)
section end   = rest(1 bar)
form = held steal stabs keys end

part pads
  role bed
  range C2..C7
  plays notes | C4+E4+G4+B4 _ _ _ | _ _ _ _ | . . . . |
  play when in held, steal, end
  when in steal:
    plays notes | C3+E3+G3+B3+D4+F4+A4+C5+E5+G5 _ _ _ | . . . . |
  when in end:
    plays notes | A3+C4+E4+G4 _ _ _ |

part chords
  role bed
  range C2..C7
  plays notes | [C4+E4+G4+B4 . . C4+E4+G4+B4 . . C4+E4+G4+B4 .]{length 1/16} |
  play when in stabs

part keys
  role bed
  range C2..C7
  plays notes | [C4 E4 G4 B4 D5 G5 B5 D6]{length 1/1} |
  play when in keys

expect form length 10 bars
