- **design:** the 32 `orca-allow-literal` notes left in `components.css` are gone, and the
  count is now zero (#244). They were never 32 numbers. `size` gains `bar-*` for a band of
  chrome — `bar-status`, `bar-pane`, `bar-title`, `bar-object` — because a bar is a height you
  read, not a height you click; `badge-*` (`badge-sm`, `badge-md`) for a mark that carries a
  word, which is why a chip, a key cap and a schedule badge sit below `hit-min` on purpose and
  a control may never borrow one; `mark-md` beside `mark-sm`, with `mark-port`,
  `mark-skeleton` and `mark-swatch` for the marks whose size is dictated by what they sit on;
  and `col-label`, `col-label-narrow`, `col-node-kind` and `col-matrix-axis` beside `col-time`
  and `col-lineno`. `control-*` keeps meaning "pointer target" and grows two rungs that do not
  loosen it — `control-xs` (a segment inside a group, where the group is the target) and
  `control-sm-5` (the half rung, named the way `space-0-5` is). `spacing` gains the other two
  half rungs, `space-1-5` and `space-2-5`, for the inline padding of a chip and of a button —
  `10px` had been written out twice for the same button. `border` gains `stroke-double`,
  because `border-style: double` needs three widths to draw two lines.
- **design:** two of those literals were arithmetic someone had written out as a number, and
  are now the arithmetic: a config label's top inset is half of what the control beside it is
  taller by, and the log caret is one hairline proud of the mono-log glyph. Both follow the
  type scale now instead of being re-measured against it.
- **design:** the hatch over the risk matrix's severe band is `hatch-period` with a
  `stroke-hairline` stripe rather than #244's proposed first permanent exemption. Rule 4 makes
  that hatch the second channel on severity, so its geometry is a design decision the system
  should be able to name, and a token it is. `components.css` and `docs/DEVELOPMENT.md` both
  say what a new note would now have to argue: not "no token names this yet" but "no token
  could sensibly name this".
