mm 1
song "Insert desk: grit, motion, echoes and tuning"
  tempo 120
  key Eb major
  tuning just chord
  humanize off
  dynamics flat

fx
  bus chamber = reverb decay 3s, predelay 1/32
  bus bounce = delay time 1/8., feedback 50%, tone lp 3kHz

section clean = rest(2 bars)
section grit = rest(2 bars)
section motion = rest(2 bars)
section water = rest(2 bars)
section tuned = rest(2 bars)
section stop = rest(2 bars)
form = clean grit motion water tuned stop
harmony = I

bus chamber
  duck from kick 6dB release 1/8

part lead
  plays notes | Eb4 _ G4 _ Bb4 _ D5 _ |
  range Eb3..D6
  wave = 0
  level = 0.7
  insert = drive as dirt 35%, mix 0% -> filter cutoff 4kHz, resonance 20% -> delay time 1/8, feedback 40%, mix 20%
  insert.dirt.mix = 0
  send.chamber = 0.4
  when in grit:
    insert.dirt.mix = 1
    insert.filter.cutoff = across section: ramp 0.4..0.9
  when in motion:
    insert.delay.time = 1/8t
  when in stop:
    insert.delay.bypass = 1
    play when never

part pads
  plays notes | Eb3+G3+Bb3 _ _ _ |
  insert = chorus rate 1/2, depth 50%, mix 25% -> gate pattern | x . x x . x . . |, rate 1/16, attack 3ms, release 20ms
  level = 0.55
  send.chamber = 0.5
  play when in motion, water

part keys
  plays notes | Eb4{pan -1} _ G4-13.69ct{pan 1} _ Bb4{send.bounce 1} _ . . |
  range Eb3..Bb5
  insert = crush bits 10, rate 8kHz, mix 35% -> ring hz Eb2, mix 10%
  level = 0.7
  play when in tuned

part counter
  plays notes | Eb4 _ _ _ G4 _ _ _ |
  range Eb3..Bb5
  insert = autofilter cutoff 1800Hz, rate 1/8, depth 2oct, resonance 35% -> tremolo rate 1/16, depth 35% -> autopan rate 1/2, depth 75% -> comb pitch Eb3, feedback 35%, mix 15%
  level = 0.45
  play when in motion

part kick
  lane kick
  plays hits | X . X . |
  insert = drive 15%, mix 30%
  level = 0.5
  play when not in stop

silence before stop for 1 beat and cut fx
expect form length 12 bars
