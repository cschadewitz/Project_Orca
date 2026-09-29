- **app:** Plan gains a Dependencies mode: the plan's dependencies as a derived, layered
  graph (pan, zoom and select, never dragged) with work items, decisions and external targets
  as nodes of their own kind, each dependency's kind as its stroke and its state as its colour
  and in words, and the `blocks` cycles `schedule.get` reports drawn heavy. The selected
  schedule row is the focused node and back, the row filters are shared and a second rail
  holds the graph's own controls, a pinned strip under the canvas shows the selected item's
  row, and the docked panel holds the relationship inspector — blocked by, blocks, and a waive
  that names what it unblocks and updates the graph from its own answer. The canvas's keys
  live in a new `plan-graph` scope. `orca://plan?mode=deps&focus=<id>` opens it, and a work
  item's "Dependencies" counterpart now follows that link.
- **app:** the workflow canvas's layout is now `layoutGraph`, a plain `{ nodes, edges }`
  layout with many roots; `layoutWorkflow` is a thin adapter over it. No new dependency.
- **design:** `stroke-dash-soft` and `stroke-dash-informs`, the `.orca-dep-edge--*` stroke
  and state rules and `.orca-dep--open|failed`; `DependencyNodeProps` corrected against the
  graph (no `kind`, no `onWaive`).
