# Implementation notes

## Everything is a custom property

`tokens.css` (generated from `tokens.json`) declares light on `:root` and dark under
`[data-theme="dark"]`. The theme attribute goes on `<html>` and nothing reads the theme in
JavaScript except the code that sets that attribute. Because the dark block is an attribute
selector, any subtree can be themed independently — that is how the documentation previews
show both themes side by side, and it is also how a light-on-dark preview pane inside the app
would work if one is ever needed.

```css
:root { color-scheme: light dark; }
:root[data-theme="dark"] { color-scheme: dark; }
```

Set `color-scheme` so native scrollbars, form controls and the Electron window background
match; a light scrollbar on a dark pane is the most common symptom of skipping this.

## The class layer

`packages/design/css/components.css` is the reference implementation of every component in this system as
token-bound classes, with no JavaScript and no hardcoded values. It is deliberately CSS-only:
this app will be built by developers in React, and a CSS layer they can adopt piecemeal is
more useful than a component bundle they must wrap. Names are `orca-` prefixed and BEM-ish
(`orca-chip`, `orca-chip--failed`, `orca-tree-row__label`).

`packages/design/src/component-api.d.ts` describes the props the React layer should expose
over those classes. It is documentation, not a shipped type package.

## Density

Density is one attribute, `data-density="compact"`, set on a surface's root element. It
rebinds `--row-h` from `row-comfortable` to `row-compact` and tightens two paddings. Nothing
else changes — no font size, no icon size — because the point of the toggle is more rows per
screen, not smaller text.

## Virtualised rows

Rows are fixed height by token, which lets the virtualiser compute offsets arithmetically. Two
consequences the implementation must respect: a row never wraps, and a row never grows for its
content. Anything that needs more than one line is a two-line row variant with its own token
height, declared as such, not an ordinary row that happens to be taller.

## Event-sourced rendering

The event log is the source of truth and the UI is a projection of it. Two implications for
the design:

- **Every view has a cursor.** The status bar shows the event the UI is projected up to. A
  screen is never "current" in the abstract; it is current as of event *n*.
- **Replay is the same code path as live.** Opening a finished run replays its events into the
  same components that render a live one. There is no separate "historical" rendering, which
  is why the timeline and the output pane must read well both while updating and at rest.

## Streaming

Agent output arrives as ACP updates over the WebSocket. Batch renders to one frame per 100ms
under `requestAnimationFrame`; a per-token DOM write will cost more CPU than the agent does.
Append to a detached fragment and commit once per frame. Do not re-render the run tree on
every agent update — step status changes are a different, much rarer event stream, and the
tree should subscribe only to those.

## What the design assumes ORCA can provide

Everything in these screens maps to something described in the ORCA model: events, steps,
attempts, artifacts and versions, run trees, gates and their option lists, permission asks,
work items and their dependencies, risks with likelihood and impact, decision matrices with
criteria and weights, scheduler classifications and explanations, the journal, hosts, agents,
roles, policies and claims.

Three things the mockups show that the described model does **not** obviously supply. Each is
called out on the screen that needs it so nobody implements a placeholder by accident:

1. **Progress percentage for a run.** The run tree shows an indeterminate meter, not a
   percentage, because a workflow graph with loops and conditional branches has no well-defined
   completion fraction. If ORCA can produce an expected step count per workflow, this becomes
   a determinate meter; until it can, it stays indeterminate by design.
2. **Estimated time remaining.** Not shown anywhere. Deriving it would need historical step
   durations per workflow node, which the event log could supply but which is not part of the
   described model. Elapsed time is shown instead.
3. **Agent cost or token usage.** Not shown. ACP does not necessarily carry it and the model
   does not mention it. If it becomes available it belongs in the step detail header beside
   duration, and the layout leaves room for exactly one more metric there.
