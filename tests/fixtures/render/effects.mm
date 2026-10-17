mm 1
song "Render debug: named spaces and throws"
  tempo 120
  key C minor
  seed 73
  humanize off
  dynamics flat

section throw = rest(2 bars)
section sends = rest(2 bars)
section build = rest(2 bars)
section break = rest(2 bars)
section fade = rest(2 bars)
form = throw sends build break fade

fx
  bus hall = reverb decay 4s, predelay 1/32, size 85%, damping 6kHz, mod 20%
  bus dub = delay time 3/16, feedback 65%, tone bp 1.2kHz, pingpong 80% -> send hall 30%
  bus slap = delay time 1/32, feedback 10%
  bus chain = delay as tap time 1/8, feedback 30% -> reverb as space decay 2s

bus dub
  delay.feedback = 0.5
  when in build:
    delay.feedback = across section: ramp 0.5..0.95
  when in break:
    delay.time = 1/8
    return = 0.6
bus hall
  reverb.decay = pick(in break, 0.8, 0.4)
  when in fade:
    return = 0 - (across section: ramp -1..0)

part keys
  role front
  plays notes | C4{send.dub 1, length 1/1} G4{length 3/4} . . |
  reverb = 0
  delay = 0
  play when in throw
part lead
  role front
  plays notes | C4 _ _ G4 _ _ Bb4 _ |
  play when in sends, build, break, fade
  send.dub = 0.3
  send.hall = 0.25
  send.chain = 0.2
  when in fade:
    send.slap = 0.4
    send.slap.pre = 1
    level = 0 - (across section: ramp -1..0)
part hat
  lane hat
  plays hits | x x x x |
  send.slap = 0.2
  play when in sends, build

expect form length 10 bars
