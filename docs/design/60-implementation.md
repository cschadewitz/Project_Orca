# Implementation notes

## Everything is a custom property

`tokens.css` (generated from `tokens.json`) declares light on `:root` and dark under
`[data-theme="dark"]`. The theme attribute goes on `<html>` and nothing reads the theme in
JavaScript except the code that sets that attribute. Because the dark block is an attribute
selector, any subtree can be themed independently — that is how the documentation previews
show both themes side by side, and it is also how a light-on-dark preview pane inside the app
would work if one is ever needed.

```css
:root, [data-theme="light"] { color-scheme: light; … }
[data-theme="dark"] { color-scheme: dark; … }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark; … } }
```

`color-scheme` travels with every block the generator emits, so native scrollbars and form
controls match whether the theme was chosen or followed from the OS; a light scrollbar on a
dark pane is the most common symptom of skipping this. The Electron window's own
background — painted before any CSS has loaded — is `surface-canvas` from `rawTokens` for
the resolved theme, set by the main process, so opening in dark does not flash white.

In the app, `packages/app/renderer/src/theme.ts` is the only code that touches
`data-theme`, and `main.tsx` applies it before React mounts so the first paint is already
right. The preference (`system`, `light`, `dark`) lives in the app's own `preferences.json`,
not the ORCA YAML; `⌘⇧L` cycles it and the main process mirrors the choice into
`nativeTheme.themeSource`, so the OS-drawn chrome follows too. `AppearanceProvider` gives
React components the actions (cycle, toggle, refresh) and nothing to read.

## The class layer

`packages/design/css/components.css` is the reference implementation of every component in this system as
token-bound classes, with no JavaScript and no hardcoded values. It is deliberately CSS-only:
this app will be built by developers in React, and a CSS layer they can adopt piecemeal is
more useful than a component bundle they must wrap. Names are `orca-` prefixed and BEM-ish
(`orca-chip`, `orca-chip--failed`, `orca-tree-row__label`).

`packages/design/src/component-api.d.ts` describes the props the React layer should expose
over those classes. It is documentation, not a shipped type package.

The React layer itself lives in `packages/app/renderer/src/ui` — the foundation set every
surface uses (status, text, controls, the object header, the state views) — and `#preview`
in a dev build renders all of it in both themes side by side. Primitives that belong to one
surface arrive with that surface; the shared ones belong here. When an implementation has to
diverge from `component-api.d.ts`, that file is corrected in the same change, so it stays a
description of what exists rather than a draft of what was once intended.

## Density

Density is one attribute, `data-density="compact"`, set on a surface's root element. It
rebinds `--row-h` from `row-comfortable` to `row-compact` and tightens two paddings. Nothing
else changes — no font size, no icon size — because the point of the toggle is more rows per
screen, not smaller text.

A surface root is the element carrying `data-surface="<id>"` (`attention`, `runs`, `plan`,
`agents`, `config`). `⌘⇧D` toggles the surface that contains focus and the choice is
remembered by that id in the app's preferences, so the run tree can be compact while the
config form stays comfortable. `packages/app/renderer/src/density.ts` is the only code that
touches the attribute; a component that renders a surface root calls `useSurfaceDensity()`
so it gets its remembered density once it is in the document.

## The keyboard map and the palette

There is one registry and the palette is a view of it. A component registers
`{ scope, key, label, action }` on the `KeyboardMap` for as long as it is mounted
(`packages/app/renderer/src/keyboard-map.ts`); `⌘K` lists every registration with its key
beside it. That is the mechanism behind "every action in this map is also in the command
palette" — not a second table that has to be kept in step.

**The key is the optional part (#205).** The design's key table is deliberately short, and a
command worth doing but not worth one of the letters left registers without a key: it takes a
slot of its own, nothing can dispatch to it, and the palette draws its row with no chip. The
palette is then the only way to it, which is a decision about how prominent the command is
rather than an admission that it is unreachable. **Cancel the run this is waiting on** and
**Resume the run this is waiting on** are the first two.

Three rules fall out of it:

- **Scope comes from focus, not from a mode flag.** A component that owns a scope marks its
  subtree with `data-kbd-scope="run-tree"` (`scopeProps` writes the attribute), and a press
  is offered to each scope from the focused element outwards before `global`. Two surfaces
  may therefore both bind `F`. Binding it twice in *one* scope throws at registration
  rather than picking a winner at dispatch.
- **In a text entry only modified keys and `Esc` dispatch.** `J` in the palette's query
  field is a letter, not a selection move three layers below it.
- **`Esc` is one shortcut over a stack, not a handler per component.** Layers push
  themselves onto `LayerStack` while they are open, and `Esc` closes the one that opened
  last. A layer holding text a person typed and has not sent reports `hasUnsentDraft` and
  the key is swallowed instead — the second half of the rule, and the reason the stack
  exists rather than a boolean.

The palette's own rows come from two places. Commands come from the map. Objects — recent
runs, work items, agents, config files, workflows — and search results come from sources
the surfaces register (`palette/sources.tsx`), because that data belongs to the surface
that holds it. Three are registered as of #206 — recent runs, agents, and search over step
and artifact names — and they sit beside the palette (`palette/object-sources.tsx`) rather
than inside a surface, because they are reads of the store rather than views of what a
surface holds. Every row hands back a canonical `orca://` URL and is opened through the
route table, which is what keeps one resolver for links, crumbs and palette rows alike.

Focus stays in the query field for as long as the palette is open. The highlighted row is
*selection* — `aria-activedescendant` on the field, the accent rail on the row — which is
why it does not draw the focus ring.

## Popovers are one primitive

`Menu` (`renderer/src/ui/menu.tsx`) carries the whole popover contract, once, and every
popover uses it — the crumb's counterparts today, the schedule badge's explanation, the
artifact version menu and the risk cell's detail as they land.

`↑`/`↓` move with wrapping, `Home`/`End` jump, `Enter` chooses, a letter jumps to the next
item starting with it. Focus moves onto the first item on open and back to the trigger on
close — a choice, a second press on the trigger, or `Esc`. The one exception is a press
*outside*: focus is already going where the person clicked, and dragging it back would fight
them. A `disabled` item is shown and named but skipped by the arrows, because a menu never
hides what it cannot do; an empty item list renders no trigger at all, because a disclosure
onto nothing is worse than no disclosure.

The arrows, `Home`, `End` and `Enter` are registered on the `KeyboardMap` in a `menu` scope,
so the palette lists them and innermost-first resolution stops them colliding with the
`↑`/`↓` of a list underneath; they are registered only while a menu is open, and refcounted,
since two open menus must not be a double-binding error. **Typeahead is deliberately not in
the map**: a letter in a menu is typing into the widget, not a command — it has no stable
label, and A–Z would bury the commands that matter. `Esc` is not the component's at all; the
menu pushes onto the layer stack and the one global `Esc` closes the topmost.

**Placement flips rather than clips.** `placeMenu` is a pure function from the trigger rect,
the menu's size and the viewport to `{ block, inline }`, which the component turns into
`.orca-menu--above` / `.orca-menu--end`. Being pure is what makes it testable with real
numbers under a DOM that has no layout engine; the measurement is injectable for the same
reason. A menu larger than the window does *not* flip — both sides clip, and moving it would
only cost it the tie to its trigger.

## The type and glyph proof

`#type` in a dev build (`renderer/src/preview/type-proof.tsx`) is where the bundled faces get
checked. The font build proves every declared file contains every codepoint claimed for it;
only a renderer can show the glyphs look right next to the words, at chip scale, in both
themes. Every type style in `tokens.json` with real sample text, the eight statuses as chips
and as bare glyphs, the connection states, two ids per row in `mono-id` so the tracking can
be read, and `mono-log` output with the box-drawing rules the stream uses.

Nothing on it is re-declared — the scale comes from `tokens.json`, the glyphs from the
presentation maps — and a test reads those sources off disk, so the page cannot quietly stop
covering a style or a glyph.

Its point is the **bundled-faces toggle**, which swaps the declared stacks for the same
stacks minus every bundled family. The failure this catches is silent: a glyph that falls
through to the OS still renders, just in a different typeface, and nobody notices in a
screenshot taken on the machine that happens to have the font. The rule for reading it:
anything that does not change when you flip the toggle was never coming from a bundled face.

## Virtualised rows

Rows are fixed height by token, which lets the virtualiser compute offsets arithmetically. Two
consequences the implementation must respect: a row never wraps, and a row never grows for its
content. Anything that needs more than one line is a two-line row variant with its own token
height, declared as such, not an ordinary row that happens to be taller.

`renderer/src/list/` is that virtualiser (#155), and the arithmetic is a plain module with a
plain test (`list-window.ts`). The height is *read back* off `--row-h` from the scroller's
computed style rather than restated in TypeScript, which is what makes `data-density` an
ordinary re-measure rather than a special case, and what stops a second statement of a token
from drifting from the first. A viewport nothing has measured — first frame, a hidden pane, a
DOM with no layout — is an ordinary case and not an error: with no pixels to divide by, the
window is a fixed *count* of rows around an anchor. Dividing by a zero row height would render
all 50,000 rows, which is the freeze the virtualiser exists to prevent, and substituting a
guessed height would be the second statement the design forbids.

Two-line rows are `.orca-list--two-line`, whose height is `calc(var(--row-h) * 2)` — a ratio to
the bound height, never a literal. The component layer has no two-line row class and
`tokens.json` has no second row height; both belong there, beside the row they vary.

## Event-sourced rendering

The event log is the source of truth and the UI is a projection of it. Two implications for
the design:

- **Every view has a cursor.** A screen is never "current" in the abstract; it is current as
  of event *n*.

  The cursor is **per run, and it is drawn beside the run it describes** — the event
  timeline's sticky header reads "as of event *n*", from `runs.events`'s `lastSeq` and the
  highest `seq` the surface has applied (#157).

  **The status bar's cell stays empty**, and that is settled rather than pending. Sequence
  numbers are per run and the app holds one store-wide subscription, so there is no single
  number for a bar that outlives any one run's selection to show; an invented one is what
  rule 12 forbids, and a zero would be a lie. The connection snapshot still carries
  `eventCursor` through a reconnection and a test proves it resumes — that is the machine's
  guarantee, not a number for the chrome to print.
- **Replay is the same code path as live.** Opening a finished run replays its events into the
  same components that render a live one. There is no separate "historical" rendering, which
  is why the timeline and the output pane must read well both while updating and at rest.

## Streaming

Agent output arrives as ACP updates over the WebSocket. Batch renders to one frame per 100ms
under `requestAnimationFrame`; a per-token DOM write will cost more CPU than the agent does.
Commit once per frame. Do not re-render the run tree on every agent update — step status
changes are a different, much rarer event stream, and the tree subscribes only to those.

Two things the implementation settled (#158), both worth knowing before writing a second
streaming surface:

- **A row is a line; the buffer counts events.** The output pane virtualises over lines at
  `row-log`, because a fixed row height is what makes a window over a stream possible at all
  — so a line longer than the pane collapses to a count of what was left off rather than
  wrapping into a second row nothing has accounted for. The *buffer*, though, is 50,000
  **events**, per `30-long-running-content.md`: one `agent.update` renders many lines, so
  that is a larger buffer than 50,000 lines, not a smaller one.
- **A line's number is its event's `seq`, not an ordinal.** Once the buffer has trimmed, or a
  page has been loaded in front of it, there is no absolute line number ORCA can supply — so
  the gutter shows the sequence number the line came from, and it repeats when one update
  rendered several lines. That is what makes the trim boundary addressable.

**The docked panel has an owner.** The artifact it holds is a context at App level, not state
inside a surface, so a chip on a step, a gate card and an `orca://artifact/spec.md@v3` deep
link can all put one there. Opening the panel itself stays the chrome's.

## The shape of a surface

`renderer/src/runs/` is the first surface with real data behind it and the shape the others
should take. Four files, and the split is the point: the arithmetic most likely to be wrong
and least well read by a DOM test (ordering, the text filter, folding a notification into a
row) is a plain module with a plain test; the data is one hook; selection and its keys are
another; the markup is composed from `ui/`.

**A surface never polls and never re-reads a list because a notification arrived.** One read
on mount and per filter change, then the stream. A notification about an object the list has
never seen is resolved with a single read *scoped to that object* and inserted in order — a
`run.changed` carries a status and a cursor, not a name or a creation time, so there is no row
to draw from it alone, and an `input.opened` carries the question but not the run's name, how
long it has waited or the artifacts the decision is about. One `runs.get`, or one
`inputs.list` for one run; never the list again.

Attention is the second surface in this shape and departs from it in one place, deliberately:
its cards are not rows, so they are not virtualised. What is bounded there is the number of
things blocked on a person, which is a number somebody is already unhappy about; the failed
runs below them are rows and are a `VirtualList`.

**Filtering is a filter, not a search** — the IA rules out a global search screen. The halves
differ deliberately: a status filter is a list parameter, so the daemon applies it to the
whole store; a text filter is applied locally to what is already held, because the protocol
has no text parameter and a "search" that only saw the current page would be a lie. Say
which in the count: "3 of 7 runs".

Every `StateView` kind is reachable and each means one thing — `loading` while the call is
out, `error` when the daemon answered badly, `disconnected` when there is no daemon at all,
`empty` when the store is genuinely empty, `no-results` when a filter emptied it. With rows
already in hand, a lost connection keeps them, marks them stale and **stops the clock**: an
elapsed time accruing against a daemon that is not talking is an invented number, which
rule 12 forbids as much as any other invented value.

## Writing, and the alerts that come of it

**A control asks whether it may write; it does not find out by failing.** `useWritability()`
folds the connection state together with whether `runs.control` is in `hello.capabilities`
into "can write, or why not", and the `reason` is shaped for `Button`'s `disabledReason` so no
control composes its own sentence. A daemon started `--read-only` omits the capability *and*
the methods, which is why file mode needs no second code path: the buttons are already gone.

**The OS half is in the main process and is Electron-free.** `src/main/alerts.ts` holds the
timing — the tier table's immediate / 60 seconds / on failure, the unfocused escalation, the
coalescing — behind an `AlertsPort` the main process implements over `Notification` and
`app.dock`, so the part with the rules in it is a plain module a test drives with fake timers.
The renderer hands it what is open and it diffs; the badge it sets is the same one count the
title bar shows. The gate's delay is measured from when the gate was *asked*, not from when
this process heard about it, so an app opened onto a ten-minute-old gate has already missed
it. There is no "show the window" call on the port at all — that is how "a permission ask may
take attention only inside a window that already has focus, and nothing raises a window at
anybody" is guaranteed rather than remembered. A click comes back with the item it was about
and is resolved through the route table, like every other way of arriving at an object.

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
