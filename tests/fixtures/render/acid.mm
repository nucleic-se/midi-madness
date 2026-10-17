mm 1
song "Render fixture: 303"
  tempo 125
  key A minor
  seed 3
  humanize off
  dynamics flat

// The 303 voice (see packages/render guides). Two bars per section, 125 BPM (one 16th =
// 0.12 s). Gates are 1/32 unless a slide is written; accents are velocity 1 (127), normal
// notes velocity 0.6 (76).
// - plain:   no accents, no overlaps. Every note retriggers; the level stays even.
// - accents: the same pitch. Four accents in a row (cutoff must climb on each: accent memory),
//            then single accents with space between (each about +6 dB).
// - slides:  overlapping notes (written {length 1/16.}): each must glide in 60 ms without
//            retriggering; non-overlapping notes after them retrigger.
// - leap:    slides over an octave and two octaves, up and down.
// - cutoff, resonance, envmod, decay: one riff, one parameter sweeping per section.
// - glide:   `glide` is set; acid-303 must ignore it and report it (I001).

motif m-plain = | [A2 . A2 . C3 . A2 . E3 . A2 . G2 . A2 .]{length 1/32, velocity 0.6} |
motif m-accents = | [A2{velocity 1} A2{velocity 1} A2{velocity 1} A2{velocity 1} A2 . A2 . A2{velocity 1} . A2 . A2{velocity 1} . A2 .]{length 1/32, velocity 0.6} |
motif m-slides = | [A2{length 1/16.} C3{length 1/16.} E3{length 1/16.} A3 . . . . A2 C3 E3 A3 . . . .]{length 1/32, velocity 0.6} |
motif m-leap = | [A1{length 1/16.} A2 . . A2{length 1/16.} A1 . . A1{length 1/16.} A3 . . A3{length 1/16.} A1 . .]{length 1/32, velocity 0.6} |
motif m-riff = | [A2 A3{velocity 1} A2 C3{length 1/16.} D3 . A2{velocity 1} G3 A2 E3{length 1/16.} D3 A2 . C3{velocity 1} A2 A3]{length 1/32, velocity 0.6} |

section plain     = m-plain.loop(2 bars)
section accents   = m-accents.loop(2 bars)
section slides    = m-slides.loop(2 bars)
section leap      = m-leap.loop(2 bars)
section cutoff    = m-riff.loop(2 bars)
section resonance = m-riff.loop(2 bars)
section envmod    = m-riff.loop(2 bars)
section decay     = m-riff.loop(2 bars)
section glide     = m-riff.loop(2 bars)

form = plain accents slides leap cutoff resonance envmod decay glide

part acid
  role low
  plays melody
  range A1..A3
  cutoff = 0.35
  when in cutoff:
    cutoff = across section: ramp 0..1
  when in resonance:
    resonance = across section: ramp 0..1
  when in envmod:
    envamount = across section: ramp 0..1
  when in decay:
    filter.decay = across section: ramp 0.15..0.6
  when in glide:
    glide = 0.5

expect form length 18 bars
