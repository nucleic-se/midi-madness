mm 1
song "Render fixture: drum kit"
  tempo 120
  key C major
  seed 2
  humanize off
  dynamics flat

// Every lane of the 808/909 kit alone, in note order (see packages/render guides), then the
// closed-hat choke, per-hit tuning, and a short groove.
// 120 BPM, one bar = 2 s. Bars 1-16: one lane per bar, eighths: accent, normal, ghost,
// normal, then a hit with room to decay (beat 3) and one last normal hit.
// - Bar 17: open hat on each beat, closed hat an eighth later: each closed hat must cut the
//   ringing open hat within 5 ms.
// - Bar 18: kick, then kick tuned +3 st and -3 st (`tune` ±0.25 of ±12 st), then +12 st.
// - Bars 19-22: a groove using the core lanes.

rhythm solo = | X . x . o . x . x . . . . . x . |

section l01-kick     = rest(1 bar)
section l02-boom     = rest(1 bar)
section l03-snare    = rest(1 bar)
section l04-clap     = rest(1 bar)
section l05-rim      = rest(1 bar)
section l06-hat      = rest(1 bar)
section l07-openhat  = rest(1 bar)
section l08-ride     = rest(1 bar)
section l09-crash    = rest(1 bar)
section l10-shaker   = rest(1 bar)
section l11-tom-low  = rest(1 bar)
section l12-tom-high = rest(1 bar)
section l13-conga    = rest(1 bar)
section l14-cowbell  = rest(1 bar)
section l15-zap      = rest(1 bar)
section l16-noise    = rest(1 bar)
section choke  = rest(1 bar)
section tuning = rest(1 bar)
section groove = rest(4 bars)

form = l01-kick l02-boom l03-snare l04-clap l05-rim l06-hat l07-openhat l08-ride l09-crash l10-shaker l11-tom-low l12-tom-high l13-conga l14-cowbell l15-zap l16-noise choke tuning groove

part kick
  lane kick
  plays hits solo
  play when in l01-kick, tuning, groove
  when in tuning:
    plays hits | x . . . x{tune 0.25} . . . x{tune -0.25} . . . x{tune 1} . . . |
  when in groove:
    plays hits | X . . . X . . . X . . . X . . . |

part boom
  lane boom
  plays hits | X . . . . . . . . . . . . . . . |
  play when in l02-boom

part snare
  lane snare
  plays hits solo
  play when in l03-snare

part clap
  lane clap
  plays hits solo
  play when in l04-clap, groove
  when in groove:
    plays hits | . . . . X . . . . . . . X . . . |

part rim
  lane rim
  plays hits solo
  play when in l05-rim

part hat
  lane hat
  plays hits solo
  play when in l06-hat, choke, groove
  when in choke:
    plays hits | . . x . . . x . . . x . . . x . |
  when in groove:
    plays hits | x x X x x x X x x x X x x x X x |

part openhat
  lane openhat
  plays hits solo
  play when in l07-openhat, choke, groove
  when in choke:
    plays hits | X . . . X . . . X . . . X . . . |
  when in groove:
    plays hits | . . x . . . x . . . x . . . x . |

part ride
  lane ride
  plays hits solo
  play when in l08-ride

part crash
  lane crash
  plays hits | X . . . . . . . . . . . . . . . |
  play when in l09-crash

part shaker
  lane shaker
  plays hits solo
  play when in l10-shaker

part tom-low
  lane tom-low
  plays hits solo
  play when in l11-tom-low

part tom-high
  lane tom-high
  plays hits solo
  play when in l12-tom-high

part conga
  lane conga
  plays hits solo
  play when in l13-conga

part cowbell
  lane cowbell
  plays hits solo
  play when in l14-cowbell

part zap
  lane zap
  plays hits solo
  play when in l15-zap

part noise
  lane noise
  plays hits solo
  play when in l16-noise

expect form length 22 bars
