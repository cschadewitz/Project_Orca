- **app:** the docked artifact panel. An artifact chip, a version strip and the panel's open
  state are one seam: the artifact is an address — `{ runId, name, version, compareWith? }` —
  held above every surface, so a step's chip opens it today and a deep link can open it later.
  `[` and `]` step versions in the `panel` scope, a body the daemon declines shows its reason
  in words where the body would have been, consumed-by links come from the run's steps, and a
  comparison renders as a line diff with `+` / `−` gutters, never colour alone. Markdown is
  raw: the rendered toggle is absent rather than disabled, because a renderer is a dependency
  decision (#245).
