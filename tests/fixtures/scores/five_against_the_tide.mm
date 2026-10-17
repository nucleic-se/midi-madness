mm 1
song "Five Against the Tide"
  tempo 112
  meter 4/4
  key E dorian
  seed 3

// One call and one five-step rhythm. Everything else is derived from them.
motif  call   = | 1@3 3@3 4 5 | 7@2 5@2 4@4 |          // E G A B | D B A
rhythm five   = steps 1/16: x . x x .                    // 5/16 against 4/4
rhythm pulse  = call.rhythm                              // the call's rhythm, pitches removed
signal accent = across 3 bars: sine 0..1                 // a 3-bar wave against 4-bar phrases
signal pump   = trigger(kick, decay 1/4)                 // sidechain shape
signal hit    = trigger(perc, decay 1/8)                 // percussion opens the pad

define answer(m: notes, step: steps) = m.fragment.shift(step)

motif counter = call.invert.octave(-1).on(five.loop(2 bars))   // the inverted call on the 5/16 rhythm
motif lift    = call.where(highest note of bar: accent(0.2), lengthen(1/8))
motif tones   = | c1 c3 c5 c3 | c5 c1^ c3 c5 |           // chord tones: follows the harmony

phrase theme  = call  answer(call, +2)
phrase rise   = lift  answer(lift, +4)

section intro  = rest(4 bars)
section A      = theme  theme.where(last note of phrase: shift(+1), lengthen(1/8))
section bridge = rise.loop(3 bars + 1/2 bar)             // ends mid-bar on purpose
section A2     = theme.octave(+1)  answer(call, -1).extend(2 bars)

form = intro  A  bridge  A2.modulate(+2)

progression home = i IV v VII
harmony           = home
harmony in bridge = home.shift(+2)

// a pedal that ignores the bridge's mid-bar boundary (absolute pitches move with A2's key)
motif pedal = | E2 | _ | B1 | _ |

curve energy = intro 2..3, A 4..6, bridge 6..8, A2 9..7

part lead
  role front
  plays melody
  velocity = 0.55 + accent * 0.4                         // the slow wave, sampled at each attack
  sound digital edge 0.5

part counter
  role color
  plays notes counter
  play when in A, A2
  sound pluck edge 0.4

part tones
  role high
  plays notes tones.on(five.loop(2 bars))
  play when in bridge, A2
  sound bell edge 0.5

part low
  role low
  plays line rest(4 bars)  pedal.loop(19 bars + 2 beats)
  sound round weight 0.8

part kick
  lane kick
  plays hits pulse                                       // the call's own rhythm drives the kick
  play when energy > 3

part perc
  lane rim
  plays hits five                                        // realigned every 4 bars
  restart every 4 bars

part comp
  role bed
  plays chords | . x . x |
  level = 1 - pump * 0.4
  sound pluck edge 0.4

part pad
  role bed
  plays chords
  cutoff = 0.3 + hit * 0.4
  play when in bridge, A2
  sound bowed edge 0.3

expect form length 23 bars + 2 beats
expect bridge length 3 bars + 2 beats
expect in intro: no lead
expect in bridge: lead, low, kick, perc, comp, pad
