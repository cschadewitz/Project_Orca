# Workflow editing

The viewer shipped first (#177). The editor now ships over it: workflow drafts in the daemon
(#180), the visual editor (#181) and its validation panel (#182). Dry run (#183) is still
ahead. This file is the editor's spec and its as-built record.

## The model: semantic edits, drag and drop, layout as metadata

**You edit the graph directly. The file only ever changes semantically.**

The editor is a canvas with a palette and an inspector. Drag a node type from the palette onto
the canvas to add it, or onto an edge to insert it there. Drag a node to move it. Drag from a
node's port (the dot on its right edge, or its bottom edge when the graph runs top to bottom)
onto another node to connect them. Select a node or an
edge to edit it in the inspector. The outline on the left lists the nodes in file order, and
there is one selection across the outline, the canvas and the inspector.

This replaces this file's earlier rule that the canvas is never dragged (#181 records the
change). That rule protected the file: a dragged graph has to keep coordinates somewhere, and
coordinates in the workflow pollute every diff while a sidecar drifts once somebody edits the
YAML by hand. The editor keeps both protections:

- **Every gesture is a semantic operation on the draft** (`workflowDrafts.apply`): add, insert
  on an edge, connect, rename, change type, delete, reorder. None of them writes a position
  into the workflow, so a published diff shows only what changed about the workflow.
- **Where a node was dropped is layout metadata, kept apart from the workflow.** A drag is a
  `place` operation on the draft's layout record. On publish the layout is written to
  `workflows/.layout/<id>.json`, never into `<id>.yaml`.
- **Layout stays derived wherever nobody dragged.** A node with no pin is placed by the
  automatic layered layout (`layout.ts`), so a hand-written workflow still draws and a stale
  pin for a renamed or deleted node is ignored. **Tidy layout** unpins every node in the graph
  on screen.

**Editing operations.**

| Operation | Pointer | Keyboard | Result |
| --- | --- | --- | --- |
| Add node | Drag a palette item onto the canvas | Press a palette item, or `⌘⏎` on the canvas to reach the palette | Node added with a generated id (`gate-1`) and placed where it was dropped. Pressed, it is inserted after the selected node |
| Insert on an edge | Drag a palette item onto an edge | — | `from → new → to`; the edge's condition stays on its first half |
| Move | Drag a node | — | Layout only; the workflow text is unchanged |
| Connect | Drag from a node's port onto another node | `C` with a node selected, then pick a target | Edge added |
| Branch | — | Select an edge: **Only when** and **Label** in the inspector | A decision's edges test `choice == 'option'`; one may be unconditional, the default |
| Rename | — | Inspector's **Id**, or `F2` | Every edge, the graph's `start` and any artifact input's `fromNode` follow the new name |
| Reorder | Drag a row's grip in the outline | `⌥↑` / `⌥↓` | File order only; execution order is the edges |
| Delete | Inspector's **Delete** | `⌫` or `Delete` | The node goes; its edges stay, dangling, and validation names them. Nothing is rerouted silently. The selection moves to the next node in file order |
| Delete with its connections | Inspector | `⇧Delete` | The node and every edge into or out of it |
| Delete an edge | Inspector's **Delete edge** | `⌫` or `Delete` with the edge selected | The edge goes; the selection moves to the node it left from |
| Change type | Inspector's **Type** | — | Fields the new type does not use are kept in the draft and flagged, not dropped |
| Open a container | Double-click a `loop` or `parallel` | `Enter` | The canvas shows the inline graph; the trail above it leads back out |
| Undo, redo | Draft bar | `⌘Z`, `⌘⇧Z` | One step per batch of operations, kept in the draft so it survives closing the app |

Pan, zoom, selection, the layout direction and the minimap work as in the viewer (below, "The
canvas's view"). Every pointer gesture has a keyboard path, and every key is in the
`workflow-edit` scope, so the palette lists them.

The inspector's **Delete** and **Delete edge** are default-tone buttons that do not ask, like
the keys that do the same: each edits the draft, which `⌘Z` takes back and only **Review and
publish** writes, so the one act here that confirms and wears the danger tone is **Discard**.

**A delete keeps the person where they were.** Every delete — the keys and the inspector's three
buttons — is one path in the editor. The selection moves to a neighbour: after a node, the next
node in file order, or the one before when it was the last (the claims list's rule,
`focusAfterLeaving`, over the outline's order); after an edge, the node it left from. When the
delete took focus with it — a press in the inspector, whose button goes with the node — focus
goes to the canvas, whose active descendant now names the neighbour and where `⌘Z` is one key
away. From the canvas's own Delete key focus is already there, and focus a person moved while
the operation was out stays where they put it.

## Drafts

Editing does not touch the live file. **Edit** on the workflow viewer opens a **draft**, owned
by the principal who opened it and stored beside the workflow:

```
workflows/ai-sdlc.yaml                          the live file
workflows/.drafts/ai-sdlc@<owner hash>.json     the draft, until it is published or discarded
workflows/.layout/ai-sdlc.json                  pinned positions, written on publish
```

The draft holds the base it was taken from (version, a content hash and the text), the
draft's YAML, its layout and up to a hundred undo steps. Every edit goes through the `yaml`
package's comment-preserving document, so comments, key order, quoting, flow-style edges and
blank lines survive, and publishing a change is byte-identical to making the same change by
hand. `.drafts` and `.layout` are dot directories, which the configured `workflows/**` globs
never load.

Every mutation names the draft revision it was made against, under a per-workflow lock: a
second window editing the same draft is refused with `CONFIG_STALE`, and the editor re-reads
the draft and says so rather than overwriting it.

The editor draws the change set on the canvas: added nodes take `status-succeeded` borders on
`status-succeeded-bg`, changed nodes take `accent`, removed nodes stay on the canvas dashed in
`status-failed` with their name struck through, and new edges are dashed in `accent`.

**Publishing** is **Review and publish**: the exact bytes that will be written, as a diff
against the live file, with the next version already in them. The version counts its trailing
number up (`1` → `2`, `1.4` → `1.5`); generation activation refuses a recorded version with
different content (#179), so a publish always needs a new one. Publish is bound to the review:
if the draft or the workflow file changed after the review, it is refused and asks for a new
one. It runs under the configuration writer lock, writes the file and the layout, and
activates a configuration generation exactly as `templates.publish` does. If activation
refuses the workflow, the previous file and layout are restored and the draft is kept.

Discarding asks once. A draft is never auto-published, never auto-discarded, and survives the
app closing.

**One draft per workflow.** If somebody else's draft exists when you open the editor, you get
theirs read-only rather than a competing one: no palette, no keys that write, no publish.

## Validation and dry run

The validation panel is docked under the canvas and is always present, empty when the draft
is clean, because a panel that appears and disappears is a panel people stop watching. Every
row names where it is and selects it when pressed. The node's own findings are also at the top
of its inspector, and a node with errors carries an `n errors` flag on the canvas.

Findings come from the runtime's own schema and graph validator, run against the **active
configuration generation**: its templates, agents, workflows and custom node validators. A
draft that validates clean is one activation will accept. Three severities:

- **Error** (blocks publish): anything the schema or the runtime validator refuses, such as a
  dangling edge, an edge out of an `end`, a missing start, a node with no outgoing edge, a
  decision with two unconditional edges, a role with no agent, a template or subworkflow that
  does not exist, or a bad expression. An **unreachable node is an error here**, not the
  runtime's warning (#180): in an editor, a node nothing reaches is a node somebody forgot to
  connect.
- **Warning** (does not block): a field the node's type does not use (left behind by a type
  change), a decision with no conditional edges, a `parallel` with one branch, and the
  runtime's other warnings.
- **Note**: a `gate` that approves itself, with its condition.

A finding about the whole workflow (a missing start, no end node, two start nodes) has no
node to jump to: it is a row without a button, and it stays on screen whatever graph is open.
A missing start reports once, not once more for every node it leaves unreachable.

**The findings belong to one revision (#182).** They arrive with the draft, so a late answer
for an older revision never replaces a newer one. When the daemon goes away the rows stay but
the panel says `Checking`, and it never says the draft is clean until the daemon has
validated it again: on reconnecting, on a different daemon behind the window, and whenever
the configuration it was checked against changes. Publishing waits for that. A daemon with no
active configuration to check against says so as one whole-workflow error, which keeps the
draft from publishing. The live region speaks only when the draft goes from clean to having
errors or back, never on every edit.

Each rule has a fixture draft (`packages/daemon/test/workflow-draft-validation-rules.test.ts`)
that produces exactly its row from the daemon's validator, and the renderer opens each one
in the editor and presses the row (`workflow-editor-validation.test.tsx`).

**Not built yet:** the rules the runtime validator does not have. These are a `loop` with no
exit, retries above the host's concurrency, a `set` that shadows an earlier one, and a cycle
outside a `loop`, which `ai-sdlc`'s own back edges would currently trip. **Dry run** (#183)
is also still ahead. It will execute the draft against a real request with every agent turn
stubbed and gates auto-answered, and produce a run tree marked `dry run`.

## Runs in flight

**A run is pinned to the workflow version it started with.** Publishing a change affects runs
started afterwards; a run already executing finishes against the version it began on. The
draft bar states this in numbers — `3 runs pinned to v11` — and each is a link.

> This requires ORCA to record a workflow version on the run when it starts, and to be able
> to execute a version other than the newest. **As of v0.6.0 it can (#179):** the engine
> keeps every version a run starts on in the store and resumes the run on that definition;
> `WorkflowView.pinned` and `RunSummaryView.workflowPinned` (on `runs.get`) are what the
> `◷ pinned` chip reads, and `workflows.get({ id, version })` returns a pinned version's
> graph for the overlay. Runs that predate v0.6.0 have no stored definition and resume on
> whatever file is current; the warning-only fallback below is no longer needed for the
> editor. A file edited without bumping `version` still changes runs in flight.

Version is shown wherever a run's workflow is named — the run header, the workflow viewer's
overlay control, the step detail's node line — as `ai-sdlc v11`, and a run pinned to a version
that is no longer the newest says so with a `◷ pinned` chip rather than looking current.

## As built (v0.5.0) — historical

The no-stored-version statements in this section are superseded by the v0.6.0
qualification above and the [current protocol reference](../../packages/protocol/README.md).
Keep this section as the original viewer/editor design context.

The viewer shipped in #177; everything above about editing is still ahead of it. What exists,
and the two things a reader of this file would otherwise get wrong:

- **The layout engine is `packages/app/renderer/src/workflow/layout.ts`** — thirty lines of
  arithmetic, no dagre and no ELK. Layers are longest-path depth from `start` over the
  forward edges; a cycle is cut by depth-first search (an edge into a node still open on the
  stack) and drawn as a **back edge**, routed out of the source's top, level through a gutter
  above the graph and down into the target's top. Order within a layer is the barycentre of a
  node's predecessors with a stable tie-break on node id, and every box lands on a whole
  number of 16px grid steps from `node-w`, `node-h`, `layer-gap` and `rank-gap`. An
  unreachable node is laid out in a layer after the last one rather than beside `start`.
- **A collapsed `subworkflow` or `parallel` is one box with a count on it** — `2 nested
  graphs` in the node's meta line — and is collapsed by default. Expanded, each nested graph
  is drawn in a dashed group box below the canvas, named by the `parent::node::branch` id the
  daemon addresses it by, and laid out by the same function. It is not inlined: a nested
  graph has its own `start` and its own layers, and drawing it inside its container would
  move every node around it.
- **A run pinned to an older version says so twice.** The `◷ pinned` chip is in the object
  header, and a caption on the control rail names the version the run recorded *and* the
  version on screen: "This run is pinned to v2. The graph drawn is v3, the definition on
  disk — ORCA keeps no copy of the one that ran." The warning-only fallback this section
  contemplates is not what shipped, but neither is the pinned model: ORCA records the version
  and cannot execute an older one, so the viewer states both facts rather than implying it is
  showing what ran. *As of 10 October 2026 the viewer still draws the definition on disk and
  still says this, although ORCA has kept the pinned version since v0.6.0 and
  `workflows.get({ id, version })` serves it ("Runs in flight", above): the sentence is now the
  viewer's out-of-date claim, not ORCA's limit, and moving the viewer to the pinned version is
  the design-conformance review's follow-up 7.*
- **The run header carries the version, and not the chip.** `Crumb.version` (#177) prints
  `ai-sdlc v11` on the run crumb, from the `workflowVersion` the run recorded — that is the
  "shown wherever a run's workflow is named" above, on the run header. The `◷ pinned` chip is
  *not* drawn there: pinned is `run.workflowVersion` against the version on disk, and the runs
  surface has never read the definition — knowing it would mean a `workflows.get` per run in
  the tree. So the run header says the version, the viewer says whether it is pinned, and the
  crumb's counterpart menu is the way from one to the other.
- **Three strokes on the canvas, three words in the legend.** A taken edge is solid and heavy,
  an untaken one is dashed and faint, and a **back edge is dotted** — `--stroke-dash-untaken`
  and `--stroke-dash-back`, which are tokens and not two hand-written dash arrays. Rule 4:
  "runs backwards" and "was not taken" are different facts and an edge can be either, both or
  neither, so they cannot be the same stroke.
- **Every node is an `option` inside a `listbox`.** The viewport is the listbox and the one
  tab stop; the scene, the plane and each positioned box between it and the nodes are
  `role="presentation"`, because a div a reader has to walk past is a div that should say it
  is scenery. An expanded group box sits *outside* the viewport, so its plane is a `listbox`
  of its own with its own name — and it is that listbox, not the viewport, that carries
  `aria-activedescendant` when the selected node is one of its. There is still one selection:
  the surface holds one id and resolves it across the nested graphs (`findNode`), so selecting
  a node inside an expanded branch opens it in the inspector like any other.

## What the editor reuses

The canvas draws the viewer's `.orca-node` boxes and `.orca-edge` paths with the design
system's draft states (`--added`, `--changed`, `--removed`, `--invalid`, `.orca-port`,
`.orca-edge--draft`), and routes edges with the viewer's `layout.ts`. The inspector is
`ConfigField` at the inspector's narrower label column, and every field shows its YAML path.
The validation rows are `.orca-validation`, and the draft bar is `.orca-draftbar` with Undo,
Redo, Tidy, Discard and Review and publish — one line, its name and buttons keeping their
width while its summary ("your draft · 4 changes") and status give way, cut at their end and
whole in their `title` (RULES.md rule 15). The outline is `.orca-nodelist`. Choice fields are
`Menu`s, and structured values the form has no control for (artifact inputs, completion, a
decision's source) are edited as YAML in place and parsed before anything is sent.

**A node is a fixed box.** On the viewer, the editor and the plan's dependency graph, every
node is `node-w` × `node-h`, because that is the box `layout.ts` routes the edges against: a
forward edge meets a node half-way down and a back edge on its top. The kind eyebrow is one
line, the name at most two and the meta line one; each is cut at its end, never in the
middle, and the whole text is in that part's `title`. The name and the status are also in the
node's accessible name, status first, and the inspector prints the name whole. `node-h`
(96px) holds the eyebrow, a two-line name and a meta line with a status chip at the
current type sizes, so nothing is cut in half to fit. It holds them exactly: the node's
padding is 6px above and below rather than 8px so the sum lands on a 16px step, and at 8px
the box would have been 112px. The start and end pills are as tall as their text and are
centred in their slot. `renderer/test/graph-node-box.test.tsx` holds the rule, recomputes
the budget from `tokens.json` and checks `node-h` is the smallest step that fits it.

The code is in `packages/app/renderer/src/workflow/editor/` (`draft-model.ts` is the pure
part, with its own test), `packages/daemon/src/workflow-drafts.ts` and the
`workflowDrafts.*` contract in `packages/protocol/src/workflow-drafts.ts`.

## The canvas's view: zoom, direction and the minimap

The viewer's canvas, the editor's and the plan's dependency graph share one set of view
controls, in the bottom-right corner of the canvas: **zoom out**, the **zoom level** (pressing
it goes back to 100% and no pan, which is `0`), **zoom in**, **zoom to fit**, the **layout
direction** and **the minimap**, with the minimap above them. The pieces are shared rather than
copied: `ui/use-canvas-view.ts` holds zoom and pan and registers the zoom and pan keys,
`ui/canvas-controls.tsx` and `ui/graph-minimap.tsx` draw the corner, and
`ui/use-graph-preferences.ts` remembers the two toggles.

- **Zoom.** The keys, the buttons, ⌘/Ctrl with the wheel and a trackpad pinch are one zoom. The
  keys and buttons step through 25%, 50%, 75%, 100%, 150% and 200% about the middle of the
  canvas; the wheel and the pinch zoom smoothly about the pointer, within the same limits.
  **Zoom to fit** shows the whole graph, centred, at up to 100% — never magnified, because a
  three-node graph at 200% is not more of it — and at 25% a graph too wide even for that is
  centred on its middle, with the minimap for the rest. The canvas opens at rest, as it always
  has.
- **Panning.** Drag empty canvas, `⇧` with an arrow, a plain wheel or two-finger scroll, or the
  minimap. The drawing no longer scrolls natively: the viewport clips it at the canvas's height,
  so the pan is the only offset and the minimap's rectangle can be honest. A wheel moves the
  drawing to its edge and then lets the canvas scroll on to the group boxes an expanded
  container opens below it, which is what native scrolling used to reach.
- **Layout direction.** Left to right (the default) or top to bottom. The layering, the order
  within a layer and which edges are back edges are the same either way (`layout.ts`); only
  where the layers go and which sides the edges use change. Top to bottom, a forward edge leaves
  a node's bottom and enters the next one's top, and a back edge leaves by the **left** side,
  runs through a gutter beside the columns and comes back into the target's left side — the one
  side no forward edge uses, as the top is left to right — and it is still dotted. A forward
  edge's label sits just above its target rather than at the edge's midpoint, because a
  fan-out's midpoints are side by side in a gap one line tall and their conditions would print
  over each other; a back edge's label is turned to run up its gutter. An expanded
  container's group box is laid out in the same direction as the graph that holds it. The node
  box does not turn; the start and end pills sit at the edge of their slot their edges use.
  Turning the graph puts the view back at rest, and the arrows turn with it: `↓` is the next
  layer top to bottom.
- **Pinned positions in the editor stay in the horizontal frame.** The layout record
  (`.layout/<id>.json`) is shared by everybody who edits the workflow; the direction is one
  person's. So pins are always stored as they were before there was a choice, and a turned
  graph draws them through `toDirection`, which maps between the two layouts' lattices — layer
  steps along the flow, rank steps across it — rather than swapping x and y. A node pinned half
  a layer past `plan` and a rank below it is half a layer below `plan` and a rank to its right
  when the graph runs down: beside the same neighbours. A drop on a turned graph goes back
  through `fromDirection` before the `place` is sent. Turning the graph writes nothing to the
  draft, and a teammate reading left to right sees what you placed where you meant it.
- **The minimap** is the whole graph in the canvas's corner: each node a box in its tone (the
  run's status where a run is overlaid, the draft's change in the editor, the dependency's
  state on the plan), the selection in accent, and an accent rectangle for what the canvas
  shows. Click in it to centre the view there; drag the rectangle to pan. It follows the pan,
  the zoom, the window's size and the direction. It is `minimap-w` × `minimap-h`, on
  `surface-raised` with a hairline and no shadow, and can be hidden.
- **Remembered per person.** The direction and whether the minimap shows are kept in the app's
  own `preferences.json` under `canvases`, per canvas: `workflow` (the viewer and the editor,
  which are one canvas) and `plan-graph`. Never in the workflow YAML and never in `.layout/`.

The keys, the names of the controls and why the minimap is hidden from assistive technology are
in `50-accessibility-and-keyboard.md`.

**Not built yet:**

- The one-save alias for a renamed node.
- A `draft.changed` notification. A second window finds out on its next edit, by the revision
  check.
- The draft bar's count of runs pinned to the base version. The review says that started runs
  stay on it.
- Per-person concurrent drafts.
