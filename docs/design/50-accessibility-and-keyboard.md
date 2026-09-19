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
| Cards | `1`–`9`, `Enter`, `⇧Enter` | Select option, submit, submit with a note |
| Panel | `[` / `]` | Previous / next artifact version |
| Anywhere | `Esc` | Close the topmost transient layer, never lose an unsent draft |

Every action in this map is also in the command palette with the shortcut shown beside it;
nothing is reachable by keyboard alone or by mouse alone.

## Screen readers and live regions

- The run tree is a `tree` with `treeitem` rows carrying `aria-level`, `aria-expanded` and
  `aria-selected`. The status is in the accessible name, first: "failed, build, attempt 2 of 3".
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

## Window sizing

The layout holds from 960px to 2560px. Below 1100px the docked panel becomes an overlay over
the primary pane; below 960px the sidebar collapses to icons. There is no phone layout and
none is planned.
