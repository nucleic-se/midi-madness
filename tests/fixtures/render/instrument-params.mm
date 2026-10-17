mm 1
song "Instrument desk: from init to motion"
  tempo 120
  key D minor
  humanize off
  dynamics flat

section plain = rest(1 bar)
section dual = rest(1 bar)
section pulse = rest(1 bar)
section fm = rest(1 bar)
section sync = rest(1 bar)
section folded = rest(1 bar)
section filter = rest(1 bar)
section tracked = rest(1 bar)
section flutter = rest(1 bar)
section two-lfos = rest(1 bar)
section chirp = rest(1 bar)
section spread = rest(1 bar)
section locks = rest(2 bars)
section drums = rest(2 bars)
form = plain dual pulse fm sync folded filter tracked flutter two-lfos chirp spread locks drums
harmony = I

part voice
  sound init
  plays notes | D4 . F4 . A4 . C5 . |
  level = +3dB
  play when not in spread, locks, drums
  when in dual:
    osc2.level = 0.5
    osc2.semitone = 7st
    osc2.fine = 12ct
  when in pulse:
    osc1.wave = 1
    pw = 0.3
    lfo.hz = 2
    lfo.pw = 0.2
  when in fm:
    osc1.wave = 0
    fm.index = across section: ramp 0.5..6
    fm.ratio = 2
  when in sync:
    osc1.level = 0
    osc2.level = 1
    sync = 1
    sync.ratio = across section: ramp 1..6
  when in folded:
    osc1.wave = 0
    fold = across section: ramp 0.1..0.9
  when in filter:
    filter.type = bp
    cutoff = 0.5
    keytrack = 1
    filter.fm = 1oct
  when in tracked:
    lfo.ratio = 2
    lfo.cutoff = 2oct
  when in flutter:
    lfo.trigger = note
    lfo.hz = 41
    lfo.pitch = 120ct
    lfo.fade = 100ms
    lfo.slew = 1ms
  when in two-lfos:
    lfo.hz = 2
    lfo2.sync 1/16
    lfo2.pitch = 80ct
    lfo2.pan = 0.5
    lfo2.rateMod = 2
  when in chirp:
    modenv.attack = 2ms
    modenv.decay = 80ms
    modenv.pitch = 1200ct
    modenv.cutoff = 2oct

part wall
  sound saw-pluck
  mono off
  voices 8
  unison 4
  unison.spread = 24ct
  unison.width = 1
  plays notes | D3+F3+A3 _ _ _ |
  level = +3dB
  play when in spread

part independent
  sound init
  plays notes | D4{pan -1, lfo.hz 7, lfo.pitch 120, lfo.trigger 1, length 1/1} F4{pan 1, lfo.hz 11, lfo.cutoff 2, lfo.trigger 1, envamount 0.8, length 1/1} . . |
  level = +3dB
  play when in locks

part tom
  lane tom-low
  plays hits | x . x . |
  drum.pitch = D3
  drum.pitch.depth = 12st
  drum.pitch.decay = 80ms
  drum.lfo.sync 1/16
  drum.lfo.pitch = 3st
  noise = 0.15
  level = +3dB
  play when in drums

expect form length 16 bars
