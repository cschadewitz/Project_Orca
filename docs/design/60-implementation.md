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

## Pane sizes

Every boundary between two panes is draggable and the size is remembered per boundary, the way
density is remembered per surface (#276). There are five, and they are the ones that exist:
sidebar ↔ primary pane, primary pane ↔ docked panel (which the workflow node inspector shares,
being the same kind of column), the Runs left column ↔ step detail, the run tree ↔ the event
timeline, and the Plan request rail ↔ the schedule or journal beside it.

A size is a **CSS custom property on the container whose track reads it**, and every track is
spelled `var(--pane-<boundary>, var(--<token>))`:

```css
.orca-body {
  grid-template-columns: var(--pane-sidebar, var(--sidebar-width)) auto minmax(0, 1fr);
}
```

So the token stays the single statement of the default, an unset property *is* the default
rather than a copy of it, and there is never a second answer to "how wide is a side pane". The
`auto` track is where the splitter sits. `packages/app/renderer/src/panes.ts` holds the registry
of boundaries and the clamp, and is the only code that writes a `--pane-*` property;
`chrome/pane-splitter.tsx` is the control over it, and it goes in the **shell** rather than in a
surface, so a surface that lands later inherits a resizable edge instead of inventing one.

**A size is not always a length (#281).** Four of the five boundaries are between two
*columns*, and a column is sized to what it holds — a line of output, a rule sentence — so
520px means the same thing on a laptop and on a 34" display. The run tree over the event
timeline is not that: its default is deliberately a fraction (`minmax(0, 2fr)` against the
timeline's `3fr`), because neither half is sized to its content and what a person chooses is a
**ratio**, "more tree than timeline". So a boundary in the registry says which of the two its
size is, and the stacked one says fraction: its preference is a number between 0 and 1, what is
written to `--pane-runs-tree` is a percentage rather than a length, and a split chosen on a tall
monitor arrives as the same split on a laptop. Everything between the two ends stays px — the
drag, the arrow keys, the clamp, and `aria-valuenow`/`min`/`max`, because px is what the
separator moves in — and the conversion happens at the two edges only (`panePreferenceOf`,
`panePx`). The two stacked splits v0.6.0 added arrived with this answered: `plan-risk` (the
risk matrix over the risk register, #172) and `plan-decision` (the decision list over the
selected decision's matrix, #173) are both fraction boundaries, because a matrix sized by the
plan's scale and a register sized by how many risks there are have no length that is right on
every window. The graph's second, graph-only rail (#171) reuses the `plan-rail` boundary id,
so it shares the request rail's remembered width rather than adding a sixth column boundary.
A mode says where it scrolls: the risk register, the decision list and the schedule table are
the scrolling region of their split, the matrices and the canvas are bounded, and
`scroll-sweep.test.tsx` walks every entry in `PLAN_MODES` as it walks `SURFACES`.

Five rules it keeps:

- **Limits are tokens, not numbers in the component.** `--pane-min-sidebar`, `--pane-max-side`
  and the rest, emitted as `PANE_GEOMETRY` in `@orca/design` because a clamp is arithmetic and
  no `var()` can be written inside one.
- **The breakpoints win.** Below `bp-sidebar-collapse` the rail is icons at its own width and no
  sidebar splitter is rendered; below `bp-panel-overlay` the panel floats at the token's width
  and neither is its own. A dragged width never fights a layout rule.
- **A window too narrow for the remembered size shows what fits, and remembers what was
  asked for.** The clamp is re-applied on every container resize and the preference is left
  alone, so widening the window again brings a person's choice back rather than the default.
- **The default is reachable.** `Enter` or a double-click on the splitter *forgets* the size —
  the property comes off the element and the key comes out of the preferences file — because a
  number written back would be a copy of the token that the next token change would not reach.
- **What was dragged is written down where the other preferences are (#280).** A pane size is
  the one remembered appearance a person can set *by accident*, and the boundary is the only
  place that says so — which is no use to somebody who does not know the window is wrong. So
  Config's **App preferences** section lists a row per boundary that has been dragged, with its
  size and a **restore**, and the palette carries a keyless **Restore the pane widths** for all
  of them at once. A boundary at its default is not listed: five rows reading "default" would
  bury the two preferences worth reading. Both write the same deletion the splitter writes.

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
**Resume the run this is waiting on** were the first two; as of #178 every write action in
the app is one of these (see "Palette write actions" below).

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

### Palette write actions (as built, v0.5.0)

Every phase-2 object write the daemon serves is a keyless row on the object in focus (#178):
answer a gate
or an ask with each option it offers, cancel or resume a run, start a run, waive a
dependency, decide or reopen a decision, move a risk along its lifecycle, release a claim,
and the Agents surface's two from #176. Nothing was added to the chrome of any screen,
which is the point of "the palette is the only place a phase-2 write action needs to be
discoverable".

**Two writes are deliberately not rows.** `config.set` is the save bar (`.orca-draftbar`):
it does not write an object, it writes a *file* against a draft that is sitting on the
screen, and a command that saved a form from somewhere else would save edits nobody was
looking at. And a permission ask's "always" answer stays on the card, because only the card
can read back what the daemon actually wrote — `alwaysOutcome` (`attention/card-model.ts`)
has to see `permission.refused`, `permission.added` or neither before it says "ORCA will
not ask again", and a palette row that had closed the palette would have nowhere to say it.

**Absent, or disabled with the reason — never silently dead.** One hook asks both questions
(`palette/use-write-actions.ts`). Where the daemon does not serve the method the row is *not
registered*, and a screen with no cancel row reads as a viewer rather than as something
broken. Where the daemon is simply not answering the row stays, `aria-disabled`, with
`useWritability()`'s own sentence in `.orca-palette__why` — the same sentence `Button`'s
`disabledReason` shows. A disabled row keeps its place in the roving order and is only
skipped by `Enter`: the reason is *on* the row, so an order that stepped over it would put
the reason out of reach of the keyboard.

**The question is asked per method, not per capability.** Every row names the wire method it
calls — `runs.cancel`, `decisions.decide`, `claims.release` — and `methodPresent` answers it
from the connection snapshot's `methods`, which is `hello.methods`, which is `Object.keys` of
the daemon's own dispatch table. `runs.control` is one word over four of those tables, so the
capability alone is wrong in both directions: it would draw a waive row at a daemon serving a
store with no plan in it, and hide a release row at a daemon that answers `claims.release`
without claiming the capability. A daemon too old to list its methods falls back to the
capability, inside `methodPresent` and nowhere else.

**A destructive row confirms inline, as a second state of the same row.** `Shortcut.confirm`
and `tone: "danger"` say so, and the palette arms the row on the first `Enter`: the label
becomes the confirmation ("Cancel run-42 — confirm"), the row takes the danger tone — the
colour *and* the `✕` it leads with, since colour is never the only channel (rule 4) — and a
second `Enter` commits. Typing or moving the selection disarms it; `Esc` closes the palette,
which unarms with it, since the armed row does not outlive the list it is in. Nothing has
been sent in the meantime. There is no dialog, deliberately — a modal over this modal would
move focus out of the query field, put a second layer on the stack for `Esc` to unwind, and
ask the question somewhere other than where the person is looking. Cancel, waive and release
carry one; resume, decide and reopen do not, because re-driving a parked run, deciding a
decision and reopening one are all acts with a way back. A destructive control on a list row
outside the palette asks the same way, on its own row — the Agents surface's claims are the
first ("Releasing a claim", below).

**A destructive row is never first.** It sorts below every other command, whatever scope it
is in, for the reason a gate's destructive option is never bound to `1`: the first row is
where `Enter` lands and where a held key repeats. It holds for the list as it is offered;
typing re-sorts by match score, so a query of "cancel" can put the cancel row at the top —
which is the query asking for it, and all `Enter` does there is arm the row.

**A command that needs an argument opens a picker.** `Shortcut.picker` replaces the palette's
list with a `Menu` of the choices — the app's one popover primitive, controlled the way a
deep link controls one, so the roving keys, the placement, `Esc` and the focus contract are
every other popover's. The choices are read when the row is chosen and never on open, so
`⌘K` costs nothing extra for the person who wanted something else. Three use it: **Start a
run** (the workflows), **Decide** (the decision's options) and **Update risk** (the statuses
the risk is not already in).

**Start a run asks for a workflow and for nothing else.** The picker lists `workflows.list`
— name, id, version and node count — and the choice calls `runs.start { workflowId }` with
no vars, so the run takes the workflow's own; the row says "starts with the workflow's
default vars" rather than leaving that to be discovered. **A vars form is specified
nowhere**, and `WorkflowSummaryView` does not carry a workflow's `inputs`, so a form here
would be inventing its own fields (rule 12). The run is opened through the route table like
every other link.

**Two things #178 asked for and did not get, on purpose.** *Start a run for this request or
work item, with its vars* is not built: `runs.start` takes a `workflowId` and vars on the
wire and takes no work item at all, so the row would have to guess which workflow a work
item means and which vars carry it there — inventing both (rule 12). The plain **Start a
run** above is what is left when the guessing is taken out. *Config: show in YAML* is not
built either: the config surface renders a form over a schema, the raw document is a read
the daemon already serves, and a palette row that opened a viewer over it would be a second
way to look at the same file rather than a write. Both stay open as their own work.

**A palette label sets its ids in mono, and an id is its token.** `Shortcut.labelMachine`
names the substring of the label (and of the confirmation) that ORCA produced — an id token,
a decision key — and the row draws that span in `mono-id` and the rest in sans, because mono
means ORCA produced it and "Release claim on Database schema `⬡ 5M579G`" is two voices in one
sentence (rule 8). A label never carries a raw id: it names the object and follows the name
with the token from `idText`, which the palette draws as an `ObjectId` token — the glyph as
decoration, the kind as a word, so the option is named "… work item 5M579G". The whole id is
the shortcut's `objectId`, matched and never drawn, so pasting it or typing the tail a row
showed still finds the row. It is a substring rather than a second string so that the label
stays the one thing the query matches and the one thing that names the option.

## Popovers are one primitive

`Menu` (`renderer/src/ui/menu.tsx`) carries the whole popover contract, once, and every
popover uses it — the crumb's counterparts today, the schedule badge's explanation, the
artifact version menu and the risk cell's detail as they land.

`↑`/`↓` move with wrapping, `Home`/`End` jump, `Enter` chooses, a letter jumps to the next
item starting with it. Focus moves onto the first item on open — the first that is neither
disabled nor `danger` — and back to the trigger on close — a choice, a second press on the
trigger, or `Esc`. The one exception is a press *outside*: focus is already going where the
person clicked, and dragging it back would fight them. A `disabled` item is shown and named
but skipped by the arrows, because a menu never hides what it cannot do; an empty item list
renders no trigger at all, because a disclosure onto nothing is worse than no disclosure.

**A destructive item is never first, and never where focus lands.** `MenuItem.danger` draws an
item in the danger tone led by `✕`, and the menu steps past it when it chooses where to put
focus on open, so an `Enter` pressed out of habit chooses the safe thing — the rule a gate's
destructive option and the palette's destructive rows keep for the same reason. The menu does
not re-sort what it is given, because the order of a list is the caller's to mean something
by; listing the safe choice first is the caller's half. A menu whose only choices are
destructive puts focus on the list itself, and `↓` enters it.

**A menu stands on `surface-raised`** with `shadow-popover`, which is what that pair is for. It
stood on `surface-overlay` — the scrim behind a modal, which never carries text — until the
design-conformance review, so every menu was see-through grey. **An item's `hint` is a one-word
meta** (a type, a date) in the eyebrow style, uppercase and unwrapped; a sentence a menu has to
say is its `note`, which wraps.

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

## Scrolling is structural, not remembered

`body` is `overflow: hidden` and `.orca-window` is a three-row grid of `--bar-title` / `1fr` /
`--bar-status`, so a box that outgrows its share is **clipped, not scrolled**: no scrollbar, no
wheel, no keyboard way down. Content below the fold does not exist. That makes "did this author
remember a scroller" the difference between a screen working and half of it being silently
unreachable, which is not a thing to leave to memory (#275).

Two boxes in the shell own it so that a surface does not have to:

- **`.orca-main`** and **`.orca-panel`** are `min-height: 0`. A flex or grid item's automatic
  minimum size is its content, so without that declaration a tall child stretches the column
  past the window instead of being bounded by it — and an `overflow-y: auto` under an unbounded
  parent has infinite room and scrolls nothing. Every box between a scroll region and the pane
  needs the same, which is why `min-height: 0` is on almost every layout class in the renderer's
  stylesheets and is never a tidy-up.
- **`.orca-panel__body`** is the dock's one scroll region, so whatever a surface hands up as
  `content.body` scrolls without knowing it is in a dock. A surface cannot answer that question
  for itself — it does not know how tall the column is, or whether it is a grid column or an
  overlay — so it does not have to. `.orca-panel`'s own `overflow: hidden` is the clip that
  keeps the enter animation and the overlay's shadow inside the column, and the head stays
  outside the region it labels.

A surface then chooses between two shapes, and the choice is about what it *is*:

- **A stack of content scrolls at its root** — `flex: 1` for the pane's height, `overflow-y:
  auto` to scroll against it. Attention is the one that needs it: its cards are deliberately not
  fixed-height and not virtualised, so a handful of gates with consequence lists is taller than
  the window, and it is the screen whose whole job is showing what is blocked on a person.
- **A split layout scrolls in its regions** — Runs, Plan, Config, Agents and the workflow viewer
  each bound their columns and put the scroll on the region that holds the long thing. **Do not
  then also scroll the root**: two scrollers in one column is the second-scroller trap, and
  nothing may nest a scroller inside `.orca-list__scroller` — the virtualiser windows rows
  against that box, and a scroller inside it takes the wheel and breaks the arithmetic.

A region that holds a `VirtualList` inside a scrolling root needs a **floor**, not just
`flex: 1`: with the column overflowing there is no free space to grow into, and an item whose
flex basis is zero shrinks to nothing — a "Failed" heading with no failures under it.
`.orca-attn__failures` states six rows as `calc(var(--row-h) * 6)`, a ratio to the bound row
height in the manner of `.orca-list--two-line`.

Scrollbars need nothing: `color-scheme` travels with every theme block the generator emits (see
the top of this file), so a scroller is in the theme the moment it exists.

There are **two guards, and they answer two different questions** (#277).

`packages/app/renderer/test/scroll-sweep.test.tsx` is the cheap one. It walks `SURFACES` — so
the sixth surface is swept the day it is added — installs the real stylesheets off disk, and
asserts that each surface declares a scroll region and that every box between that region and
the pane is bounded. It does not measure: happy-dom has no layout engine, so "is this taller
than the window" is not a question it can answer. The *declaration* is what the next author
gets wrong, and this fails in a second when they do.

`packages/app/test/smoke/app-shell.spec.ts` is the expensive one, and it is the only place in
the repo with a real layout engine and a real window. It sets the window to 1280×340 — too
short for any surface — and then asks what the sweep cannot: that the box which is supposed to
scroll **actually overflows** (`scrollHeight > clientHeight`), that it takes a scroll to its
end, and that the last thing in it is **inside the box** once it is there. The last of those is
what catches a scroller that scrolls the wrong box: a rule that takes its height from an
unexpected place — a `position: absolute` up the tree, a grid track that resolved differently,
a `height: 100%` against a parent nobody gave a height to — declares everything correctly and
still hides content. The docked panel is measured the same way with the Plan inspector in it,
which is the content that most easily outgrows a 420px column.

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

**A surface never polls. Run patch notifications do not trigger whole-list rereads.** One read
on mount and per filter change, then the stream. A notification about an object the list has
never seen is resolved with a single read *scoped to that object* and inserted in order — a
`run.changed` carries a status and a cursor, not a name or a creation time, so there is no row
to draw from it alone, and an `input.opened` carries the question but not the run's name, how
long it has waited or the artifacts the decision is about. One `runs.get`, or one
`inputs.list` for one run; never the list again.

`plan.changed`, `config.changed` and `workflows.changed` are scoped invalidations,
not full-object patches: their consumers reread the affected snapshot. Reconnect generation
changes can require fresh reads too. Keep these recovery reads separate from periodic polling;
not every data family yet has a complete reconnect convergence contract.

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

## Config surface (as built, v0.5.0)

**Two documents, one screen** (#175, #266). `config.get` answers with `orca.config.yaml` and
the ADR 0009 permission sidecar beside it, each with its own path, its own content-hash
`revision` and its raw `text`, plus a flat schema description and the effective permission
policy per agent. The YAML is drawn twice — as a form over the schema and as the bytes in a
`textarea` styled by `.orca-yaml` — switched by a segmented control in the object header. The
sidecar is drawn as the effective rules in evaluation order and as its own raw JSON, and is
**read-only here**: grants are edited from the Agents surface's policy panel (below).

**The draft is edits, not a copy, and it is one of two kinds.** A form draft is a map of
dotted path to value and is sent as `patch`, which edits the YAML document in place and keeps
its comments; a raw draft is the bytes and is sent as `text`. There is no merge of the two
that is not a guess, so editing in one view drops the other's draft — **last edited wins**,
and the bar says so before it happens. An edit back to the file's own value is not a change,
which is what makes "N changes" a count of what would be written. Clearing an optional field
sends a patch entry with no `value`, which deletes the key so its default comes back.

**Staleness is a refusal, and a refusal never costs a draft.** `expectedRevision` is the
revision the draft was made against; a daemon whose bytes have moved answers `CONFIG_STALE`,
and the bar turns `--blocked`, says the file changed and offers **Reload**. The draft is
still there afterwards, to be sent against the new revision.

**Nothing polls.** One `config.get` on mount, then `config.changed`; a push whose revision is
one the screen already holds is its own write coming back and is dropped. A write that lands
is followed by one read, because the effective policy is computed over both files and
`config.set` answers with neither.

**The draft model is mounted above the surface switch** (`config/config-context.tsx`).
`App` unmounts Config like every other screen, so a draft held inside it disappeared the
moment somebody looked at a run; the hook now runs once in a `ConfigProvider` and both
consumers — this surface and the Agents surface's policy panel — read the one model. That
is one `config.get` for the app rather than one per mounting, it is one answer to "what is
unsaved", and closing the policy panel no longer discards the grant edits it was holding.

**The save bar is `.orca-draftbar`, and it is the one the workflow editor reuses** — the
editor adds **Validate all** and **Publish** to it rather than drawing a second bar
(70-workflow-editing.md). `⌘S` saves, registered in the `config` scope so the palette lists
it. The bar is **absent** where there is no `config.set` to call — file mode, a `--read-only`
daemon, or any daemon whose `hello.methods` does not list it — and the form goes read-only
with it. The gate is the method rather than the `runs.control` capability: the capability is
one word over four dispatch tables, and a daemon serving a store outside a workspace drives
runs and has no configuration to write (`methodsFor`). `ConnectionSnapshot` carries
`methods` from the handshake for exactly this, since a `HelloResult` never crosses the
bridge. **Disconnected and reconnecting keep the bar**, dimmed values and all, with the
change count still on it and `writability()`'s reason on Validate and Save — those are a
daemon that would take the write if it were answering, and 40-connection-states.md asks for
the reason on the control rather than for a control that vanishes with the draft.

**Nothing on the screen speaks.** A field's error is `aria-describedby` text, not an alert:
it is on the control the person is editing, and rule 11 keeps interruption for what a person
is not already looking at. What is announced, once, into the app's one live region is the
*result* — "Config saved", or the first error's sentence after a Validate or a Save that
came back with one.

**A saved configuration takes effect on the next `orca serve`.** The daemon reads the
configuration when it boots and keeps what it read, so a save changes the file and not the
process answering it. The surface says so in one line beside the bar rather than leaving it
to be discovered.

**Three deviations from what #175 asked for, recorded rather than quietly shipped.** The raw
view is *editable*, although the issue described it as read-only: a form over a schema
cannot express every key a person may need to write, and a read-only view of the bytes would
send them to an editor outside the app. The notification tiers (#162) are in the preferences
file and are not on this screen, because their surface is the Attention side of the app and
a tier list here would be the second place they are set. And there is no stub section for
#140: a section that names a feature and does nothing is a promise the screen cannot keep
(rule 12).

**What the surface cannot soften.** Nothing in either document is redacted: `config.get`
hands over the bytes, ssh hosts and command lines included, because a form that edits a file
has to show the file and a redacted `text` written back would destroy what it hid. The raw
view says so in one line rather than leaving a person to discover it.

## Agents write (as built, v0.5.0)

**A grant is edited in the sidecar, never in the YAML** (#176, ADR 0009). The Agents
surface's cards carry one action, **Permissions**, which opens that agent's policy as an
inspector beside them. It shows the whole effective policy in evaluation order: the
configured rules first, **read-only** — they are `orca.config.yaml`'s, a person curated them,
and nothing machine-written rewrites a hand-curated array, so the panel links to the Config
form instead — then the sidecar's written grants, which are editable, and last **ORCA's
defaults**, the floor `@orca/agents` appends when the config left `default:` unset (#140).
The defaults are a read-only group of their own with no link out of it: they are not a
document, there is no file behind them and `config.set` cannot address them, so the way to
change them is to write a fallthrough in the config, which opts out of them entirely. The
Config surface's read-only view groups the same three layers the same way. A grant can be
removed, narrowed or widened (kind, path, path prefix, scope, title pattern), or added by
hand, in which case it is stamped with the time and with `grantedFor: "added by hand in the
app"` so a reader of the diff can tell it from one a run wrote.

**It is the Config surface's draft model, mounted elsewhere.** The panel lives in
`renderer/src/config/` and reads the app's one feed through `ConfigProvider`: the same
`expectedRevision`, the same `CONFIG_STALE` conflict with **Reload**, the same rule that a
refused write keeps the draft — and, since the model is above both screens, closing the
panel keeps the grant edits rather than discarding them. There is no "discard these?" warning
on **Close** because there is nothing to discard: the draft outlives the panel, and
`policy-editor.test.tsx` closes it and reopens it to keep that true.
A save sends the whole sidecar as `config.set { document: "permissions", text }` — `patch`
edits a YAML document in place and this one is JSON — and the daemon canonicalises the key
order, so a client compares **revisions, not bytes**. The panel never writes a `default`: the
sidecar has no fallthrough, because answering one prompt must not change the answer to every
other one, and a document carrying one is refused rather than stripped.

**The round trip is lossless or it is refused.** A key this app does not recognise — on a
rule or inside a match — is written back after the ones it does, so an edit to one row
cannot quietly delete a field a newer daemon put on another. A document whose `version` is
not 1, a rule that is not an object, one with no `match`, or one naming a decision outside
`PERMISSION_DECISIONS`, is a file the panel says it **cannot edit here** and points at the
Config surface's raw view — the same state unparseable text gets, because guessing at a
repair and writing it back is the one thing a file this security-relevant must not do.

**Allow-always lands here without a second path.** When a run answers "always", the daemon
writes the sidecar and pushes `config.changed`; the panel is on the same hook every Config
screen is, so the rows re-read themselves. A card's "always" that the daemon *refused* to
derive a rule from says so on the Attention surface rather than promising anything
(`alwaysOutcome`, #221) — the panel then simply has nothing new to show, which is correct.

**Releasing a claim** (#88) is the surface's other write, and it **confirms inline, as a
second state of the row** — the palette's destructive-row pattern above, on a list row. At
rest each claim carries a quiet **Release** in the default tone, named for the work item's
title; one the daemon would refuse is the same button disabled with the reason on it. Pressing
it *arms* the row: the row takes the danger tone, the control becomes **Keep** and **✕ Confirm
release**, and the row grows into its declared two-line variant to say, under itself, what
releasing does — "*title* goes back to the scheduler. *run* loses its claim on it, and another
run may claim it", subject first and ids in mono. Nothing has been sent. Keep is first and
takes focus, so a second `Enter` keeps the claim; Confirm leads with `✕`, names the work item
and is `aria-describedby` the consequence, and the pair is a `group` named as the question.
Keep, `Esc` (the armed row is on the transient layer stack, so the one global `Esc` unwinds it),
focus leaving the row and arming another row all disarm it — one row asks at a time — and the
first two hand focus back to Release. It was a confirmation `Menu` until the design-conformance
review, which found the three things a popover over a list gets wrong here: the consequence was
in an item's eyebrow-styled `hint`, so an uppercase line wider than the window; the destructive
item was first and focused on open, so Release then `Enter` released; and the question was asked
in a layer over the list rather than on the row it was about. The palette's **Release claim on**
row is the Plan surface's in every respect — one `releaseCommand` words both, the work item by
its title and its token, `tone: "danger"`, a `confirm`.
There is no **Force release** here — `--force` takes an item from a run that could still
resume, which has no undo and stays a CLI act. Nothing pushes for a release (it journals no
event), so the claims are re-read once after the call, and the result's `note` — what releasing
did *not* fix, since a dead run's log never moves on — is announced into the app's one live
region and left on the row, in the same two-line variant, or under the section's heading once
the re-read has taken the row away. When that row leaves holding focus, focus moves to the next
row's Release — the previous row's if it was the last, the section itself if the list is now
empty — while focus a person has already moved elsewhere stays where they put it, and a refused
release keeps its row and its focus.

**And one control that is not there: retrying a handshake from the card.** No method drives
the daemon's handshake retry — `agents.ping` probes an agent and records a result, it does
not reschedule anything — and `AgentView` carries the last attempt, the round trip and the
consecutive failure count but no next-attempt time, so a card could offer neither the retry
nor the countdown beside it without inventing both (RULES.md rule 12).

**And one number that does not exist.** #176 asked for "the auto-approval count explained".
Nothing in ORCA counts auto-approvals: `decidePermission` is evaluated per tool call and no
running total is kept, on the wire or off it. The panel says so in words rather than tallying
anything client-side (RULES.md rule 12), which is also why `AgentHealthCardProps` has no
`policy` field.

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

One thing the model *did not* supply and the daemon now derives on read: an open decision has
no stored `result` until somebody evaluates or decides it, so `decisions.list` computes the
matrix's recommendation through core's `evaluateDecisionMatrix` and flags it
`resultIsPreview: true` (#173). The renderer labels it as a preview; nothing is written, and a
matrix core refuses to evaluate has no preview rather than an error.

### Reconciliation after transport reattachment

The preload connection snapshot includes a monotonic `generation`, advanced for each
successful store-wide subscription attachment. Data hooks observe it independently of the
five-second visible connection delay: even a hidden outage can lose a terminal transition or
an input request. Runs, Attention, Agents, expanded run details, the timeline and step output
reconcile their snapshots at this boundary. Ordinary notifications still update individual
objects without polling lists. Pending initial and resolving reads retain newer pushes;
answered requests are tombstoned until the next read generation so stale reads cannot reopen
them. This signal is local IPC metadata and changes neither protocol nor store formats.
