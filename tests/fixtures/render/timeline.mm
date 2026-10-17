mm 1
song "Render fixture: timeline"
  tempo 120
  key C major
  seed 1
  humanize off
  dynamics flat

// Timing and the timeline origin (see packages/render guides).
// 120 BPM: one beat = 0.5 s = 24000 samples, one bar = 2 s = 96000 samples at 48 kHz.
// - Bars 1-2 are silent. The first sound is the kick on bar 3, beat 1: exactly 4.000 s.
// - The rim clicks every beat in bars 3-6: onsets at 4.0, 4.5, 5.0 … 11.5 s.
// - The lead plays quarters in bar 5 (8.0, 8.5, 9.0, 9.5 s) and eighth-note triplets in
//   bar 6 (10.0 s + n · 1/6 s), each note lasting its full slot.
// - Bar 7 is empty again; the render ends with tails after bar 6.

section opening = rest(2 bars)
section grid    = rest(4 bars)
section tail    = rest(1 bar)
form = opening grid tail

part kick
  lane kick
  plays hits | X . . . |
  play when in grid

part rim
  lane rim
  plays hits | x x x x |
  play when in grid

part lead
  role front
  plays notes | C5 D5 E5 F5 |
  play when in grid and bar > 2 of section
  when bar 4 of section:
    plays notes steps 1/8t: C5 E5 G5

expect form length 7 bars
