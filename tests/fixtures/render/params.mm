mm 1
song "Render fixture: parameter sweeps"
  tempo 120
  key C major
  seed 6
  humanize off
  dynamics flat

// Every score parameter of the synth (see packages/render guides). Each section is 2 bars (4 s at 120 BPM) and sweeps ONE parameter with a ramp
// across the section; everything else stays at the preset value. Section names are the
// parameter names with a p- prefix, so a render report or spectrogram labels each sweep.
// - Bars 1-34: `lead` (warm-lead, mono) plays long notes (C4 and G4, 3/8 each with gaps),
//   for continuous parameters. `lfo-rate` holds lfo.amount at 0.6 while the rate sweeps.
//   `glide` ramps glide while the line moves C4-G4, so the slide time audibly grows.
// - Bars 35-50: `seq` (pluck-seq, poly) plays spaced quarter-note plucks with 1/8 gates, for
//   the envelope parameters. The filter-envelope sections set envamount 0.6 so the filter
//   envelope is audible. The decay section sets sustain 0.
// Expected direction: a ramp from 0 to 1 means darker→brighter, dry→wet, left→right,
// silent→0 dB, short→long.

motif long  = | C4 _ _ _ _ _ . . G4 _ _ _ _ _ . . |
motif glider = | C4 _ _ _ G4 _ _ _ C4 _ _ _ G4 _ _ _ |
motif plucks = | C4 . . . E4 . . . G4 . . . C5 . . . |

section p-cutoff = rest(2 bars)
section p-resonance = rest(2 bars)
section p-envamount = rest(2 bars)
section p-drive = rest(2 bars)
section p-wave = rest(2 bars)
section p-noise = rest(2 bars)
section p-sub = rest(2 bars)
section p-detune = rest(2 bars)
section p-mod = rest(2 bars)
section p-lfo-rate = rest(2 bars)
section p-lfo-amount = rest(2 bars)
section p-bend = rest(2 bars)
section p-pan = rest(2 bars)
section p-level = rest(2 bars)
section p-reverb = rest(2 bars)
section p-delay = rest(2 bars)
section p-glide = rest(2 bars)
section p-attack = rest(2 bars)
section p-decay = rest(2 bars)
section p-sustain = rest(2 bars)
section p-release = rest(2 bars)
section p-filter-attack = rest(2 bars)
section p-filter-decay = rest(2 bars)
section p-filter-sustain = rest(2 bars)
section p-filter-release = rest(2 bars)
form = p-cutoff p-resonance p-envamount p-drive p-wave p-noise p-sub p-detune p-mod p-lfo-rate p-lfo-amount p-bend p-pan p-level p-reverb p-delay p-glide p-attack p-decay p-sustain p-release p-filter-attack p-filter-decay p-filter-sustain p-filter-release

part lead
  role front
  plays notes long
  range C3..C6
  play when in p-cutoff, p-resonance, p-envamount, p-drive, p-wave, p-noise, p-sub, p-detune, p-mod, p-lfo-rate, p-lfo-amount, p-bend, p-pan, p-level, p-reverb, p-delay, p-glide
  when in p-cutoff:
    cutoff = across section: ramp 0..1
  when in p-resonance:
    resonance = across section: ramp 0..1
  when in p-envamount:
    envamount = across section: ramp 0..1
  when in p-drive:
    drive = across section: ramp 0..1
  when in p-wave:
    wave = across section: ramp 0..1
  when in p-noise:
    noise = across section: ramp 0..1
  when in p-sub:
    sub = across section: ramp 0..1
  when in p-detune:
    detune = across section: ramp 0..1
  when in p-mod:
    mod = across section: ramp 0..1
  when in p-lfo-rate:
    lfo.amount = 0.6
    lfo.rate = across section: ramp 0..1
  when in p-lfo-amount:
    lfo.amount = across section: ramp 0..1
  when in p-bend:
    bend = across section: ramp -1..1
  when in p-pan:
    pan = across section: ramp -1..1
  when in p-level:
    level = across section: ramp 0..1
  when in p-reverb:
    reverb = across section: ramp 0..1
  when in p-delay:
    delay = across section: ramp 0..1
  when in p-glide:
    plays notes glider
    glide = across section: ramp 0..0.5

part seq
  role color
  plays notes plucks
  range C3..C6
  length 1/8
  play when in p-attack, p-decay, p-sustain, p-release, p-filter-attack, p-filter-decay, p-filter-sustain, p-filter-release
  when in p-attack:
    attack = across section: ramp 0..0.6
  when in p-decay:
    sustain = 0
    decay = across section: ramp 0..0.6
  when in p-sustain:
    sustain = across section: ramp 0..1
  when in p-release:
    release = across section: ramp 0..0.6
  when in p-filter-attack:
    envamount = 0.6
    filter.attack = across section: ramp 0..0.6
  when in p-filter-decay:
    envamount = 0.6
    filter.decay = across section: ramp 0..0.6
  when in p-filter-sustain:
    envamount = 0.6
    filter.sustain = across section: ramp 0..1
  when in p-filter-release:
    envamount = 0.6
    filter.release = across section: ramp 0..0.6

expect form length 50 bars
