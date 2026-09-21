- **app:** the Electron smoke test audits every surface that has been built rather than
  whichever one the window opened on. axe runs over Attention, Runs and Agents in both
  themes, with the failing rule ids in the message so a red run says what broke without
  anyone opening the report, and Plan and Config are asserted to be the unbuilt `StateView`s
  they still are — a screen that says "not built yet" would pass an audit and mean nothing
  by it. Alongside it, the greyscale guarantee is now checked rather than eyeballed: every
  status on the attention list, the run tree and the status bar is read out of the DOM and
  compared against the design system's own presentation maps, so a status carried by colour
  alone fails the build, and a `filter: grayscale(1)` screenshot of each is attached beside
  the assertion for the times the guarantee turns out wrong (#167). The audit's fixture adds
  a parked gate, a failed run and a second host on top of the `orca demo` store — the demo
  itself is unchanged, because it runs the workflow to completion on purpose.
