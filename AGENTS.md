# Working in this repo

This file is for any agent working in this repo: Claude Code, Codex, Gemini CLI, or ORCA
driving itself. It lists the rules you must follow before you plan issues or touch the UI.
ORCA is an orchestration runtime for coding agents.

Read next:

| For | Read |
| --- | --- |
| Build, test and layout conventions | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| Architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| UI rules (binding) | [docs/design/RULES.md](docs/design/RULES.md) |
| Issue planning | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Before creating or reorganizing issues

Follow [CONTRIBUTING.md](CONTRIBUTING.md). Use the feature template for substantial planned
work.

1. Inventory open and relevant closed work. Reuse or cross-reference existing issues. Build on
   shipped foundations; do not duplicate them.
2. State outcome, scope, acceptance criteria and non-goals.
3. Give work that ships together one primary `ship-group:<coherent-outcome>` label. Keep it
   separate from topic labels, release bump labels and milestones.
4. Link hard blockers separately from related work. Describe ordering and parallel work.
   Check that the hard-dependency graph has no cycles.
5. Keep existing metadata and history unless asked to change them. Leave milestones to
   explicit release planning.
6. Read published issues back to verify them.
7. Treat a large feature with no target release as a workstream ([docs/WORKSTREAMS.md](docs/WORKSTREAMS.md)).
   By default, land it on `main` in small pull requests behind an incubating flag. Use a
   `feature/<name>` branch only when the work cannot safely ship dark: an outside sign-off gates
   even dark code, or a store or protocol break cannot be hidden. Say which in the tracking issue.

## Before you touch the UI

Read **[docs/design/RULES.md](docs/design/RULES.md)** first. It is short and binding. The
reasoning is in `docs/design/README.md`; the numbered files next to it specify each surface.

The design system as code is the `@orca/design` package (`packages/design`):

```
packages/design/
  tokens.json            EDIT: every colour, type, spacing, radius, shadow, size, motion value
  semantics.json         EDIT: the words and glyphs for statuses, schedule classes, connections
  build-tokens.js        the generator
  css/tokens.css         GENERATED: custom properties, both themes, type-style classes
  src/tokens.ts          GENERATED: typed token names, status maps, raw values per theme
  css/components.css     the component layer: token-bound classes, no hardcoded values
  src/component-api.d.ts the props each React primitive should expose over those classes
  fonts/                 GENERATED: the bundled woff2 subsets and their OFL licences
  test/contrast.test.ts  WCAG AA for every documented pairing, in both themes
  test/fonts.test.ts     every declared face has a file, every glyph has a bundled face
```

The three rules that cause the most rework:

1. **No literal colours, sizes, radii or durations in component code.** Use a token:
   `var(--status-failed)` in CSS, `v('status-failed')` from `@orca/design` in TypeScript. If
   no token fits, add one to `packages/design/tokens.json` and rebuild. `pnpm run lint`
   enforces this in the renderer's CSS and in inline `style={{ … }}` objects.
   `docs/DEVELOPMENT.md` lists what it rejects and the one escape hatch.
2. **`css/tokens.css` and `src/tokens.ts` are generated.** Edit `tokens.json` or
   `semantics.json`, then run `pnpm run design:build`. CI rejects stale generated files.
3. **There are eight run statuses. Each always renders a glyph and a word.** Import
   `RunStatus` and `STATUS_PRESENTATION` from `@orca/design`. Never re-declare the list. Never
   rely on colour alone. Glyphs come from a bundled symbol face, not Plex or the OS. A new
   glyph in `semantics.json` also goes into `tools/font-build/build-fonts.js`; then run
   `pnpm run design:fonts`.

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

### Start from what exists

- The component layer is `packages/design/css/components.css`: token-bound classes such as
  `orca-tree-row`, `orca-chip`, `orca-card` and `orca-node`.
  `packages/design/src/component-api.d.ts` says what props each React primitive exposes. Build
  on these; do not re-derive values.
- Before inventing a component, check `docs/design/`. Most are already specified.
- Screens live in `packages/app/renderer`: React, bundled by Vite. `tokens.css` and
  `components.css` are imported at the top of `renderer/src/main.tsx`.
  `pnpm --filter @orca/app dev` runs it with hot reload. `docs/DEVELOPMENT.md` ("The renderer
  build") has the rest.
- The primitives are in `renderer/src/ui`: `StatusChip`, `Button`, `Chip`, `Card`, `Well`,
  `Text`, `Duration`, `Time`, `ConfigField`, `ObjectHeader`, `ObjectId`, `KeyValueList`,
  `StateView`, `ScheduleBadge`, `ConnectionIndicator`, `Menu`, `WorkflowNode`,
  `DependencyNode`, `CanvasControls` and `GraphMinimap`, plus the helpers
  `focusAfterLeaving` and `counted`/`unit`. Compose these instead of writing class names.
- See every primitive in both themes at `#preview` in a dev build. `#type` shows the bundled
  faces and glyphs.
- If an implementation must diverge from `component-api.d.ts`, fix that file in the same PR.
- The app (`packages/app`, renderer included) may import only `@orca/protocol` and
  `@orca/design` from the workspace. Everything it knows about a run comes over the wire from
  the daemon (ADR 0008).

### Type size comes from a type class (#211)

- `components.css` sets no `font-size`. An element gets its size from an extra `.orca-text-*`
  class (`orca-text-caption`, `orca-text-mono-log`, …). Every rule in `components.css` has a
  `/* type: <style> */` note naming the one it expects.
- Put both classes on the element. `class="orca-chip"` alone inherits the shell's 14px.
- The component class still sets sans or mono, weight and colour.
- Nothing in a component class may override the type class. A `<button>`'s `font: inherit`
  reset lives in a zero-specificity `:where()` rule, never in the class's own rule
  (`font-reset.test.ts`).

### Ids, statuses and text that does not fit

- **An id on screen is an `ObjectId`.** The name leads; the id follows as a faint token: the
  kind's glyph and the last six characters (`Database schema ⬡ 5M579G`). The whole id is in
  its `title`, in the crumb menu's **Copy id** and in palette matching. Never render
  `{x.runId}` or slice an id yourself. `object-id-guard.test.ts` fails on a raw id in JSX and
  on an id prefix that no `objectKind` in `semantics.json` decides. An event is `#seq`.
- **A status is a `StatusChip`, and a surface never sizes it:** no class, no width. A column of
  them is `aligned`.
- **Text that does not fit has one answer** (RULES.md rule 15):
  - A chip, badge, pill, button or crumb part is one line and as wide as its text.
  - A count is `counted(n, "change")`. It agrees with its noun and never splits from it.
  - A bar is one line. Its lowest-priority sentence is the `.orca-truncate` that gives way,
    with the whole text in `title`.
  - Chips in a card or panel go in `.orca-chips`, which wraps. A row never wraps.

### Do not drop focus

When a control that holds focus goes away (a row removed, a save bar gone after Save, a
deleted node), move focus to its neighbour with `focusAfterLeaving`, or to the region it
belonged to. Do this only if focus was on it. Worked examples: the claims list, the policy
panel, `DraftBar`'s `returnFocus`, and the workflow editor's delete.

### Say where your screen scrolls

The window will not scroll for you. `body` is `overflow: hidden` and `.orca-window` is a fixed
three-row grid. A box that outgrows its share is clipped and unreachable, with no sign of
failure (#275).

The shell already handles two cases:

- `.orca-main` and `.orca-panel` are `min-height: 0`, so a surface is bounded by the window.
- `.orca-panel__body` is the dock's scroll region. Panel content scrolls without its own
  scroller.

You choose one of two shapes:

| Surface shape | Scrolls | Example |
| --- | --- | --- |
| A stack of content | At its root: `flex: 1` plus `overflow-y: auto` | Attention |
| Its own split layout | Bound the columns; scroll the region with the long content | Runs, Plan, Config, Agents, workflow viewer |

- Never both. Never put a scroller inside `.orca-list__scroller`; the virtualiser windows rows
  against that box.
- `scroll-sweep.test.tsx` walks every surface in `SURFACES` and fails on one that declares
  neither.
- happy-dom has no layout, so `test/smoke/app-shell.spec.ts` shrinks a real window to 340px and
  measures each surface and the docked panel. The box that should scroll must overflow, scroll
  to its end, and show its last child there (#277).
- `docs/design/60-implementation.md` ("Scrolling is structural") has the rest, including the
  minimum a `VirtualList` needs inside a scrolling root.

### Every popover is a `Menu`

- `Menu` owns the keyboard and focus contract: `↑`/`↓`/`Home`/`End` roving focus, `Enter` to
  choose, typeahead on a letter, focus on the first safe item on open (never a `danger` one),
  focus back to the trigger on close, including `Esc`. Placement flips rather than clips.
- Do not add an `Escape` handler, an outside-click listener, `tabIndex` handling or a
  `useState` for open. A second implementation is what #202 exists to prevent.
- If a popover's body is not a list of choices, extend `Menu`. Do not build a rival.
- A menu sits on `surface-raised`, never on `surface-overlay` (a modal's scrim).
- A `danger` item leads with `✕`, is never first and is never focused on open.
- Item fields: `hint` is a one-word meta; `hintMachine` is machine text in mono, never
  re-cased; an object's id is `labelId`; a sentence is the menu's `note`.
- **A destructive act with no way back confirms on the row**, not in a popover over the list.
  The row gets a second state: Keep first and focused, ✕ Confirm in the danger tone, and the
  consequence on the row's two-line variant. The palette and the Agents claims list do this.
- **An edit to a draft does not confirm.** Remove a grant and Delete a node are plain buttons,
  because Save, Discard and Undo are the way back. A resting screen has no danger tone.

### Every pane boundary is a `PaneSplitter`

- A two-pane screen states no width for either pane. The track is
  `var(--pane-<boundary>, var(--<token>))`, and a `<PaneSplitter>` sits in the `auto` track
  between them (#276).
- `renderer/src/panes.ts` holds the registry of boundaries, the clamp, and the only code that
  writes a `--pane-*` property. Limits are tokens (`PANE_GEOMETRY`), not numbers in a
  component.
- The size is remembered per boundary in the app's preferences. Two panes of the same kind
  share one boundary id and one width; the docked panel and the workflow inspector do.
- A splitter needs only its position in the markup: a child of the container whose track sizes
  the pane, with that pane as its immediate sibling.
- The boundary's hairline belongs to the splitter. A pane beside one draws no border.
- **A boundary says whether its size is a length or a ratio (#281).** A column boundary is
  remembered in px. A stacked boundary (the run tree over the event timeline, and every
  stacked split after it) is remembered as a fraction of its container and applied as a
  percentage. Drag, keys, clamp and `aria-valuenow` stay in px either way.
- A dragged size is listed in Config's App preferences with a restore. The palette has a
  keyless command that restores them all (#280).

### Lists do not poll. The daemon pushes.

- `window.orca.notifications.subscribe` is the raw envelope stream. Wrap it with
  `createNotificationStream` (`renderer/src/notifications.ts`) and listen to one method:
  `run.changed`, `step.changed`, `agent.update`, `input.opened`, `input.answered`,
  `event.appended` or `agent.changed`, with an optional `runId` filter.
- For a run patch, do not re-read the whole list. A notification for an object the list has
  never seen is resolved with one `runs.get` and inserted.
- Every run notification carries `seq`, the cursor. The main process owns reconnect and
  resume, so a screen only unsubscribes when it goes away.
- `agent.changed` is not about a run. It has no `runId` and no `seq`, goes only to a
  store-wide subscription, and carries the whole `AgentView`. Nothing to resolve or resume
  (#241).
- Agent output is coalesced: one `agent.update` per step per 100 ms, many lines inside. Render
  the batch; do not assume one line per frame.
- A push never says a run went `stale`. That is a lapsed lease, so it shows only on a read.
- `plan.changed`, `config.changed` and `workflows.changed` are scoped invalidations, not
  patches. Their consumers re-read the affected snapshot.
- A new reconnect generation can need fresh reads too. Keep these recovery reads separate from
  periodic polling. Not every data family has a complete reconnect contract yet.

### The connection is a separate pushed channel

- `window.orca.connection` has `read()` for the snapshot and `subscribe()` for changes. It
  carries `{ state, since, eventCursor?, versions?, orcaVersion?, capabilities? }`, where
  `state` is one of the design's five.
- Do not derive a connection state from a failed call. Do not send your own `hello`. The main
  process owns the state machine (`src/main/connection-state.ts`), the one place that maps
  `SubscriptionState` and the handshake onto the five states.
- A screen reads it through `useConnection()`.
- **Leaving `live` is held silent for five seconds**, so a blip changes nothing on screen. The
  machine does this. A component that re-implements it doubles the delay.

### Ask whether you can write; do not find out by failing

`useWritability()` gives "can write, or why not" from the connection state plus whether
`runs.control` is in `hello.capabilities`. A daemon started `--read-only` leaves out the
capability and the methods, so this is a normal, explainable state, not an error. The
`reason` string fits `Button`'s `disabledReason`. A control must not compose its own.

### A list of rows is a `VirtualList`, not a `map`

`renderer/src/list/` is the base for every row list in the app. It:

- renders a window over the rows;
- reads row height from `--row-h`, so `data-density` needs no special case;
- draws the status minimap gutter over the whole list, not just the visible window;
- registers `J`/`K`, the arrows, `Home`/`End` and the page keys on the `KeyboardMap` in the
  scope its `scope` prop names.

Rules:

1. **One scope holds one `VirtualList`.** A second list in the same scope registers `J` twice
   and the map throws. That is on purpose.
2. The scopes are `list` (default), `run-tree`, `stream`, `plan-journal` (the journal beside
   the schedule) and `plan-graph` (the plan's dependency canvas, which has the workflow
   canvas's keys). A further list on one screen does not mean a scope is missing.
3. Both canvases use one layout: `layoutGraph` in `renderer/src/workflow/layout.ts`, over a
   plain `{ nodes, edges }` graph with many roots. `layoutWorkflow` is an adapter over it.
   There is no layout dependency.
4. Selection is `aria-activedescendant` on a single tab stop, and looks different from focus
   (rule 10).
5. Rows are a `listbox` of `option`s, unless `role` makes them a `tree` of `treeitem`s or a
   `grid` of `row`s. The roles belong to the base, because it owns the row element. A surface
   fills the row's children through `renderRow`, and adds `aria-level` and `aria-expanded`
   through `rowProps`.
6. Use `grid` when rows hold controls (the plan's schedule table does). A button inside an
   `option` cannot be reached. The cells then carry `role="gridcell"`.
7. A list that pages backwards calls `shiftBy(rows)` on the ref after a prepend. Otherwise the
   view jumps back by the page just loaded.
8. A stream takes `follow` and gets `onHold` once when a scroll leaves the end.
9. There is no `scrollIntoView` anywhere; it cannot reach a row that is not in the document.

### Worked surfaces

| Surface | What to copy |
| --- | --- |
| `renderer/src/runs/` | The model surface: arithmetic in a plain module with a plain test, data in one hook, selection and keys in another, markup from `ui/`. Three lists: `runs/tree/` over `runs/timeline/` on the left, `step/` on the right with `artifacts/` in the dock. One directory per thing. Filtering is a filter, not a search: status is a `runs.list` parameter the daemon applies to the whole store; text filters what is held; the count says which ("3 of 7 runs"). |
| `renderer/src/attention/` | The first surface that writes. Cards are not rows, so they are not virtualised (what is bounded is the number of things blocked on a person). The failed runs below them are a `VirtualList`. `card-model.ts` holds the safety rules: which option gets which digit (never `1` for the destructive one) and what an "always" answer may promise once the daemon says what it wrote. The same cards mount inline in step detail (`attention/inline-asks.tsx`) over the same feed: one read, one component, one count. |
| `renderer/src/config/` | The first that edits a file. `config-model.ts` maps schema to sections, draft to patch, and an error to its field. One hook holds both documents and their drafts. Permission rows are a `map`, not a `VirtualList`, because one agent has few rules; they are still `--row-h` tall and never wrap (rule 9). Its save bar (`.orca-draftbar`) is reused by the workflow editor. |

Two rules from Config for anything that writes a document:

1. A draft is the edits, never a copy of the file. A copy has to decide every untouched key.
2. A refused write keeps the draft. `CONFIG_STALE` means someone else saved; say so, and keep
   what the person typed.

### `renderer/src/a11y/` is not a surface

- It holds the **one** polite live region the app announces through. `App` mounts it once.
  It listens to the feed the surfaces already hold; it never opens a second subscription.
- `announcements.ts` turns a `run.changed` or `step.changed` into one sentence or into
  nothing: transitions and terminal states only, per
  `docs/design/50-accessibility-and-keyboard.md`.
- A surface that wants to announce something adds to that function. It does not add a region.
- Writes the daemon never pushes (a write this app made, or one it refused) go through
  `useAnnounce()` (`a11y/announce.ts`), into the same region.
- `a11y-sweep.test.tsx` checks there is exactly one region, and that it is the same element on
  every surface.

### Every shortcut goes in the keyboard map

- Register `{ scope, key, label, action }` on the `KeyboardMap` (`renderer/src/keyboard-map.ts`).
  Do not add a `keydown` listener. The command palette is a view of that registry.
- **`key` is optional (#205).** A command with no free letter registers without one; the
  palette lists it with no key chip and is the only way to it.
- Mark the subtree that owns a scope with `scopeProps("run-tree")`.
- `Esc` belongs to the layer stack, not to your component.
- `docs/design/60-implementation.md` has the rest.

## When the data is not there

ORCA cannot supply a run completion percentage, an estimated time remaining, or agent cost.
Do not approximate them and do not add a placeholder. Say so in the PR.
`docs/design/60-implementation.md` has the standing list.

## Keeping the rendered version honest

`packages/design` and `docs/design` are the source of truth. A rendered version of the system
(live previews, both themes, the key screens) exists as a Claude artifact for visual review.
Nothing in the build reads it. When these folders change materially, ask for it to be
republished. When the two disagree, the files win.
