- **app:** surfaces no longer clip content that outgrows the window. The Attention surface
  scrolls at its root, so gates and permission asks below the fold are reachable instead of
  silently cut off, and the failed-runs list keeps a floor rather than being squeezed out by
  a tall stack of cards.
- **app:** the docked panel scrolls its body, so anything a surface puts in the dock — the
  Plan inspector today — is readable to the end whatever the window height, with the panel's
  header staying put above it.
- **design:** `.orca-main` and `.orca-panel` are bounded by the window (`min-height: 0`)
  rather than stretching past it, which is what gives a scroll region inside a surface a
  height to scroll against; `.orca-panel__body` is the dock's scroll region.
