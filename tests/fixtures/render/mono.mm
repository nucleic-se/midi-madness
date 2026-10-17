mm 1
song "Render fixture: mono and legato"
  tempo 120
  key C major
  seed 4
  humanize off
  dynamics flat

// Mono voices (see packages/render guides), on `lead` (warm-lead, legato) and
// `bass` (round-bass, legato glide 40 ms). 120 BPM, one beat = 0.5 s. The lead plays bars
// 1-6, the bass repeats the same tests an octave and a half lower in bars 7-12.
// - retrig: separate notes with gaps. Every note retriggers its envelopes.
// - touch:  notes end exactly where the next starts (full gates). Not an overlap: every note
//           retriggers.
// - legato: each note overlaps the next by an eighth. No retrigger: one continuous envelope.
// - stack:  C held the whole bar, E pressed on beat 2 for an eighth. E takes over legato at
//           beat 2; when E is released at 2.5, C sounds again (legato), until the bar ends.
// - older:  C (0-0.375 of the bar) overlaps E (0.25-0.75). Releasing C must not cut E.
// - glide:  the legato line again with `glide` 0.4 (about 320 ms): audible portamento.

motif m-retrig = | C4{length 1/8} D4{length 1/8} E4{length 1/8} G4{length 1/8} |
motif m-touch = | C4 D4 E4 G4 |
motif m-legato = | C4{length 1/4.} D4{length 1/4.} E4{length 1/4.} G4 |
motif m-stack = | C4{length 1/1} E4{length 1/8} . . |
motif m-older = | C4{length 3/8} E4{length 1/2} . . |

section retrig = m-retrig
section touch  = m-touch
section legato = m-legato
section stack  = m-stack
section older  = m-older
section glide  = m-legato
section retrig-b = m-retrig.transpose(-18)
section touch-b  = m-touch.transpose(-18)
section legato-b = m-legato.transpose(-18)
section stack-b  = m-stack.transpose(-18)
section older-b  = m-older.transpose(-18)
section glide-b  = m-legato.transpose(-18)

form = retrig touch legato stack older glide retrig-b touch-b legato-b stack-b older-b glide-b

part lead
  role front
  plays melody
  range F#1..C6
  play when in retrig, touch, legato, stack, older, glide
  when in glide:
    glide = 0.4

part bass
  role low
  plays melody
  range F#1..D3
  play when in retrig-b, touch-b, legato-b, stack-b, older-b, glide-b
  when in glide-b:
    glide = 0.4

expect form length 12 bars
