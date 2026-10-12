# Accessibility and keyboard operation

## Contrast

Every pairing in `tokens.json` was checked programmatically against WCAG 2 in **both** themes:
text at 4.5:1 on each ground its usage note names, and 3:1 for `border-control`,
`border-focus`, `border-strong`, `graph-edge` and every status glyph. `border-hairline` is the
single deliberate exemption and is documented as decorative — it never distinguishes a control.

When adding a colour, run the check before adding the token, not after. The pairs that matter
are the ones each token's `usage` note names; a token whose note does not name its grounds is
incomplete.

## Status without colour

Eight statuses, eight glyphs, eight words. Every status chip renders glyph + word; the colour
is the third channel, not the first. In a greyscale screenshot the run tree still reads.
`status-cancelled` and `status-stale` share a neutral ramp on purpose, and are distinguished
by glyph (`⊘` vs `◷`) and by the dashed border on stale — never rely on their hues differing.
The risk matrix adds a hatch to `risk-severe` for the same reason: the exposure band above the
appetite line must survive greyscale and must survive deuteranopia.

## Focus

`border-focus`, 2px, offset 1px, drawn with `outline` so it never changes layout, and never
suppressed. It holds 3:1 on every surface and every status tint in both themes. Focus is
always visible for keyboard interaction; `:focus-visible` governs whether it is drawn after a
mouse click, but it is never removed from the stylesheet.

There is one ring and one rule that draws it, and nothing turns it off. The command palette
was the exception until #260: its field suppressed the ring against a compensating ring on
the overlay that was never drawn, so ⌘K led somewhere with no focus indicator at all. The
field draws the ordinary ring now, and the palette draws none of its own — a `:focus-within`
ring on the overlay would be a second look, drawn after a mouse click as well, to be kept in
step with the first by hand. The field's only difference is that its ring is inset by its own
width rather than offset outwards: the overlay clips its content and the field spans its full
width, so an outward ring would lose three of its four sides. Same token, same 2px.

Selection and focus are separate and look different: selection is `surface-selected` plus a
2px `accent` left rail, focus is the ring. A row can be selected without being focused (the
list has selection, the palette has focus), and the design must keep both legible at once.

**Focus is never dropped.** When the control holding it leaves the document, focus would fall
to the page body and a keyboard user would be thrown out of the place they were working. So
whatever removes a focused control says where focus goes next, and the answer is always a
neighbour or the region the control belonged to:

- **A row leaves a list** — a released claim, a removed grant: the row that slides into the
  gap, the one before it when it was the last, then the list's own add control or section
  (`focusAfterLeaving`, `renderer/src/ui/`).
- **The workflow editor deletes** from the inspector: the selection moves to the next node in
  file order (the previous one when it was the last; after an edge, the node it left from) and
  focus goes to the canvas, whose active descendant names it.
- **A save bar leaves** because Save or Discard emptied the draft: focus goes to what the
  draft was editing — the policy panel's written grants, the Config form's first section or the
  raw YAML.
- **An armed row disarms** (Keep, `Esc`): focus goes back to the control that armed it.

The move is made only if focus went with the control: focus a person moved somewhere else in
the meantime stays where they put it.

## Keyboard map

| Scope | Key | Action |
| --- | --- | --- |
| Global | `⌘K` | Command palette |
| Global | `⌘1`–`⌘6` | Attention, Runs, Plan, Workflows, Agents, Config |
| Global | `⌘\` | Toggle the docked panel |
| Global | `⌘⇧D` | Toggle density on the focused surface |
| Global | `⌘⇧L` | Cycle theme: system, light, dark |
| Lists | `J` / `K`, `↑` / `↓` | Move selection |
| Run tree | `→` / `←` | Expand / collapse; `←` on a collapsed row goes to its parent |
| Run tree | `⇧→` | Expand the whole subtree |
| Run tree | `Enter` | Open step detail |
| Run tree | `F` | Filter to failed and waiting descendants |
| Streams | `G` / `⇧G` | Top / bottom, `⇧G` re-enters following |
| Streams | `/` | Search within the stream, `N` / `⇧N` to cycle matches |
| Cards | `1`–`9`, `Enter`, `⇧Enter`, `G` | Select option, submit, submit with a note, go to the run |
| Workflow canvas | `↑` / `↓` | Move the selection within a layer; top to bottom, to the previous / next layer |
| Workflow canvas | `→` / `←` | Move the selection to the next / previous layer; top to bottom, within a layer |
| Workflow canvas | `Enter` | Expand or collapse the selected `subworkflow` or `parallel` |
| Workflow canvas | `+` / `-` / `0` | Zoom in, zoom out, back to rest (100%, no pan) |
| Workflow canvas | `⇧↑` `⇧↓` `⇧←` `⇧→` | Pan |
| Workflow editor | `↑` / `↓` / `←` / `→` | Select the nearest node in that direction, by where the boxes are drawn |
| Workflow editor | `Enter` | Open the selected `loop` or `parallel` node's inline graph |
| Workflow editor | `⌫` / `Delete`, `⇧Delete` | Delete the selection (edges stay, dangling); delete a node with its connections. The selection moves to the next node in file order |
| Workflow editor | `F2`, `C` | Rename the selected node; connect it to another |
| Workflow editor | `⌘⏎` | Go to the palette, to add a node after the selected one |
| Workflow editor | `⌥↑` / `⌥↓` | Move the selected node up or down the file |
| Workflow editor | `⌘Z`, `⌘⇧Z` | Undo, redo |
| Workflow editor | `+` / `-` / `0`, `⇧↑` `⇧↓` `⇧←` `⇧→` | Zoom and pan, as on the viewer's canvas |
| Schedule table | `Enter` | Explain the selected work item |
| Plan journal | `J` / `K`, `↑` / `↓` | Move selection |
| Plan graph | `↑` / `↓` | Move the selection within a layer; top to bottom, to the previous / next layer |
| Plan graph | `→` / `←` | Move the selection to the next / previous layer; top to bottom, within a layer |
| Plan graph | `Enter` | Show the selected node's relationships in the docked panel |
| Plan graph | `+` / `-` / `0` | Zoom in, zoom out, back to rest (100%, no pan) |
| Plan graph | `⇧↑` `⇧↓` `⇧←` `⇧→` | Pan |
| Panel | `[` / `]` | Previous / next artifact version |
| Config | `⌘S` | Save the configuration draft |
| Anywhere | `Esc` | Close the topmost transient layer, never lose an unsent draft |

The two Plan rows are one screen with two lists on it (#170), and the second list is why
there is a `plan-journal` scope beside `list`: the substrate registers the movement keys in
whichever scope a list names, one list per scope, so `J` means "next" in whichever of the
two the focus is in. The schedule table is `list`, like every other primary list. The
dependency graph (#171) is a third scope, `plan-graph`: it is a canvas with the workflow
canvas's keys, and two canvases in one scope would register `↑` twice, which the map throws
on. The risk register (#172) and the decision list (#173) are lists that show in place of the
schedule table, so they take `list` when the schedule is not mounted. The workflow editor
(#181) is its own scope, `workflow-edit`, rather than the viewer's `workflow`: it adds keys
that change a draft, and the viewer must not have them. Every pointer gesture in the editor
(dragging a palette item, a node or a connection) has one of these keys or a palette or
inspector control as its keyboard path.

Every action in this map is also in the command palette, with its key shown beside it. The
converse does not hold, and deliberately: a command may register with **no key at all** and be
reachable from the palette alone, which is how something worth doing but not worth one of the
letters left stays discoverable. Nothing is reachable by keyboard alone or by mouse alone.

### The graph canvases' view controls

The workflow canvas, the workflow editor and the plan graph each have a group of view controls
in the bottom-right corner, under a minimap. They add **no key**, and that is the decision:

- **The buttons are the keys' actions, not a second zoom.** Zoom out and zoom in are `-` and
  `+`; the zoom level between them ("100%") is `0`, back to rest. One state in
  `ui/use-canvas-view.ts` answers the keys, the buttons, the wheel and the minimap, so a press
  and a click never disagree. Each icon button is named for its action and has it as its
  tooltip with the key beside it ("Zoom in (+)"); an icon is never the only label. At a limit
  a button stays focusable and says why it does nothing ("Zoomed in as far as the canvas goes,
  200%").
- **`0` keeps its meaning: rest.** Zoom to fit is the other thing a reset could mean, and it
  is a button and a keyless palette command, **Zoom to fit the whole graph** (#205). So are the
  two toggles, **Lay out top to bottom** / **Lay out left to right** and **Hide the minimap** /
  **Show the minimap**, each named for what it will do — which is also the button's accessible
  name, rather than a fixed name with `aria-pressed`: the state is a direction, not an on and
  an off.
- **The group sits outside the canvas's keyboard scope.** Inside it, `Enter` on a focused
  button would be the canvas's `Enter` (and in the editor, `⌫` would delete the selected node),
  because the map dispatches before the button's default. It is a named `group`, not a
  `toolbar`: six ordinary tab stops after the canvas, with no roving arrows promised.
- **Every pointer gesture has a keyboard path.** ⌘/Ctrl with the wheel, or a trackpad pinch,
  zooms about the pointer, where `+` and `-` zoom about the middle of the canvas. A plain wheel,
  a drag of empty canvas and a click or a drag in the minimap all pan, which `⇧` with an arrow
  does; a plain wheel stops at the drawing's edge and then lets the canvas scroll on to the
  group boxes below it, as it did before the drawing clipped. **Zoom to fit** is "show me all
  of it".
- **The minimap is `aria-hidden` and has no tab stop.** It is a pointer convenience over what
  those keys already do, and what it draws is the canvas's own listbox, which a screen reader
  already reads node by node, status first. Exposed, it would be an unlabelled second copy of
  the graph with no keyboard path of its own. Its show/hide button is an ordinary named control.
- **Turning the graph turns the arrows.** Top to bottom, the layers are rows, so `↓` is the next
  layer and `→` the next node in the layer; the palette's labels change with it. The arrows
  always point where the selection goes.

## Screen readers and live regions

- The run tree is a `tree` with `treeitem` rows carrying `aria-level`, `aria-expanded` and
  `aria-selected`. The status is in the accessible name, first: "failed, build, attempt 2 of 3".
- A list whose rows hold **controls** is a `grid` of `row`s with `gridcell` cells, not a
  `listbox` of `option`s: an `option` is a leaf, so the button inside one — the **why**
  beside a schedule badge, the claim's run — is a control nothing can reach, and that is what
  axe calls `nested-interactive`. The plan's schedule table and its decision list (#173), whose
  rows hold the decide and reopen controls, are the two such lists today.
- Streaming output is **not** a live region. An agent producing 40 lines a second would make
  the app unusable with a screen reader. Instead, a polite live region announces step
  transitions and terminal states only ("build step failed, 3 attempts"), and the output pane
  is a labelled `log` region the person reads on demand.
- Gates and permission asks announce assertively when they open, because they are the one
  interruption the design intends.
- The connection state is a polite live region; it announces on change, not on tick.
- The object header's trail is an ordered list in a `nav` named "Object", and it stays the
  whole chain when the middle folds into `…` (`10-information-architecture.md`). The `…` is
  a button in the tab order, between the root and the crumbs after it, and its accessible
  name lists the levels it holds, in order: "2 hidden levels: work item Database schema, run
  Database schema". Its menu holds the same levels as items to choose. The folded crumbs are
  measured in an unseen row that is `inert` and `aria-hidden`, so they are never a second,
  invisible tab stop.
- An id token is read as its kind and its tail — "run 7X8PXX" — never as twenty-six
  characters: the glyph is `aria-hidden` and the kind's word is in the text. The live region
  names a finished run the same way ("Run JH7X8P failed"), and an event by its sequence number.
- An armed row (a claim's release) is a `group` named as the question — "Release Database
  schema?" — holding **Keep** and **✕ Confirm release**; Confirm is `aria-describedby` the
  consequence sentence on the row's second line, and Keep, first, is where focus lands.

## Reduced motion and other preferences

`prefers-reduced-motion` drops every transition and replaces the running pulse with a static
filled glyph. `prefers-contrast: more` is honoured by swapping `border-hairline` to
`border-control` and `ink-tertiary` to `ink-secondary`; no new palette is introduced. Theme
follows `prefers-color-scheme` unless the person has chosen one explicitly.

## Resizing a pane

Every pane boundary is draggable, and every one is a control rather than a decoration (#276): a
`role="separator"` with a tab stop, `aria-orientation`, and `aria-valuenow` / `aria-valuemin` /
`aria-valuemax` in pixels. `←` and `→` move a boundary between two columns by one grid step,
`↑` and `↓` move one between two stacked panes, and `Enter` — the keyboard's double-click — puts
it back where the design had it. `aria-valuemax` is the *current* ceiling, so on a window too
narrow for the design's it says what the window allows.

**Those keys are deliberately not in the map below**, and it is the same call the `Menu`'s roving
focus made: they belong to whichever separator has focus, not to the app. There are two splitters
on screen in the chrome alone, so one registration per key could not say which boundary it meant.

The splitter is `--splitter-thickness` across, which is below `hit-min` and is the one target
allowed to be: it spans the whole edge of a pane, so it is narrow on one axis only, and the tab
stop with the arrows on it is the path for anyone who cannot land on six pixels.
`60-implementation.md` has the rest — where the size is written, and how it survives a relaunch.

## Window sizing

The layout holds from 960px to 2560px. Below 1100px the docked panel becomes an overlay over the
primary pane; below 960px the sidebar collapses to icons. Neither of those two layouts offers a
splitter, and a boundary dragged wider than a narrowed window allows shows what fits while
keeping what was asked for: a dragged width never fights one of these rules. There is no phone
layout and
none is planned. The six glyphs that rail collapses to are designed and declared — they are
`semantics.json`'s `surface` map, bundled in the symbol face and listed in
`10-information-architecture.md` beside the surfaces they name (#261). Each button keeps its
label as its accessible name and its `⌘1`–`⌘6` address at every width, so the rail loses the
word on screen and nothing else.

## How this is enforced

Up to v0.4.0 this file was a specification. Most of it is now a check with a name, and a new
surface will be held to them rather than to a reading of the prose. When a paragraph above
changes, the check named beside it is the thing that has to change with it.

| Section | What enforces it |
| --- | --- |
| Contrast | `packages/design/test/contrast.test.ts` — every pairing, both themes, before the token lands |
| Status without colour | `renderer/test/a11y-sweep.test.tsx` asserts glyph **and** word in the accessible name of every status row; `test/smoke/app-shell.spec.ts` re-reads them under `filter: grayscale(1)` in both themes and keeps a picture beside the assertion |
| Focus | `renderer/test/focus-and-selection.test.ts` reads the stylesheets: the ring is `:focus-visible` everywhere, selection never borrows `--border-focus`, and every `outline: none` matches a named allowlist |
| Keyboard map | `renderer/test/keyboard-map-agreement.test.tsx` — the table below is transcribed and asserted in both directions, so a mouse-only action cannot be added quietly |
| The graph canvases' view controls | `renderer/test/canvas-controls.test.tsx` — the buttons drive the keys' zoom, every control is named, the group is outside the canvas's scope, the minimap is `aria-hidden` with no tab stop, and fit and the toggles are keyless palette commands; `renderer/test/workflow-layout.test.ts` for which way the arrows point in each direction |
| Resizing a pane | `renderer/test/pane-splitter.test.tsx` — the separator's role, range and arrow keys, the restore, and which boundaries the app offers at which width; `renderer/test/panes.test.ts` for the clamp. The real drag and the real cursor are `test/smoke/app-shell.spec.ts`, in an Electron window |
| Screen readers and live regions | `a11y-sweep.test.tsx` — exactly one polite announcer across all surfaces, assertive cards, the output pane's `role="log"` with `aria-live="off"`; `renderer/test/announcements.test.ts` covers what the announcer says and, as much, what it stays silent about |
| Reduced motion and preferences | The `prefers-reduced-motion` and `prefers-contrast: more` blocks in `components.css`. No automated check — see the gap below |
| Everything, per surface | `AxeBuilder` over Attention, Runs and Agents in both themes in the smoke job, with the failing rule ids in the message |
| The bundled faces | `test/smoke/type-proof.spec.ts` on Linux, macOS and Windows, against committed baselines |

**What none of these prove.** The renderer tests run in happy-dom, which has no cascade, no
layout and no input modality: they assert that the rules and the markup are right, not that
the pixels are. The computed focus ring, whether `:focus-visible` really stays dark after a
mouse click, the two media queries' output, and the collapsed sidebar below 960px are all
checked by eye or not at all. Real screen-reader behaviour is checked by neither — that a
`log` region with `aria-live="off"` gives navigation without narration is a reading of the
ARIA specification, asserted here only as attributes.

Pane restores from Config announce the named boundary returning to its default size through
the shared announcement channel. The palette restore announces the number of sizes restored,
or that all sizes were already at their defaults. `installAppearance` receives the same
framework-free announcer created before React mounts; no extra live region is installed.
