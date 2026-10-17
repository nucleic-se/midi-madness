mm 1
song "Render debug: tempo and pitch modulation"
  tempo 156
  key C minor
  seed 42
  humanize off
  dynamics flat

// Eight two-bar sections: tempo-locked pan; 440 Hz pitch modulation; AM;
// 41.6 Hz expression pan; wide pitch dive; stereo note locks;
// note-ratio ring modulation; tuned comb with dotted-eighth ping-pong echo.
section sync = rest(2 bars)
section fm = rest(2 bars)
section am = rest(2 bars)
section expression = rest(2 bars)
section dive = rest(2 bars)
section locked = rest(2 bars)
section ring = rest(2 bars)
section comb = rest(2 bars)
form = sync fm am expression dive locked ring comb

mix
  echo time 1/8., width 100%, feedback 45%

part lead
  role front
  plays notes | C4 _ _ _ _ _ _ _ G4 _ _ _ _ _ _ _ |
  length 90%
  play when in sync, fm, am, expression, dive, ring, comb
  when in sync:
    lfo.sync 1/16
    lfo.shape sine
    lfo.pan = 1
    lfo.cutoff = 2oct
  when in fm:
    lfo.rate = 440Hz
    lfo.pitch = 1200ct
  when in am:
    lfo.sync 1/128
    lfo.shape triangle
    lfo.amp = -1
  when in expression:
    pan = across 1/64: sine -1..1
  when in dive:
    bend.range = 24st
    bend = 0 - (across section: ramp 0..1)
  when in ring:
    ring.ratio = 1.5
    ring.mix = 1
  when in comb:
    comb.pitch C4
    comb.mix = 0.5
    comb.feedback = 0.6
    comb.depth = 0.0001
    comb.rate = 0.2
    delay = 0.4

part keys
  role front
  plays notes | C4{pan -1, length 1/1} G4{pan 1, length 3/4} . . |
  play when in locked
  reverb = 0
  delay = 0

expect form length 16 bars
