mm 1
song "Wood and breath"
  tempo 108
  key D major
  humanize off
  dynamics flat

fx
  bus hall = reverb decay 3.8s, predelay 18ms, damping 6kHz
  bus ripples = delay time 3/16, feedback 35%, pingpong 85%

section strings = rest(4 bars)
section vowels = rest(10 bars)
section together = rest(8 bars)
form = strings vowels together

part harp
  sound ks-pluck
  plays notes | D4 . A4 . F#4 . E4 . | B3 . F#4 . A4 . E4 . | G3 . D4 . F#4 . A4 . | A3 . E4 . C#5 . E4 . |
  range G3..C#5
  length 90%
  release = 0.5
  pluck.damping = 0.4
  pluck.brightness = 0.7
  pluck.decay = 2.5s
  pluck.pick = 0.3
  level = 0.9
  pan = -0.15
  send.hall = 0.35
  send.ripples = 0.3
  play when in strings, together
  when in strings and bar > 2 of section:
    pluck.brightness = 0.25
    pluck.pick = 0.7
  when in together:
    pluck.brightness = across section: ramp 0.35..0.8

part voices
  sound choir
  plays notes | D3+F#3+A3 _ _ _ | _ _ _ _ |
  range D3..B4
  lfo.vowel = 0
  vowel = 0
  level = 0.85
  send.hall = 0.45
  play when in vowels, together
  when in vowels and bar 3..4 of section:
    vowel = 0.25
  when in vowels and bar 5..6 of section:
    vowel = 0.5
  when in vowels and bar 7..8 of section:
    vowel = 0.75
  when in vowels and bar 9..10 of section:
    vowel = 1
  when in together:
    plays notes | D3+F#3+A3 _ _ _ | B3+D4+F#4 _ _ _ | G3+B3+D4 _ _ _ | A3+C#4+E4 _ _ _ |
    vowel = across 4 bars: sine 0..1
    formant.shift = 0st

expect form length 22 bars
