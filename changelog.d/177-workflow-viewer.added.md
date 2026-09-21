- **app:** the workflow viewer. `orca://workflow/<name>` draws a workflow as a graph —
  derived layout, never dragged — and `orca://workflow/<name>?run=<id>` draws the same graph
  with that run's path over it: the status glyph and word on each node it visited, the
  attempt count where it went round more than once, the node it is at now marked, and the
  nodes and edges it never reached faded. Pan by dragging the canvas or with a shifted arrow,
  zoom with `+` / `-` / `0`, move the selection with the arrows; the selected node's
  configuration is in the inspector beside it. The run header's "the workflow it executes"
  now opens the viewer with that run overlaid, instead of saying it cannot.
- **app:** the graph's layout is ORCA's own — `renderer/src/workflow/layout.ts`, no new
  dependency. Layers are longest-path dependency depth, order within a layer is the
  barycentre of a node's predecessors, and an edge that returns to a layer it has passed —
  `ai-sdlc`'s review verdict going back to the build — is drawn as a back edge routed above
  the graph rather than through it.
- **app:** a `subworkflow` or a `parallel` is collapsed by default and says how many graphs
  it is hiding; expanding one draws each nested graph in a group box of its own, named by the
  `parent::node::branch` id the daemon addresses it by.
- **app:** a run pinned to a version that is no longer the newest carries the `◷ pinned`
  chip, and the viewer says in words which definition is on screen instead — ORCA records the
  version a run started with but keeps no copy of it, so the graph drawn is always the one on
  disk and the viewer never implies otherwise.
- **design:** `node-w`, `node-h`, `layer-gap` and `rank-gap` tokens, and `GRAPH_GEOMETRY` in
  `@orca/design` — the four of them as numbers, because an SVG path's `d` cannot reference a
  custom property. `WorkflowNode` is built and `component-api.d.ts` says so.
- **app:** a `workflow` scope in the keyboard map, for a canvas whose arrows move between
  nodes rather than between rows. `docs/design/50-accessibility-and-keyboard.md` has the
  table; every one of its keys is in the command palette. A shortcut on a punctuation key now
  matches the press a keyboard actually makes: `+` is Shift and Equal, so the shift is
  spelling the character rather than modifying it and is dropped — `Shift+ArrowUp` and
  `Shift+Enter` are unchanged.
- **app:** the run header names the workflow a run executes *with the version it is pinned
  to* — `sdlc v2` on the run crumb, from the version the run recorded. Whether that version
  is still the newest is the viewer's `◷ pinned` chip, which needs the definition on disk and
  so stays where it is read.
- **design:** a back edge is dotted, not dashed — `--stroke-dash-back` beside
  `--stroke-dash-untaken`, and a legend row for it. "Runs backwards" and "was not taken" are
  different facts about an edge and an edge can be either, so they are no longer one stroke.
  A pinned run's chip is a chip tone rather than `--status-running`, and a selected node is
  `--surface-selected` plus an accent rail rather than an accent outline that read as the
  focus ring.
