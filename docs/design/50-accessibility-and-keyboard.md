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

## Keyboard map

| Scope | Key | Action |
| --- | --- | --- |
| Global | `⌘K` | Command palette |
| Global | `⌘1`–`⌘5` | Attention, Runs, Plan, Agents, Config |
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
| Workflow canvas | `↑` / `↓` | Move the selection within a layer |
| Workflow canvas | `→` / `←` | Move the selection to the next / previous layer |
| Workflow canvas | `Enter` | Expand or collapse the selected `subworkflow` or `parallel` |
| Workflow canvas | `+` / `-` / `0` | Zoom in, zoom out, back to rest |
| Workflow canvas | `⇧↑` `⇧↓` `⇧←` `⇧→` | Pan |
| Schedule table | `Enter` | Explain the selected work item |
| Plan journal | `J` / `K`, `↑` / `↓` | Move selection |
| Panel | `[` / `]` | Previous / next artifact version |
| Config | `⌘S` | Save the configuration draft |
| Anywhere | `Esc` | Close the topmost transient layer, never lose an unsent draft |

The two Plan rows are one screen with two lists on it (#170), and the second list is why
there is a `plan-journal` scope beside `list`: the substrate registers the movement keys in
whichever scope a list names, one list per scope, so `J` means "next" in whichever of the
two the focus is in. The schedule table is `list`, like every other primary list.

Every action in this map is also in the command palette, with its key shown beside it. The
converse does not hold, and deliberately: a command may register with **no key at all** and be
reachable from the palette alone, which is how something worth doing but not worth one of the
letters left stays discoverable. Nothing is reachable by keyboard alone or by mouse alone.

## Screen readers and live regions

- The run tree is a `tree` with `treeitem` rows carrying `aria-level`, `aria-expanded` and
  `aria-selected`. The status is in the accessible name, first: "failed, build, attempt 2 of 3".
- A list whose rows hold **controls** is a `grid` of `row`s with `gridcell` cells, not a
  `listbox` of `option`s: an `option` is a leaf, so the button inside one — the schedule
  badge's **why**, the claim's run — is a control nothing can reach, and that is what axe
  calls `nested-interactive`. The plan's schedule table is the one such list today.
- Streaming output is **not** a live region. An agent producing 40 lines a second would make
  the app unusable with a screen reader. Instead, a polite live region announces step
  transitions and terminal states only ("build step failed, 3 attempts"), and the output pane
  is a labelled `log` region the person reads on demand.
- Gates and permission asks announce assertively when they open, because they are the one
  interruption the design intends.
- The connection state is a polite live region; it announces on change, not on tick.

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
none is planned. The five glyphs that rail collapses to are designed and declared — they are
`semantics.json`'s `surface` map, bundled in the symbol face and listed in
`10-information-architecture.md` beside the surfaces they name (#261). Each button keeps its
label as its accessible name and its `⌘1`–`⌘5` address at every width, so the rail loses the
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
