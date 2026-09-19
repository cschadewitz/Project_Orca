# Workflow editing

The viewer ships first; editing is a later phase. This section specifies it now so the
viewer's components do not have to be redrawn when it arrives — and so the two decisions that
are hard to change later (what editing manipulates, and what happens to runs already in
flight) are settled before code exists.

## The model: structured edits, derived layout

**You edit a list and a form. The graph follows.**

The workflow is a file of nodes and edges. The editor presents that file as an ordered node
list on the left and an inspector on the right; the canvas in the middle re-lays out after
every change and is never dragged. Selecting a node in the list selects it on the canvas and
opens it in the inspector, and the reverse; there is one selection.

This is the decision everything else follows from, and the reason for it is the file. A
dragged graph has to persist coordinates somewhere — either in the workflow file, where they
pollute every diff and mean nothing to the daemon, or in a sidecar that silently drifts once
someone edits the YAML by hand. Deriving layout means a workflow authored in ORCA and one
hand-written in an editor are the same file, a diff shows only semantic change, and the app
never owns state the daemon does not know about.

What it costs: you cannot express intent through arrangement. That is acceptable here,
because these graphs are small (the shipped `ai-sdlc` is eleven nodes) and their shape is
already meaningful — layers are dependency depth, not taste.

**Editing operations.**

| Operation | Where | Result |
| --- | --- | --- |
| Add node | Palette in the list header, or `⌘⏎` on a selected node to insert after it | Node appended with a generated name, inspector focused on the name field |
| Rename | Inspector, or `F2` in the list | Every edge referencing it updates; the old name is offered as an alias for one save |
| Reorder | Drag in the list, or `⌥↑` / `⌥↓` | Edges are unaffected — list order is file order, not execution order |
| Connect | Inspector's **next** field, or `C` with a node selected then pick a target | Edge added; the canvas re-lays out |
| Branch | Inspector's branch table on a `decision` node | One row per branch: condition expression, target node, label |
| Delete | `⌫` in the list | Node marked removed in the draft; edges into it become dangling and raise a validation error, never silently reroute |
| Change type | Inspector's type select | Fields the new type does not use are kept in the draft and flagged, not dropped |

**Direct manipulation that is still available:** pan and zoom, selecting a node or an edge,
and collapsing a `subworkflow` or `parallel` node's children. Nothing that changes the file
happens by dragging on the canvas.

## Drafts

Editing does not touch the live file. Opening the editor creates a **draft** of the workflow,
named and owned by the person who made it, stored beside the workflow rather than in it.

```
workflows/ai-sdlc.yaml              the live file
workflows/.drafts/ai-sdlc@casey     the draft, until it is published or discarded
```

A draft is a full copy plus a change set, and the editor renders both at once: added nodes
take `status-succeeded` borders on `status-succeeded-bg`, changed nodes take `accent`,
removed nodes are dashed in `status-failed` with their name struck through, and new edges are
drawn dashed in `accent`. This is the second reason the layout is derived — a draft and a
live file that lay out identically can be diffed by eye.

**Publishing** requires validation to pass and shows a YAML diff of the whole change set.
Discarding is one action and asks once. A draft is never auto-published, never
auto-discarded, and survives the app closing.

**One draft per workflow per person.** If another draft exists when you open the editor, the
app says who has it and offers to open theirs read-only rather than starting a competing one.

## Validation and dry run

The validation panel is docked under the canvas and is always present — empty when the draft
is clean, because a panel that appears and disappears is a panel people stop watching.

Three severities, and every row names the node and jumps to it:

- **Error** (blocks publish) — a dangling edge, an unreachable node, a `decision` with no
  default branch, a `loop` with no exit, a `gate` whose option list is empty, a role with no
  eligible agent, a subworkflow that does not exist, a cycle that is not inside a `loop`.
- **Warning** (does not block) — a node no edge reaches from `start`, a `parallel` with one
  branch, a retry count above the host's concurrency, a prompt template that does not exist
  yet.
- **Note** — a `gate` marked auto-approve, a `set` that shadows an earlier one.

**Dry run** executes the draft against a real request with every agent turn stubbed: no
agents are contacted, no artifacts are written, gates auto-answer with their first option.
It produces a real run tree in the run viewer, marked `dry run` throughout, which is how you
find out that a decision expression never takes its second branch. Dry runs are events like
anything else and appear in the timeline, tagged so they can be filtered out.

## Runs in flight

**A run is pinned to the workflow version it started with.** Publishing a change affects runs
started afterwards; a run already executing finishes against the version it began on. The
draft bar states this in numbers — `3 runs pinned to v11` — and each is a link.

> This requires ORCA to record a workflow version on the run when it starts, and to be able
> to execute a version other than the newest. If it cannot today, this is the design's one
> hard ask of the runtime. Without it the honest fallback is the warning-only model, where
> publishing changes a running workflow underneath its run — in which case the draft bar must
> say exactly that, in those words, and the publish button becomes destructive-toned.

Version is shown wherever a run's workflow is named — the run header, the workflow viewer's
overlay control, the step detail's node line — as `ai-sdlc v11`, and a run pinned to a version
that is no longer the newest says so with a `◷ pinned` chip rather than looking current.

## What the editor reuses

Everything except the node list and the ports. The canvas is the workflow viewer with an
extra set of node states; the inspector is `ConfigField` at a narrower label column; the
validation rows are timeline rows with a severity rail; the draft bar is the config editor's
save bar with two more actions. The editor adds three components — node list, inspector shell,
validation panel — and no new foundations at all.
