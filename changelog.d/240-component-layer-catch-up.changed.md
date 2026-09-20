- **design:** the eight classes v0.4.0 wave 1 had to write in the app because nothing in the
  component layer named them are now in `components.css`, beside the things they vary:
  `.orca-stale-rule` (the 2px bar a reconnecting screen wears), the `.orca-dialog` family,
  `.orca-list` / `__scroller` / `__rows` and the two-line row variant, `.orca-bare` (the reset
  a mark that is also a button needs), and `.orca-minimap__tick--current`.
  `.orca-pane__head--sticky` no longer carries the lift — that is `--lifted`, so "sticks" and
  "something is passing under it" are two statements rather than one. `renderer/src/list.css`
  and `renderer/src/chrome/connection.css` are gone; the app writes no CSS of its own again.
- **design:** five tokens the layer kept reaching past — `row-log` (a line of streamed output
  is a row, derived from `mono-log`'s line height rather than restating it), `hit-min`,
  `mark-sm`, `col-time` and `col-lineno`. Five `orca-allow-literal` notes went with them, 38
  to 33. The minimap gutter is no longer a 4×3px click target: the mark still draws at
  `mark-sm` and the button around it is `hit-min` tall.
- **design:** `semantics.json` gains `agentHealth` — `unknown`, `ok`, `degraded`, `down`, each
  with the word and the glyph an agent health card renders, never colour alone, exported as
  `AGENT_HEALTH_PRESENTATION`. `unknown` is first because it is the honest default: health is
  tracked in the daemon's process and never persisted, so a daemon that has just started knows
  nothing about an agent until it contacts one. All four glyphs were already bundled.
