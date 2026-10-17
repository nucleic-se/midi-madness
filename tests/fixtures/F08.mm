mm 1
signal pump = trigger(kick, decay 1/4)
signal p2 = pump * 2
motif hook = | E4 |
motif bad = hook.where(pump > 0.5: mute)
part kick
  plays hits | x |
part a
  plays notes hook
  play when pump > 0.5
part b
  plays notes hook
  play when p2 > 0.5
part pad
  plays chords
  level = 1 - pump
