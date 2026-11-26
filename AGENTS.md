# Working in this repo

ORCA is an orchestration runtime for coding agents. This file is the entry point for any
agent — Claude Code, Codex, Gemini CLI, or ORCA driving itself — doing work here. For the
build, test and layout conventions read `docs/DEVELOPMENT.md`; for the architecture read
`docs/ARCHITECTURE.md`; for the desktop app's design system read on.

## Before creating or reorganizing issues

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for issue planning and use the feature
template for substantial planned work. In particular:

- Inventory open and relevant closed work; reuse or cross-reference existing issues
  and build on shipped foundations rather than duplicating them.
- State outcome, scope, acceptance criteria and non-goals. Use one primary
  `ship-group:<coherent-outcome>` label for work intended to ship together, separate
  from topic labels, release bump labels and milestone decisions.
- Link actual hard blockers separately from related work; describe ordering and
  parallel work, and validate the hard-dependency graph is acyclic.
- Preserve existing metadata and history unless asked to change them. Leave milestone
  assignment for explicit release planning, and read published issues back to verify.
- A large feature with no target release is a workstream: land it on `main` behind an
  incubating flag, per [docs/WORKSTREAMS.md](docs/WORKSTREAMS.md), rather than opening a
  long-lived branch.

## Before you touch the UI

Read **`docs/design/RULES.md`** first. It is short and it is binding. The full reasoning is in
`docs/design/README.md`, and the surface-by-surface specs are the numbered files next to it.

The design system as code is the `@orca/design` workspace package (`packages/design`):

```
packages/design/
  tokens.json            EDIT: every colour, type, spacing, radius, shadow, size, motion value
  semantics.json         EDIT: the words and glyphs for statuses, schedule classes, connections
  build-tokens.js        the generator
  css/tokens.css         GENERATED — custom properties, both themes, type-style classes
  src/tokens.ts          GENERATED — typed token names, status maps, raw values per theme
  css/components.css     the component layer: token-bound classes, no hardcoded values
  src/component-api.d.ts the props each React primitive should expose over those classes
  fonts/                 GENERATED — the bundled woff2 subsets and their OFL licences
  test/contrast.test.ts  WCAG AA for every documented pairing, in both themes
  test/fonts.test.ts     every declared face has a file, every glyph has a bundled face
```

The three rules that cause the most rework if you miss them:

- **No literal colours, sizes, radii or durations in component code.** Reference a token —
  `var(--status-failed)` in CSS, `v('status-failed')` from `@orca/design` in TypeScript. If
  nothing names what you need, add it to `packages/design/tokens.json` and rebuild.
  `pnpm run lint` enforces this now, in the renderer's CSS and in inline `style={{ … }}`
  objects, and says so in the failure; `docs/DEVELOPMENT.md` has what it rejects and the
  one escape hatch.
- **`css/tokens.css` and `src/tokens.ts` are generated.** Edit `tokens.json` or
  `semantics.json`, then `pnpm run design:build`. CI rejects stale generated files.
- **There are eight run statuses and they always render a glyph and a word.** Import
  `RunStatus` and `STATUS_PRESENTATION` from `@orca/design`; never re-declare the list, never
  rely on colour alone. The glyphs come from a bundled symbol face, not from Plex and not
  from the OS — a new glyph in `semantics.json` also goes into
  `tools/font-build/build-fonts.js`, then `pnpm run design:fonts`.

## Commands

```sh
pnpm run design:build   # regenerate css/tokens.css and src/tokens.ts from tokens.json
pnpm run design:check   # fail if the generated files are behind (CI)
pnpm run design:fonts   # re-subset packages/design/fonts from the upstream releases
pnpm test               # the whole suite, including the contrast and invariant tests
pnpm run lint           # eslint, then the CSS token check (rule 1 above)
pnpm run app:smoke      # Playwright drives the built app against a demo daemon
```

## When you are asked for a screen

The component layer already exists in `packages/design/css/components.css` as token-bound
classes (`orca-tree-row`, `orca-chip`, `orca-card`, `orca-node`, …), and
`packages/design/src/component-api.d.ts` says what props each React primitive should expose
over them. Build on those rather than re-deriving values. If a screen seems to need a
component that does not exist, check `docs/design/` before inventing one — most of them are
already specced.

**A component class no longer carries a type size (#211).** `components.css` sets no
`font-size` at all: an element gets its size by *also* taking an `.orca-text-*` class
(`orca-text-caption`, `orca-text-mono-log`, …), and every rule in `components.css` carries a
`/* type: <style> */` note saying which one it expects. `class="orca-chip"` alone inherits the
shell's 14px rather than the chip's intended size, so both classes go on the element. The
sans/mono distinction, weight and colour still come from the component class — only the size
moved. And nothing in a component class may beat the type class: a `<button>`'s
`font: inherit` reset lives in a zero-specificity `:where()` rule, never in the class's own
rule, or every button and crumb renders at the shell's 14px (`font-reset.test.ts`).

Screens live in `packages/app/renderer` — React, bundled by Vite, with `tokens.css` and
`components.css` imported at the top of `renderer/src/main.tsx`. `pnpm --filter @orca/app dev`
runs it with hot reload; `docs/DEVELOPMENT.md` ("The renderer build") has the rest.

The primitives are already built: `renderer/src/ui` wraps the `orca-*` classes as
`StatusChip`, `Button`, `Chip`, `Card`, `Well`, `Text`, `Duration`, `Time`, `ConfigField`,
`ObjectHeader`, `ObjectId`, `KeyValueList`, `StateView`, `ScheduleBadge`,
`ConnectionIndicator`, `Menu`, `WorkflowNode`, `DependencyNode`, `CanvasControls` and
`GraphMinimap`, with the helpers `focusAfterLeaving` and `counted`/`unit`. Compose those
rather than writing class names, and see them all in both themes at `#preview` in a dev build
(`#type` proves the bundled faces and glyphs). If an implementation has to diverge from
`component-api.d.ts`, correct that file in the same PR.

**An id on screen is an `ObjectId`.** The object's name leads and the id follows as a faint
token — the kind's glyph and the last six characters, `Database schema ⬡ 5M579G` — with the
whole id in its `title`, in the crumb menu's **Copy id** and in the palette's matching. Never
render `{x.runId}` or slice an id yourself: `object-id-guard.test.ts` fails on a raw id in JSX
and on an id prefix that no `objectKind` in `semantics.json` decides. An event is `#seq`.

**A status is a `StatusChip`, and a surface never sizes it** — no class, no width; a column of
them is `aligned`. **Text that does not fit has one answer** (RULES.md rule 15): a chip, badge,
pill, button or crumb part is one line and as wide as its text; a count is
`counted(n, "change")`, which agrees and never splits from its noun; a bar is one line and its
lowest-priority sentence is the `.orca-truncate` that gives way, whole in `title`. A run of
chips in a card or panel is `.orca-chips` and wraps; a row never does.

**Do not drop focus.** When a control holding focus leaves — a row removed from a list, a save
bar that goes after Save, a deleted node — move focus to its neighbour (`focusAfterLeaving`)
or the region it belonged to, and only if focus went with it. The claims list, the policy
panel, `DraftBar`'s `returnFocus` and the workflow editor's delete are the worked examples.

**Say where your screen scrolls; the window will not scroll it for you.** `body` is
`overflow: hidden` and `.orca-window` is a fixed three-row grid, so a box that outgrows its
share is clipped and unreachable — no scrollbar, no wheel, no keyboard way down, and nothing
that looks like a failure (#275). The shell owns two of the answers already: `.orca-main` and
`.orca-panel` are `min-height: 0` so a surface is bounded by the window rather than stretching
past it, and `.orca-panel__body` is the dock's scroll region, so anything a surface hands up
as panel content scrolls without declaring a scroller of its own. What is left is your choice
of shape: a surface that is **a stack of content** scrolls at its root (`flex: 1` plus
`overflow-y: auto` — Attention), and a surface that is **its own split layout** bounds its
columns and scrolls the region holding the long thing (Runs, Plan, Config, Agents, the
workflow viewer). Never both, and never a scroller inside `.orca-list__scroller` — the
virtualiser windows rows against that box. `scroll-sweep.test.tsx` walks every surface in
`SURFACES` and will fail on a new one that declares neither — and because happy-dom has no
layout engine, `test/smoke/app-shell.spec.ts` shrinks a real window to 340px and *measures*
each surface and the docked panel: the box that should scroll overflows, takes a scroll to its
end, and has its last child on screen when it gets there (#277).
`docs/design/60-implementation.md` ("Scrolling is structural") has the rest, including the
floor a `VirtualList` needs inside a scrolling root.

**Every popover is a `Menu`.** Roving focus with `↑`/`↓`/`Home`/`End`, `Enter` to choose,
typeahead on a letter, focus onto the first safe item on open (never a `danger` one) and back
to the trigger on close — including on `Esc`. Placement flips rather than clips. Do not add an
`Escape` handler, an outside-click listener, a `tabIndex` dance or a `useState` for open: all
of that is the primitive's, and a second implementation is the thing #202 exists to prevent. If
a popover's body is not a list of choices, extend `Menu` rather than growing a rival — the
keyboard and focus contract has to stay in one place. A menu stands on `surface-raised`, never
on `surface-overlay` (a modal's scrim). A `danger` item leads with `✕`, is never listed first
and never focused on open; an item's `hint` is a one-word meta, `hintMachine` is machine text
in mono and never re-cased, an object's id is `labelId`, and a sentence is the menu's `note`.
**A destructive act with no way back confirms on the row** — a second state of it, Keep first
and focused, ✕ Confirm in the danger tone, the consequence on the row's two-line variant, the
way the palette and the Agents claims list do — rather than in a popover over the list. **An
edit to a draft does not confirm**: Remove a grant, Delete a node are plain buttons, because
Save, Discard and Undo are the way back, and a resting screen carries no danger tone.

**Every pane boundary is a `PaneSplitter`.** A screen with two panes does not state a width for
either of them: the track is `var(--pane-<boundary>, var(--<token>))` and a `<PaneSplitter>` sits
in the `auto` track between them (#276). The registry of boundaries, the clamp and the only code
that writes a `--pane-*` property are `renderer/src/panes.ts`; the limits are tokens
(`PANE_GEOMETRY`), not numbers in a component; the size is remembered per boundary in the app's
preferences the way density is remembered per surface. Two panes of the same kind share one
boundary id and so one remembered width — the docked panel and the workflow inspector do. A
splitter needs nothing but its position in the markup: it is a child of the container whose track
sizes the pane, with that pane as its immediate sibling, which is where it reads the size from and
where it writes it to. The boundary's hairline is the splitter's; a pane beside one draws no border
of its own, or the window gets two lines two pixels apart. **A boundary says whether its size is a
length or a ratio (#281):** a column boundary is remembered in px, and a *stacked* one — the run
tree over the event timeline, and every stacked split after it — is remembered as a fraction of
its container and applied as a percentage, because what a person chose there is "more tree than
timeline" and a length does not travel between two window heights. The drag, the keys, the clamp
and `aria-valuenow` stay px either way. A dragged size is also **listed in Config's App
preferences with a restore**, and the palette has a keyless command that restores them all (#280):
it is the one remembered appearance a drag can set by accident.

**Lists do not poll. The daemon pushes.** `window.orca.notifications.subscribe` is the raw
envelope stream; wrap it with `createNotificationStream` (`renderer/src/notifications.ts`)
and listen to one method — `run.changed`, `step.changed`, `agent.update`, `input.opened`,
`input.answered`, `event.appended`, `agent.changed` — with an optional `runId` filter. For run
patch notifications, do not re-read the whole list; a notification for an object the list has
never seen is resolved with one `runs.get` and inserted. Every *run* notification carries
`seq`, the cursor, and the main process owns reconnection and resume, so a screen only has to
unsubscribe when it goes away. `agent.changed` is the one that is not about a run: it carries
no `runId` and no `seq`, it goes only to a store-wide subscription, and it carries the whole
`AgentView` — so there is nothing to resolve and nothing to resume (#241). Agent output arrives coalesced (one `agent.update` per step per 100ms, many lines
inside) — render the batch, do not assume one line per frame. And a push can never tell you
a run went `stale`: that is a lapsed lease, which is nothing happening, so it shows up only
on a read.

`plan.changed`, `config.changed` and `workflows.changed` are scoped invalidations,
not full-object patches: their consumers reread the affected snapshot. Reconnect generation
changes can require fresh reads too. Keep these recovery reads separate from periodic polling;
not every data family yet has a complete reconnect convergence contract.

**The connection is pushed too, and it is a different channel.** `window.orca.connection`
(`read()` for the snapshot, `subscribe()` for the changes) carries
`{ state, since, eventCursor?, versions?, orcaVersion?, capabilities? }`, where `state` is one
of the design's five. Do not derive a connection state from a failed call, and do not probe
with a `hello` of your own: the main process owns the machine (`src/main/connection-state.ts`),
which is the one place `SubscriptionState` and the handshake are folded onto those five. A
screen reads it through `useConnection()`. **Leaving `live` is held silent for five seconds**,
so a blip changes nothing on screen — that is the machine's, not a component's, and a
component that re-implements it will double the delay.

**Ask whether you can write; do not find out by failing.** `useWritability()` derives
"can write, or why not" from the connection state plus whether `runs.control` is in
`hello.capabilities`. A daemon started `--read-only` omits the capability *and* the methods,
so absence is a normal, explainable state and never an error. The `reason` string is shaped
for `Button`'s `disabledReason`; a control must not compose its own.

**A list of rows is `VirtualList`, not a `map`.** `renderer/src/list/` is the substrate every
row list in the app is built on: it renders a window over the rows, reads the row height back
off `--row-h` rather than restating it (so `data-density` needs no special case), carries the
status minimap gutter over the *whole* list rather than the visible window, and registers
`J`/`K`, the arrows, `Home`/`End` and the page keys on the `KeyboardMap` in the scope its
`scope` prop names. Because those registrations are the substrate's, **one scope holds one
`VirtualList`** — a second list in the same scope registers `J` twice and the map will throw,
which is the intended way to find out. The scopes to have are `list` (the default),
`run-tree` and `stream`, so a screen can be a run tree above a timeline beside a stream of
output and `J` still means "next" in whichever one the focus is in, plus `plan-journal` for
the journal beside the schedule and `plan-graph` for the plan's dependency canvas, which
has the workflow canvas's keys and cannot share its scope. A further list on one screen is
not a missing scope. Both canvases draw through one layout, `renderer/src/workflow/layout.ts`'s
`layoutGraph` over a plain `{ nodes, edges }` graph with many roots; `layoutWorkflow` is an
adapter over it, and there is no layout dependency. Selection is `aria-activedescendant` on a single tab stop, and it is a different visual
from focus (rule 10). The rows are a `listbox` of `option`s unless `role` makes them a
`tree` of `treeitem`s or a `grid` of `row`s, and in every case the roles are the substrate's,
because the row element is: a surface reaches the row's *children* through `renderRow`, and
adds `aria-level` and `aria-expanded` through `rowProps`. Reach for `grid` when the rows hold
*controls* — the plan's schedule table does — because a button inside an `option` is a button
nothing can reach, and the cells then carry `role="gridcell"`. A list that pages backwards calls `shiftBy(rows)` on the
ref after a prepend, or it throws a person back by exactly the page they asked for; a stream
takes `follow` and hears `onHold` once when a scroll leaves the end.
`renderer/src/runs/` is the worked adoption: there is no `scrollIntoView` anywhere, because it
cannot reach a row that is not in the document.

`renderer/src/runs/` is the worked example of a surface and the shape the next one should
take: the arithmetic in a plain module with a plain test, the data in one hook, selection and
its keys in another, and the markup composed from `ui/`. It is now three lists on one screen —
`runs/tree/` over `runs/timeline/` on the left, `step/` on the right with `artifacts/` in the
dock — and that is the shape to copy, one directory per thing with its own plain module and
plain test. Filtering is a filter, not a search — status is a `runs.list` parameter the daemon
applies to the whole store, text is applied locally to what is held, and the count says which
("3 of 7 runs").

`renderer/src/attention/` is the second surface in that shape and the first that writes, with
one deliberate deviation: a card is not a row, so the cards are not virtualised — what is
bounded there is the number of things blocked on a person — while the failed runs below them
are rows and are a `VirtualList`. Its plain module is `card-model.ts`, and what is in it is
the safety half: which option gets which digit (never `1` for the destructive one) and what an
"always" answer is allowed to promise once the daemon has said what it actually wrote. The
same two cards mount inline in step detail over the same feed (`attention/inline-asks.tsx`),
so a gate answered in the run and a gate answered in the list are one read, one component and
one count.

`renderer/src/config/` has the same deviation for the same kind of reason: the permission
rows are a `map` rather than a `VirtualList` because what is bounded there is the number of
rules one agent has, and they are still rows — `--row-h` tall and never wrapping (rule 9).

`renderer/src/config/` is the third, and the first that edits a *file*: a plain
`config-model.ts` (schema to sections, draft to patch, an error to the field it belongs on),
one hook holding both documents and the drafts over them, and the markup composed from
`ui/`. Two rules it sets for anything that writes a document — a draft is the edits and
never a copy of the file, because a copy has to decide what every untouched key is; and a
refused write keeps the draft, since `CONFIG_STALE` is somebody else having saved, which is
a thing to say and not a reason to throw away what a person typed. Its save bar
(`.orca-draftbar`) is the one the workflow editor reuses rather than redraws.

`renderer/src/a11y/` is not a surface. It holds the **one** polite live region the whole app
announces through, mounted once by `App` and fed by listening to the feed the surfaces already
hold — a listener, never a second subscription. Its plain module is `announcements.ts`, which
folds a `run.changed` or `step.changed` into one sentence **or into nothing**: transitions and
terminal states only, per `docs/design/50-accessibility-and-keyboard.md`, because a region that
spoke on every frame would be the streaming-output mistake in another place. A surface that
wants to announce something adds to that fold; it does not add a region. What the daemon
never pushes — a write this app made, or a write it refused — goes through `useAnnounce()`
(`a11y/announce.ts`), which is one channel into that same region and not a second one. `a11y-sweep.test.tsx`
asserts there is exactly one, and that it is the same element across every surface.

**Every shortcut goes in the keyboard map.** Register `{ scope, key, label, action }` on the
`KeyboardMap` (`renderer/src/keyboard-map.ts`) rather than adding a `keydown` listener — the
command palette is a view of that registry, so a shortcut that skips it is a shortcut nobody
can discover. **`key` is optional (#205):** a command worth doing but not worth one of the
letters left registers without one, takes a slot of its own, and the palette lists it with no
chip beside it — which makes the palette the only way to it, deliberately, rather than making
it unreachable. Mark the subtree that owns a scope with `scopeProps("run-tree")`; `Esc` belongs
to the layer stack, not to your component. `docs/design/60-implementation.md` has the rest.

The app (`packages/app`) may import only `@orca/protocol` and `@orca/design` from the
workspace — the renderer included; everything it knows about a run comes over the wire from
the daemon (ADR 0008).

## When the data is not there

ORCA cannot currently supply a run completion percentage, an estimated time remaining, or
agent cost. Do not approximate them, and do not add a placeholder. Say so in the PR.
`docs/design/60-implementation.md` has the standing list.

## Keeping the rendered version honest

`packages/design` and `docs/design` are the source of truth. There is also a rendered version
of the system — live previews, both themes, the key screens — as a Claude artifact, used for
visual review. It does not feed the build and nothing here reads from it. When the files
change materially, ask for it to be republished from these folders; do not treat it as an
authority when the two disagree.
