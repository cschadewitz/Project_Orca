- **design:** stream rules and run-tree guides are drawn with CSS hairline borders instead of
  box-drawing glyphs, so a continuous guide reads as continuous (#212). At `mono-log`'s
  12px/18px a `│` is shorter than its line box, which left a gap at every line boundary and
  made a guide read as dashed. The line height stays — it is what makes a screen of log worth
  scrolling — and `docs/design/30-long-running-content.md` now records why the structure is
  borders rather than glyphs. The `#type` proof surface still draws its frame with real
  U+2500–257F glyphs, because proving the bundled faces carry them is its job, and it now says
  on the page that the gap there is expected.
