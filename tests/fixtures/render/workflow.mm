mm 1
song "Three small machines"
  tempo 112
  key G major
  humanize off
  dynamics flat

section first = rest(4 bars)
section answer = rest(4 bars)
form = first answer

template pendulum(n: number, note: notes):
  sound ks-pluck
  plays notes | note{pan -0.75} . note{pan 0.75} . |.fast((8 + n) / 8)
  pluck.brightness = per 1 bar: 0.35, 0.7, 0.5, 0.85
  pluck.decay = 1.5s
  level = 0.85
  cutoff = 0.65 + n * 0.025
  send.echo = 0.3
  when in answer:
    pluck.pick = per 1 bar: 0.2, 0.7

for n, note in [0 G3, 1 B3, 2 D4]:
  part pend-{n} = pendulum(n, note)

part bed
  sound choir
  plays notes | G3+B3+D4 _ _ _ | _ _ _ _ |
  level = 0.5
  vowel = per 2 bars smooth: 0, 0.25, 0.75, 1
  lfo.vowel = 0
  reverb = 0.4

part rim
  lane rim
  plays hits | x . x . |.fast(per 1 bar: 1, 1.5, 2, 1)
  velocity = velocity * (per 1 bar: 0.6, 0.45, 0.35, 0.6)
  pan = 0.3
  level = 0.5

expect form length 8 bars
