- **app:** Every pane boundary in the window is draggable, and the width is remembered. The
  sidebar, the docked panel, the Runs step detail, the run tree over the event timeline, the
  Plan request rail and the workflow node inspector each carry a `role="separator"` with a tab
  stop, `←`/`→` (or `↑`/`↓`) by one grid step, and `Enter` or a double-click to put the
  boundary back where the design had it. Each has a floor and a ceiling so a drag cannot make
  either pane unusable, each stays out of the way of the collapsed sidebar and the overlaid
  panel below their breakpoints, and each size is kept per boundary in the app's own
  preferences file beside the density choices.
- **design:** `--splitter-thickness`, `--pane-step` and the five `--pane-min-*` / `--pane-max-*`
  size tokens, with `PANE_GEOMETRY` in `@orca/design` for the arithmetic a `var()` cannot do;
  `.orca-splitter` in the component layer. A pane's width is now
  `var(--pane-<boundary>, var(--<token>))`, so the token stays the single statement of the
  default and a dragged width is an override of it.
