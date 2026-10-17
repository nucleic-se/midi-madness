mm 1
song "Motion desk: filters, phaser and flanger"
  tempo 120
  key D minor
  humanize off
  dynamics flat

fx
  bus swirl = phaser stages 8, center 700Hz, rate 1/1, depth 2oct, feedback -35%

section dry = rest(2 bars)
section filtered = rest(2 bars)
section phased = rest(2 bars)
section flanged = rest(2 bars)
section tuned = rest(2 bars)
section bused = rest(2 bars)
form = dry filtered phased flanged tuned bused
harmony = I

part pads
  plays notes | D3+F3+A3 _ _ _ |
  level = 0.8
  insert = filter cutoff 8kHz, mix 0% -> phaser stages 6, rate 1/1, depth 2oct, mix 0% -> flanger rate 1/2, depth 2ms, feedback 60%, mix 0%
  when in filtered:
    insert.filter.mix = 1
    insert.filter.type = lp24
    insert.filter.cutoff = across section: ramp 0.35..0.9
    insert.filter.resonance = 0.5
  when in phased:
    insert.phaser.mix = 0.5
    insert.phaser.center = across section: ramp 0.35..0.7
  when in flanged:
    insert.flanger.mix = 0.5
  when in tuned:
    insert.flanger.time = 2.272727ms
    insert.flanger.depth = 0ms
    insert.flanger.feedback = -0.65
    insert.flanger.mix = 0.5
  when in bused:
    send.swirl = 0.5

part lead
  plays notes | D4 _ A4 _ F4 _ E4 _ |
  range D3..D6
  level = 0.75
  insert = autofilter cutoff 1kHz, rate 1/8, depth 2oct, resonance 40%, mix 0%
  when in filtered:
    insert.autofilter.mix = 1
  when in phased, flanged, tuned:
    play when never

part hats
  lane hat
  plays hits | x x x x x x x x |
  level = 0.95
  insert = flanger tune A4, depth 1ms, feedback -55%, rate 1/2, mix 0%
  when in flanged, tuned:
    insert.flanger.mix = 0.5
  when in dry, filtered, phased, bused:
    play when never

expect form length 12 bars
