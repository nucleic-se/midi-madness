mm 1
song "Render debug: band levels"
  tempo 124
  key A minor
  seed 7
  humanize off
  dynamics flat

// A listening/debug track for draft balance (see packages/render guides). Each member plays alone
// for 2 bars at velocity 0.8 over i VI III VII, in band order, then the drums alone, then
// everyone together for 8 bars. Listen for: any member much louder or quieter than the
// others when alone, and any member that disappears in the full band.
// Bars: bass 1-2, acid 3-4, arp 5-6, pads 7-8, chords 9-10, lead 11-12, counter 13-14,
// drone 15-16, seq 17-18, fx 19-20, keys 21-22, drums 23-24, together 25-32.

progression home = i VI III VII
harmony = home

motif tune   = | A4 _ _ C5 _ _ E5 _ _ _ _ _ D5 _ C5 _ | B4 _ _ _ _ _ G4 _ _ _ . . E4 _ G4 _ |
motif answer = | . . . . . . . . . . . . E5 _ G5 _ | A5 _ _ _ . . . . . . . . . . . . |
motif acidriff = | [A2 A3{velocity 1} A2 C3{length 1/16.} D3 . A2{velocity 1} G3 A2 E3{length 1/16.} D3 A2 . C3{velocity 1} A2 A3]{length 1/32, velocity 0.6} |
motif ripple = | c1 . c5 c3 . c5 c1 . c3 . c5 c1 . c3 c5 . |

section s-bass    = rest(2 bars)
section s-acid    = rest(2 bars)
section s-arp     = rest(2 bars)
section s-pads    = rest(2 bars)
section s-chords  = rest(2 bars)
section s-lead    = rest(2 bars)
section s-counter = rest(2 bars)
section s-drone   = rest(2 bars)
section s-seq     = rest(2 bars)
section s-fx      = rest(2 bars)
section s-keys    = rest(2 bars)
section s-drums   = rest(2 bars)
section together  = rest(8 bars)

form = s-bass s-acid s-arp s-pads s-chords s-lead s-counter s-drone s-seq s-fx s-keys s-drums together

part bass
  role low
  plays roots | . . x . . . x . . . x . . . x . |
  range A1..A2
  length 75%
  play when in s-bass, together

part acid
  role low
  plays notes acidriff
  range A1..A3
  play when in s-acid, together

part arp
  role high
  plays arpeggio | x x x x x x x x x x x x x x x x |
  order 0 1 2 1^ 2 1 0^ 2
  length 75%
  play when in s-arp, together

part pads
  role bed
  plays chords
  voices 4
  play when in s-pads, together

part chords
  role bed
  plays chords | . . x . . . . . . . x . . x . . |
  voices 3
  length 1/16
  play when in s-chords, together

part lead
  role front
  plays notes tune
  range E4..A5
  play when in s-lead, together

part counter
  role high
  plays notes answer
  range E5..A6
  play when in s-counter, together

part drone
  role bed
  plays notes | A2 _ _ _ |
  range A1..A3
  play when in s-drone, together

part seq
  role color
  plays notes ripple
  range A3..A6
  length 1/16
  play when in s-seq, together

part fx
  role high
  use riser()
  play when in s-fx, together

part keys
  role bed
  plays chords | x . . . . . x . . . . . x . . . |
  voices 4
  length 1/4
  play when in s-keys, together

part kick
  lane kick
  plays hits | X . . . X . . . X . . . X . . . |
  play when in s-drums, together

part hat
  lane hat
  plays hits | x x X x x x X x x x X x x x X x |
  play when in s-drums, together

part openhat
  lane openhat
  plays hits | . . x . . . x . . . x . . . x . |
  play when in s-drums, together

part clap
  lane clap
  plays hits | . . . . X . . . . . . . X . . . |
  play when in s-drums, together

expect form length 32 bars
