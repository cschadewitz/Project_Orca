# Design conformance review — 10 October 2026

How closely the desktop app's UI matches the design it was built from: the **ORCA** design
system made in Claude Design (artifact
[`PCEoFKbHgCbYG7AW1XjhWg`](https://claude.ai/artifact/PCEoFKbHgCbYG7AW1XjhWg), last
published 19 September 2026). It is a dated record, not a living spec. The living spec is
[`docs/design/`](../design/README.md), which has evolved past the artifact, issue by issue.

- **Pin:** `24241f2b85315f021793646818ca8d3c2fb767a1` (main, "build: require Node.js 24").
- **Method:**
  - A static code review, not a visual one.
  - The artifact's README, its eight sections, `tokens.json`, `bundle.css`, `index.d.ts`, and
    the 23 component and 10 screen specs and previews were compared with
    `packages/design` and `packages/app/renderer/src`.
  - The comparison was split into four areas, plus an audit of how far `docs/design` has
    drifted from the artifact.
  - happy-dom has no layout engine, so nothing here measures pixels.
- **Line numbers** are as of the pin and will drift. Paths are relative to the repository
  root.
- **Verdicts:**
  - **Matches**: as specified.
  - **Partial**: the core is there, details are missing.
  - **Diverged**: built differently.
  - **Missing**: not built.
  - **Deferred**: a documented later phase.
  - **Documented** means `docs/design`, `RULES.md`, an ADR or a code comment records the
    divergence as intended. **Undocumented** means nothing does, so it reads as drift.

## Summary

| Area | At the pin | After this review's fixes |
| --- | --- | --- |
| Tokens | **Matches**: all 103 design tokens present with identical values; 65 added, plus bundled fonts | Three title-bar tokens exported as numbers; `col-id`, `minimap-w`/`-h` and `stroke-icon` added; `node-h` 64 → 96px; six `objectKind` glyphs in `semantics.json` |
| CSS class layer | **Matches**: one class dropped, about 63 added, type sizes removed (#211) | `.orca-chips`, `.orca-objid`, `.orca-kv`, `.orca-canvasctl`, `.orca-graphmap`, `.orca-truncate` added; menus on `surface-raised`; control font resets moved into `:where()`; one text-overflow policy |
| Component API | **Matches** by name: all 22 types survive, many props reshaped around the protocol | `ObjectId`, `KeyValueList`, `CanvasControls`, `GraphMinimap` added; `StatusChip` `aligned` (no `className`); `MenuItem` `danger`, `hintMachine`, `labelId`; `DraftBar` `returnFocus` |
| Shell and keyboard | Mostly **matches**; three bugs (below) | Bugs fixed |
| Runs, step detail, artifacts | **Partial** | Run-tree indent, chip width and column overlap fixed; object variables in a clamped well, and step detail no longer scrolls sideways |
| Attention | **Partial**: ordering, the one count and answering in place are right | A correction's values in a `Well`; ids as tokens |
| Agents | **Diverged**, mostly documented data gaps | Release confirms on its row; claims lead with names and id tokens; focus kept when a claim or a grant leaves |
| Config | **Partial** | The save bar hands focus back and stays one line; the policy panel's Remove is quiet |
| Plan | **Partial**: dependency graph shipped as the design's recommended option | Schedule column aligned with **why** beside its mark; ids as tokens; the graph gets zoom, direction and a minimap |
| Workflow viewer | **Partial** | Now on its own Workflows surface; fixed node boxes, zoom, direction and a minimap |
| Workflow editor | **Deferred** (#180–#183) | **Built**: drafts, visual editor, validation panel (#180–#182); dry run (#183) still deferred |

## Fixed after the review

These landed on the review branch, `claude/orca-design-review-f4689a`, each with tests and a
changelog fragment.

- **Run-tree rows did not indent.**
  - `.orca-tree-row` pads by `--level`, but nothing set it, so only the hairline guides
    moved.
  - The depth now reaches the row through a new `rowStyle` option on `VirtualList`
    (`list/virtual-list.tsx`, `runs/tree/run-tree.tsx`).
- **The window kept its OS frame**, so the custom title bar sat under a second, native one.
  - `BrowserWindow` now gets `titleBarStyle: "hidden"` with traffic lights centred in their
    inset on macOS, and a Window Controls Overlay on Windows.
  - Linux keeps its window manager's frame, as the inset tokens specify
    (`src/main/window-chrome.ts`).
- **Hovering a palette row moved the selection**, which the spec forbids. Hover now only
  tints the row. A click selects the row, so an armed destructive row is the one `Enter`
  confirms (`palette/command-palette.tsx`).
- **Banners under the title bar took the window's main row.**
  - Affected banners: a deep link's "Opened …" notice and the connection bar.
  - The app was squeezed into the status bar's row.
  - First fixed by giving notices an `auto` row of their own. That was superseded by the
    header decisions below.
- **Header decisions: the link notice and the connection bars.**
  - The bar under the title bar was not the object header. It was the link-landing notice,
    stretched across the sidebar and styled as the stale banner.
  - **Dismiss navigated away.** It cleared the route along with the notice, so on Workflows
    it closed the viewer and returned to the list. It would also have closed the guided
    launch. Dismiss now hides only the notice.
  - **Decided:** the notice appears only when a link cannot be honoured:
    - a URL this version does not understand;
    - a link that arrived with no daemon answering;
    - a work item the plan does not hold;
    - a counterpart the app cannot follow yet.

    A link that worked says nothing, because the object header names what is open. Before
    this, every row, crumb and palette jump showed "Opened …".
  - **Decided:** notices belong to the primary pane, under the object header, as
    `40-connection-states.md` and the window mock specify. The sidebar sits flush under the
    title bar (`chrome/primary-pane.tsx`, `App.tsx`, `10-information-architecture.md`).
- **The Runs left column spilled under the step detail** when the detail was dragged wide.
  - The column track was implicitly `auto`, so it could not shrink below a tree row's
    min-content.
  - Fixed with `grid-template-columns: minmax(0, 1fr)` (`runs/runs.css`).
- **Run-tree status chips clipped "succeeded"**: the fixed `12ch` was too narrow. The column
  is now a floor sized from the longest word plus the chip's parts.
- **Workflows were reachable only by link, from the palette or from a run.**
  - A sixth surface, **Workflows** (⑂, `⌘4`), lists every workflow with **Open** and **Edit**.
  - Agents and Config moved to `⌘5` and `⌘6`.
  - Recorded in `docs/design/10-information-architecture.md`.
- **The workflow editor (#180–#182)** shipped on the visual model that #181 now specifies:
  drag and drop, layout as separate metadata, reviewed publish. See
  `docs/design/70-workflow-editing.md`.
- **Releasing a claim looked broken, and was unsafe.** Agents' **Release** opened a `Menu`:
  - Every menu was see-through grey: `.orca-menu` stood on `surface-overlay`, the dialog
    scrim. Menus now stand on `surface-raised` with `shadow-popover`, as `tokens.json` says
    things that float do; the two scrims are the token's only grounds.
  - The consequence sentence was the item's `hint`, drawn in the eyebrow style: uppercase,
    unwrapped, a menu about 1500px wide that still ran off its edge.
  - The destructive item was first and focused on open, so Release then `Enter` released.
  - The labels led with the raw id in sans, and every row carried a red Release at rest.
  - **Decided:** Release confirms inline, as a second state of the row — the palette's
    destructive-row pattern. A quiet Release arms the row: the danger tone, **Keep**
    (first, focused) and **✕ Confirm release**, and the row's declared two-line variant
    saying what releasing does. Keep, `Esc`, focus leaving and arming another row disarm it
    (`agents/agents-surface.tsx`, `60-implementation.md`).
  - `Menu` gained `danger` items (✕ and the danger tone, never focused on open; a caller
    never lists one first), and `hint` is documented as a one-word meta. Guided launch's
    workspace-root menu was the other caller passing a sentence as a hint; that reason is
    now the menu's `note`.
  - The palette's Agents **Release claim on** row now matches the Plan one: its id in mono,
    sunk below the safe commands, and armed by the first `Enter`. It had none of the three.
- **Smaller leftovers from the earlier fixes:**
  - The run tree's never-run placeholder was `12ch` of label type, about 10px short of the
    aligned status chip, so those rows sat off the column. It now takes the chip's own width
    (`--chip-aligned-width`, defined once in `components.css`) in the chip's type.
  - The run summary drew its status word twice, on the chip and again as a caption beside it.
  - Permission rules truncate in a narrow panel and now carry their whole text in `title`.
- **The Plan schedule's why links did not line up.** A classified item drew **why** inside its
  tinted badge and a settled item drew it after its outcome chip, so the tint ended after
  "why" on some rows and before it on others. Every row is now the mark, then the why — a
  control is accent and never sits on a state's tint — and the badge and the settled chip
  take one width in that column (`--badge-aligned-width`, the longest schedule word).
- **Ids were printed raw, and cut at the wrong end** (follow-up 9). Rows and headers printed
  `wi_01M4M899VKJZRZSBHNDY5M579G`; a ULID's first ten characters are its timestamp, so ids
  minted together are identical at the start, and the Plan table's end-truncation
  (`req_01M4M9GQ7T…`) kept exactly that half. The Runs request crumb printed one in sans.
  - **Decided:** the name leads and the id follows as a faint token — the kind's glyph and
    the last six characters, `Database schema ⬡ 5M579G` — through one primitive, `ObjectId`
    (`renderer/src/ui/object-id.tsx`, over `.orca-objid`). Six characters for every format;
    a list where two ids share six lengthens just those. The whole id is on hover (the one
    exception to "not in a tooltip", `30-long-running-content.md`), in the object header's
    new **Copy id**, in the detail pane (`variant="full"`) and in the palette's matching.
  - Six kind glyphs in `semantics.json`'s `objectKind`, bundled and never a status: `☰` run
    and `⬡` work item reuse their surfaces' rail glyphs on purpose; `❝` request, `◫` step,
    `⊓` gate and `✦` event are new. The step's was first `▭`, the plain rectangle, which at
    `mono-id` size read as a dash; it is the split square, from the same Noto face.
  - Call sites: the claimed-work rows, the Plan table's request and claim columns (now
    `col-id`), the Plan rail's request filters and inspector, the Runs crumbs, palette labels
    and danger confirmations (the name and the token via `labelMachine`, the whole id as
    `objectId`), the permission card's step fallback, the artifact panel's producer, the
    workflow viewer's run picker. Timeline rows name an event by `#seq`; its copy menu keeps
    the id. The link notices, the correction card and guided-launch receipts keep ids whole.
  - Menu hints that are ids (`orca://`, an intent id, `id · vN · N nodes`, `status · vN`) were
    uppercased by the eyebrow style; `MenuItem.hintMachine` sets them in mono, verbatim.
  - The palette's jump row did not recognise `run_<uuid>`, so no run admitted through a
    request or a direct launch could be jumped to by id. It does now.
  - `renderer/test/object-id-guard.test.ts` fails on a raw id rendered as a JSX child, and on
    an id prefix in `packages/core/src/ids.ts` that is neither a kind nor listed as never shown.
- **The object header had no chain elision** (follow-up 9). With an id token on every crumb,
  request ▸ work item ▸ run ▸ step ran past a narrow pane — beside the docked panel, say —
  and nothing gave way.
  - **Decided:** the trail folds its middle into `…`. The crumbs after the root fold first,
    nearest the root first, down to `request ▸ … ▸ run ▸ step`; then the parent folds,
    `request ▸ … ▸ step`; only then is the current crumb's name cut at its end. The root and
    the current crumb never fold, a trail of one or two never does, and the type, token and
    version are never cut. Folding comes before cutting: a folded crumb is whole one click
    away, a cut name is unreadable on screen.
  - Fit is measured, not counted. `elideTrail` (`renderer/src/ui/crumb-elision.ts`) is a pure
    function over the crumbs' natural widths and the trail's room, re-measured on a
    `ResizeObserver`; a wide window shows the whole chain. The mode control and the actions
    keep their width.
  - `…` is a `Menu` of the folded crumbs (name, token, type), and choosing one is the crumb's
    own `onOpen` through the route table. It is a button in the tab order whose accessible
    name lists the levels it holds, in order, so the trail a screen reader walks is still the
    whole chain. The folded crumbs are measured in an `inert`, `aria-hidden` row.
  - Tests: `crumb-elision.test.ts` across widths, `object-header-elision.test.tsx` for the
    menu, the keyboard and the names, and an `entry-points.test.tsx` case that opens a folded
    work item from the chrome.
- **The claims list's status chips stopped short of "succeeded" too**, after the run tree's
  copy of the same bug was fixed alone. `StatusChip` took a `className` and both lists sized it
  `12ch`. The chip is now never narrower than its word (`min-width: max-content`, `flex: none`),
  takes no `className`, and a column is its `aligned` variant (`--chip-aligned-width`).
- **A card's chips ran past its edge, and ids broke at their hyphens.** A run of chips in a card
  or panel is `.orca-chips` and wraps between chips; ids and names that cannot wrap are cut at
  their end with the whole value in `title` (inspector heads, the editor outline, the policy
  panel's agent, the Plan rail's filters).
- **Focus fell to the page body when a focused row left a list**: a released claim, a removed
  grant. Focus moves to the next row's control, the previous one's, or the list's own landing
  place (`focusAfterLeaving`, now in `renderer/src/ui/`).
- **Draft edits wore the danger tone at rest.** The policy panel's **Remove** and the workflow
  editor's **Delete** and **Delete edge** were red on every row and selection. They edit a draft
  that Save, Discard or `⌘Z` takes back, so they are quiet buttons that do not ask.
- **Object variables were one compact line of JSON, and step detail scrolled sideways.** An
  object or array is indented JSON in a `Well`, clamped to eight lines with **Show all**; the
  value column is `minmax(0, 1fr)`. The same display is now `KeyValueList`, with names in mono,
  in step detail, the Workflows inspector and the guided launch's review; an Attention
  correction's values are in a `Well` too.
- **Graph nodes grew with their text** (167px in a 64px slot), so edges met them where their
  middle would have been. A node is a fixed `node-w` × `node-h` box — 96px, the exact sum of its
  anatomy — with the name clamped at two lines and every part whole in its `title`.
- **The graph canvases had no zoom controls, no fit and no overview.** The workflow viewer, the
  editor and the plan graph share a corner of view controls (zoom, the readout as rest, fit,
  direction, minimap), ⌘/Ctrl-wheel zoom, a left-to-right or top-to-bottom layout remembered per
  person, and an `aria-hidden` minimap.
- **This pass** (the design-system sync):
  - The workflow editor's inspector deletes dropped focus to the page body; the selection now
    moves to a neighbour and focus to the canvas. Save and Discard did the same when they
    emptied a draft and the save bar left; `DraftBar` hands focus back to what it was editing.
  - Counts disagreed with their nouns ("1 edges", "0 of 1 decisions", "1 changed sources") and
    could break from them; `counted`/`unit` fix both, with a no-break space.
  - Crumbs, and every button, menu item, nav item and segment, rendered at the shell's 14px
    instead of their noted `label`, and `.orca-bare` buttons set in `mono-id` were sans: each
    control's `font: inherit` beat its type class. The resets are in one `:where()` rule.
  - Node type icons drew a 1px hairline; they take `stroke-icon` (1.5px), as the brand book says.
  - Labels wrapped out of their outlines and a draft bar's count split from its noun; see
    "Text that does not fit" under "Decisions made after the review".

## Decisions made after the review

Each is one line here; the doc it links to is where it is now written down.

- **Window:** nothing between the title bar and the sidebar; the connection bars and the link
  notice sit in the primary pane under the object header, the notice only when a link cannot be
  honoured, and Dismiss hides only the notice. The window is frameless.
  [10](../design/10-information-architecture.md#the-window),
  [40](../design/40-connection-states.md)
- **Workflows is the sixth surface** (⑂, `⌘4`; Agents `⌘5`, Config `⌘6`), with a visual editor
  over drafts, validation and a reviewed publish; layout pins live in `.layout/<id>.json`.
  [10](../design/10-information-architecture.md#six-surfaces),
  [70](../design/70-workflow-editing.md)
- **Palette hover tints and never moves the selection.**
  [10](../design/10-information-architecture.md#command-palette)
- **One status chip, never narrower than its word**; a surface never sizes it, and a column is
  `aligned`. [RULES 3](../design/RULES.md),
  [60](../design/60-implementation.md#a-status-and-a-column-of-them)
- **Runs of chips in a card wrap (`.orca-chips`); rows never do; machine strings are cut at
  their end, whole in `title`.** [RULES 8, 9](../design/RULES.md),
  [30](../design/30-long-running-content.md#virtualisation)
- **Menus stand on `surface-raised`; a `danger` item leads with ✕, is never first and never
  focused on open; `hint` is one word, `hintMachine` is mono and verbatim, a sentence is the
  `note`.** [RULES 16](../design/RULES.md),
  [60](../design/60-implementation.md#popovers-are-one-primitive)
- **Confirm only what has no way back, on its own row** (Keep first and focused, ✕ Confirm, the
  consequence on the two-line variant, `Esc` through the layer stack); draft edits are plain
  buttons; a resting screen carries no danger tone. [RULES 17](../design/RULES.md),
  [60](../design/60-implementation.md#agents-write-as-built-v050),
  [README, Colour](../design/README.md#colour)
- **Focus is never dropped** when the control holding it leaves: claims, grants, the editor's
  deletes, the save bar. [RULES 10](../design/RULES.md),
  [50](../design/50-accessibility-and-keyboard.md#focus)
- **Ids are shown by name and tail** through `ObjectId` (the kind glyph and the last six
  characters, the whole id in `title`, **Copy id** in crumb menus, `#seq` for events, `full`
  where the whole id must show; ☰ ⬡ ❝ ◫ ⊓ ✦); palette labels carry tokens; the jump row takes
  `run_<uuid>`. [README, Voice](../design/README.md#voice),
  [60](../design/60-implementation.md#an-id-on-screen),
  [10](../design/10-information-architecture.md#dual-spine)
- **The schedule column's why sits beside its mark**, outside the tint, with the badge and the
  settled chip one width. [60](../design/60-implementation.md#a-status-and-a-column-of-them)
- **Graph nodes are a fixed 96px box** (6px vertical padding), the name at most two lines, the
  meta one, the whole text in `title`. [70](../design/70-workflow-editing.md#what-the-editor-reuses)
- **A name and its value is `KeyValueList`** (mono names, pretty JSON in a sunken well, an
  eight-line clamp with Show all); corrections' values in a `Well`.
  [60](../design/60-implementation.md#a-name-and-its-value)
- **The object header folds its middle into `…`** before it cuts the current crumb's name; the
  root and the current crumb never fold.
  [10](../design/10-information-architecture.md#dual-spine),
  [50](../design/50-accessibility-and-keyboard.md#screen-readers-and-live-regions)
- **The graph canvases share view controls** (zoom, fit, direction, minimap toggle),
  ⌘/Ctrl-wheel zoom, a per-person direction and minimap (`preferences.json` `canvases`), and
  an `aria-hidden` minimap. [70](../design/70-workflow-editing.md#the-canvass-view-zoom-direction-and-the-minimap),
  [50](../design/50-accessibility-and-keyboard.md#the-graph-canvases-view-controls),
  [60](../design/60-implementation.md#graph-view)
- **Inline icons are 1.5px (`stroke-icon`)**, node type icons included.
  [README, Iconography](../design/README.md#iconography)
- **`ch` is half an em in this app**: both font stacks lead with symbol faces that have no
  "0", so every `ch` width is sized against `0.5em`, not Plex's zero.
  [README, Type](../design/README.md#type),
  [60](../design/60-implementation.md#a-status-and-a-column-of-them)
- **A control's type class wins over its font reset**: `font: inherit` lives only in
  `:where()`. [RULES 14](../design/RULES.md), [60](../design/60-implementation.md#text-that-does-not-fit)
- **Text that doesn't fit has one answer**: a bounded label never wraps (one line, outline
  encloses it, or cut at its end inside it with `title`); a number and its noun are one unit
  (`counted`, a no-break space); a bar stays one line and its lowest-priority sentence gives way
  (`.orca-truncate`). [RULES 15](../design/RULES.md),
  [README, Structure](../design/README.md#structure-not-shadow),
  [60](../design/60-implementation.md#text-that-does-not-fit)
- **Demo tooling:** `node .claude/skills/orca-demo-dev/scripts/start.mjs --seed` builds, seeds
  and starts a workspace with data on every surface. [DEVELOPMENT](../DEVELOPMENT.md)

## Findings by area

### Shell and chrome

- **Window layout: Partial.**
  - **Sidebar:** 228px, five surfaces in order (six since this review). **Matches.**
  - **Docked panel:** 420px. **Matches.**
  - **Pane splitters:** draggable and remembered (#276). Documented.
  - **Status bar:** has the daemon version. It lacks "runs active".
    - Undocumented: the comment at `chrome/status-bar.tsx:17-18` says no method serves the
      count, but `runs.list({ status: ["running"] })` is already read in
      `attention/use-attention.ts:218`.
    - The event cursor is per run, by design (`60-implementation.md`).
  - **Waiting count:** `◆ n waiting` is a button, hidden at zero, and the same number as the
    sidebar's. **Matches.**
  - **Waiting count, collapsed rail:** below 960px the rail hides the count. Undocumented.
- **ObjectHeader: Partial.**
  - Typed crumbs, the current crumb not a link, and counterpart menus are there.
  - Missing, undocumented:
    - Chain elision (`request ▸ … ▸ run`). *Fixed since: the trail folds its middle into
      `…`; see "Fixed after the review".*
    - Risks and artifacts counterparts.
    - Ids in mono (crumb names are sans, against rule 8). *Fixed since: ids are tokens; see
      "Fixed after the review".*
    - A panel toggle in the header.
- **CommandPalette: Partial.**
  - **Matches:**
    - The entry order.
    - Run id and `orca://` jumps.
    - Shortcuts beside each entry.
    - Writes listed but disabled with a reason when disconnected, and absent in file mode.
  - **Hover moving the selection:** a bug at the pin, now fixed.
  - Missing, undocumented:
    - The `> # @ / ?` prefixes and their hints.
    - Jumping by step name.
    - A no-results message that suggests the nearest prefix.
    - Staying open with a spinner until the daemon acknowledges an action.
  - Search covering names only is documented.
- **Connection states: Partial.**
  - **Matches:**
    - All five states and the 5s quiet window.
    - Absolute times when not live.
    - Writes absent in file mode, and the store path named.
    - The mismatch dialog once, then a bar.
  - **Drift:**
    - The reconnect rule sits under the title bar, not under the object header. The comment
      in `chrome/connection-banner.tsx:20-22` predates the ObjectHeader. **Fixed after the
      review:** it is under the header now.
    - `opacity-stale` dims whole bodies, labels included.
    - A running row does not become `◷` when disconnected.
  - The outbox the design describes ("will send on reconnect") was not built. That is
    documented.
- **StateView: Partial.** All five kinds are there. Missing: the "still waiting on the daemon"
  line after 3s, and a mono slot for a verbatim error.
- **StatusChip: Matches.** The eight statuses always show glyph and word. The glyph-only
  variant carries the word as its accessible name.
- **Keyboard and preferences: Matches.** This covers:
  - `⌘1`–`⌘n`, `⌘\`, `⌘⇧D` and `⌘⇧L`.
  - J/K, and Esc closing the top layer.
  - The 2px focus ring and the reduced-motion and contrast preferences.
  - The 960/1100 breakpoints, `data-density` and `data-theme` with `color-scheme`.
- **Deep links: Matches**, with additions (`plan`, `agent`, `launch`, `config`, and
  `?edit` since this review). An artifact link needs `?run=` (documented).

### Runs, step detail, artifacts

- **Run tree layout: Diverged, documented.**
  - The tree sits over the timeline, with a fixed step-detail column
    (`runs/runs-surface.tsx:5-10`, `10-information-architecture.md`).
  - The header has no run chip, meter, Cancel or elapsed time. Cancel and Resume are in the
    palette only (#178).
  - The gate card is in step detail, not inline under the waiting row.
  - There is no percentage, ETA or cost anywhere. **Matches** (rule 12).
- **RunTreeRow: Partial.**
  - **Matches:**
    - The ARIA tree with status first in the name.
    - The `→ ← ⇧→ Enter F` keys.
    - "n of m" attempts shown only when there are more than one.
    - The 1Hz duration.
    - The indent stopping at six levels.
  - **Drift:**
    - The sticky chain is the *selected* row's, not the topmost visible row's. Only a code
      comment records this.
    - Waiting rows lose their ground tint.
    - A child run's branch key is never rendered.
- **TimelineEntry: Partial.**
  - Event ids show on hover, kinds are verbatim and summaries are subject first.
  - Auto-approved entries name `gate:auto` rather than the policy.
  - Missing:
    - The waiting tint.
    - Expanding coalesced `agent.update` rows.
    - Reconnect and day-boundary rule rows.
    - Relative times.
- **Long-running content: mostly Matches.**
  - **Matches:**
    - Always windowed, with rows from `--row-h`.
    - The status minimap.
    - `shadow-sticky` only while scrolled.
    - Following and held modes with "↓ n new lines".
    - Time in at most two units on one 1Hz clock.
    - The output pane is `role="log"`, not a live region.
  - **Documented changes:** the buffer is 50,000 *events*, not lines, and the fold glyph is
    `…`.
  - **Gaps:**
    - The 2,000-character fold throws the rest of the line away.
    - There is no sticky "current tool call" header.
- **Step detail, output, tool calls: Partial.**
  - Tool calls are a separate list above the output, not interleaved with it. The design
    explicitly rejects a second list, and nothing documents this. **Undocumented.**
  - The toolbar has search only.
  - The gutter shows the event sequence number (documented).
  - ToolCallRow states and the expandable body **match**. Missing: kind icon, duration,
    exit code, and the first-and-last-lines fold.
- **ArtifactPanel: Partial.**
  - **Matches:**
    - It persists across navigation.
    - Version switching with `[`/`]` and `aria-pressed`.
    - `+`/`−` diff lines.
    - 420px, resizable 320–720 and remembered, overlaid below 1100px.
  - **Drift:**
    - Provenance is plain text, not links, and shows no agent. The comment in
      `artifacts/artifact-panel.tsx:159` claims they are links.
    - Diff is entered from a Compare menu, not by ⇧-selecting a version.
    - Loading and not-available are generic states.
    - There is no **Open externally**.

### Attention, Agents, Config

- **Attention surface: Partial.**
  - **Matches:**
    - Tier order (asks, gates, failures).
    - One summed count, failures not counted.
    - Answering in place advances focus.
  - **Undocumented drift:**
    - There is no "1 new" rule: new items re-sort under the cursor (`runs/run-rows.ts:84-87`,
      `attention/use-attention.ts:126-129`).
    - Rows do not expand in place; every wait is always a full card.
  - The empty state differs from the design, but that is documented (#256).
- **GateCard: Matches.** Two exceptions are documented:
  - When every option is destructive, one is still bound to `1`.
  - The inline card registers no keys.
- **PermissionCard: Partial.**
  - The verbatim subject, the assertive announcement, and the notification and focus rules
    match.
  - The kind glyph is dropped (documented in `component-api.d.ts`).
  - The options are the agent's own plus Always allow / Always deny. Neither button says it
    writes policy, although the comment at `attention/attention-surface.tsx:443-445` says
    they do.
  - There is no UI for the per-tier notification opt-in (documented deferral).
- **Agent cards and fleet: Diverged, mostly documented.**
  - Retry handshake, the auto-approval count and the claim footer are absent because ORCA
    does not supply the data.
  - Active roles are not told apart from configured ones. **Undocumented.**
  - `unknown` means "not contacted since start", and disconnected cards keep last-known
    health.
- **Config fields and editor: Partial.**
  - The dotted path and the **raw** link are on every field.
  - The raw view opens at the path only on the legacy screen.
  - Form and raw are a toggle, not side by side.
  - Secrets are withheld (documented).
  - **Undocumented:**
    - No modified-field marker (an accent bar and the previous value).
    - Unknown keys are kept but not shown.
- **Save bar: Partial.** The studio hand-rolls its own `.orca-draftbar` instead of reusing
  `DraftBar`. Its review lists paths rather than showing a YAML diff.
- **App preferences in Config: Partial.** Notification tiers have no UI (documented).
- **Beyond the design:**
  - Revision cards, the configuration studio and the policy editor.
  - Diagnostics and first-run.
  - Guided launch and template authoring.
  - Template authoring and the structured form use native `<select>`s, against the "every
    popover is a `Menu`" rule.

### Plan and workflows

- **Schedule table and badge: Partial.**
  - The five classes are distinct from run statuses. **Matches.**
  - The columns differ, and the explanation popover has no inline actions. Both documented.
  - The "why" button stays enabled when disconnected. **Undocumented.**
- **Dependency graph: option choice Matches, node and edge Diverged.**
  - Option B shipped with A's inspector in the dock, exactly as `80-dependency-graph-options.md`
    recommended.
  - Edge stroke styles match.
  - **Undocumented:**
    - No arrowheads.
    - Waived edges look like open ones (no `⊘` marker).
    - Hovering a node does not dim nodes off its path.
    - Waiving sends no reason, although the protocol accepts `rationale`
      (`plan/relationship-inspector.tsx:118`).
    - Nodes have no kind eyebrow, title, schedule badge or claim marker.
- **Risk matrix: Diverged.**
  - N×N on the plan's own scale and thresholds (documented).
  - The axes are transposed against the design: likelihood is rows (`ui/risk-matrix.tsx`).
    **Undocumented.**
- **DecisionMatrix: Partial.**
  - Weights are visible, totals are never auto-applied and the rationale field opens.
  - The rationale is optional.
  - It reads "The matrix recommends", not "highest weighted total".
  - Missing:
    - Due and overdue states.
    - The superseded banner.
    - The unscored-criteria message.
    - Contribution bars.
- **Workflow viewer: Partial.**
  - The nine node types, the overlay, untaken edges, the version and the `◷ pinned` chip
    **match**.
  - Missing:
    - Duration and agent on nodes.
    - Loop counts.
    - The branch value that was chosen.
    - The gate popover.
  - It still draws the on-disk definition for a pinned run, saying "ORCA keeps no copy",
    although `workflows.get({ id, version })` now serves the pinned version
    (`workflow/workflow-surface.tsx:12-16`). **Stale.**
- **Workflow editor:** Deferred at the pin, built since; see "Fixed after the review".

## The design-system source layer

The import commit (`21b394d`, 18 September 2026) copied the artifact faithfully. Everything
since has changed issue by issue, almost all of it deliberate.

- **Docs:** the repo says the artifact is "the review surface, not the source". Contradictions
  found:
  - `40-connection-states.md`: line 11 says writes queue until reconnect, but line 89 says
    there is no queue. *Fixed since: the table says writes are disabled with the reason, and
    names "will send on reconnect" as the intent for when an outbox exists.*
  - `60-implementation.md:325-327` says there is no two-line row class, but
    `components.css:491` defines one. *Fixed since: it says where the class is, and why there
    is no second row height.*
  - `70-workflow-editing.md`'s "As built (v0.5.0) — historical" section still says ORCA keeps
    no copy of a pinned run's definition. It is labelled superseded, but it reads as a
    contradiction. *Fixed since: the bullet says the viewer still prints that sentence and that
    moving it to the pinned version is follow-up 7.*
  - `10-information-architecture.md:136` said workflow editing "remains v0.6.0". Fixed in
    this review.
  - Text this branch's own changes made stale: "five surfaces", "five glyphs", `▭` for a
    step, "Cancel run-42 — confirm" in the palette's example, and "not in a tooltip" for a cut
    label that now carries its whole text in `title`. *Fixed since.*
- **CSS:** the one class dropped is `.orca-timeline-entry--succeeded` (#224), which leaves the
  status modifiers lopsided. `components.css` sets no hard-coded sizes or colours except
  `font-weight: 500/600` (about 26 times, with no weight tokens) and one `letter-spacing`.
- **Component API:** all 22 types survive. Stale comments in `component-api.d.ts`:
  - The `mode` comment, around line 811, lists only Schedule and Journal.
  - `VirtualListProps.scope`, around line 1014, omits `plan-journal`.
  - `eventCursor` is kept although nothing supplies it.

  *All three fixed since: the mode comment lists Plan's five modes, `scope` includes
  `plan-journal`, and `eventCursor` says why the status bar's cell stays empty.*
- **Protocol version:** the template methods and now `workflowDrafts.*` were added at 2.0
  without the minor bump the version rule calls for. **Open decision.**
- **The artifact was never republished.** It still shows the v0.3-era state. Republishing it
  from `docs/design` and `packages/design` is follow-up 13, and is next.

## Open follow-ups

The undocumented drift worth deciding on, roughly most visible first. Each is either a fix or
a line in `docs/design` saying it is intended.

1. Attention: add the "1 new" rule so new items stop re-sorting under the cursor.
2. Tool calls: interleave them with the output instead of listing them above it.
3. Artifact panel:
   - Make provenance links.
   - Add **Open externally**.
   - Enter diff by ⇧-selecting a version.
4. Dependency graph:
   - Arrowheads.
   - A `⊘` on waived edges.
   - Dim nodes off the hovered node's path.
   - Ask for a waive reason.
5. Config:
   - Show a modified field's previous value.
   - Show unknown keys.
   - Open the raw view at the path in the studio.
   - Reuse `DraftBar`. The template editor's bar also draws `.orca-draftbar` by hand, and so
     without `returnFocus` or a note that gives way.
6. Risk matrix: decide on the axes, and document the choice or flip them.
7. Workflow viewer: draw a pinned run's own version with `workflows.get({ id, version })`.
8. Status bar: add the "runs active" count, which the app already reads.
9. Object header: chain elision and ids in mono. *Both closed. Elision: a trail that does
   not fit folds its middle into a `…` menu; ids: every crumb with an ORCA id carries its
   token and **Copy id**. See "Fixed after the review".*
10. Palette: the prefixes and the nearest-prefix no-results message.
11. Workflow editor, still to build:
    - Dry run (#183).
    - A `draft.changed` notification.
    - The rename alias.
    - The count of runs pinned to the base version.
    - The validation rules the runtime lacks.
12. Docs: fix the `40` and `60` contradictions and the stale `component-api.d.ts` comments.
    *Closed: see "The design-system source layer".*
13. Republish the Claude Design artifact from `docs/design` and `packages/design` so the
    review surface matches the source again. *Closed: republished as version 8 on
    2026-10-11. Every card was re-synced, seven were added (ObjectId, KeyValueList, Menu,
    CanvasControls, GraphMinimap, InlineConfirm, TextOverflow), RULES.md became a section,
    and the bundled fonts travel with it. The previews draw what the app draws, and their
    READMEs name the gaps below where they apply.*
14. Links to objects that aren't there. Plan and Workflows report one. Two gaps remain:
    - Runs and Agents say nothing for an id they don't have.
    - `orca://agent/<id>` lands on Agents without selecting that agent's card. The route
      never reaches the surface, although `10-information-architecture.md` promises "that
      agent's card".
15. **Claims held by finished runs.** The demo lists claims whose owning run has
    *succeeded*, and each one is releasable by hand. Should a run that ends release its
    claims itself? That is a daemon question, deferred; nothing in the app changed for it.
16. **The CLI and the daemon take only whole ids.** A person now reads `☰ JH7X8P` in the
    app, and **Copy id** gives the whole id to paste; accepting a unique id suffix in `orca`
    commands and in `runs.get` would let the token itself be typed. That is a protocol
    change, deferred.
17. **Request crumbs have no name to lead with.** `runs.list` and the plan's read models
    carry `requestId` and no request title, so a request is its token alone in the Runs
    header, the Plan table and the Plan rail. Carrying the title on those read models would
    let request crumbs lead with a name like every other object.
18. **Run-tree rows carry no id token.** A run row shows the run's name, and runs of one
    workflow often share one. The token would tell them apart, but the run tree's columns
    were not re-sized for it in this pass.
19. **The type-proof baselines are stale on Linux and macOS.** The object-kind glyphs (❝ ◫ ⊓ ✦),
    the Workflows rail's ⑂ and ObjectId's id samples changed `#type`. The Windows baseline is
    regenerated (locally, `pnpm run app:type-proof:update`, and checked by eye); the Linux and
    macOS ones need a manually dispatched App smoke run (`docs/DEVELOPMENT.md`, "Screenshot
    baselines").
20. **A long linear workflow fits at 25% and is still too small to read.** Zoom to fit
    centres a graph too wide even for 25% on its middle, with the minimap for the rest. An
    idea: open a long chain top to bottom by default, where its length runs down the pane.
21. **The armed row is one surface's.** Confirming in place is a pattern with one list
    instance (`ClaimRow`) and the palette's; the second list with an act that has no way back
    should lift `ClaimRow`'s state machine into `renderer/src/ui/` rather than copy it
    (`component-api.d.ts`, "Confirming in place").
22. **Found while republishing the artifact.** Drawing every card against the app's real
    markup turned up these app defects. None is fixed yet:
    - **Destructive confirmations that break rule 17.** In each case the danger choice comes
      first or lacks its `✕`:
      - the workflow editor's armed "Discard every change" (no `✕`);
      - the dependency graph's waive question ("Waive, unblocking …" before "Keep it", no `✕`);
      - the decision list's reopen ("Reopen <key>" before Keep, no `✕`).
    - **The Plan schedule's "why" menu is clipped.** It sits inside `.orca-plan__cell`, which
      is `overflow: hidden`, so the open explanation does not show.
    - **The risk matrix does not hold its plot.** `.orca-risk` is `table-layout: fixed` with no
      width, so a long pin widens its column. A pin button stays as wide as its unwrapped text
      and runs past its cell. The score is drawn over the first pin. Pins carry their text in
      `aria-label` but not in `title`.
    - **The workflow viewer ignores positions pinned in the editor.** `layoutWorkflow` takes no
      pins, and `workflows.get` carries no layout.
    - **Classes with no rule:** `.orca-link`, `.orca-menu__item[aria-disabled]`, the run
      picker's `orca-button*`, `orca-kv__well`, `orca-agents__claim-keep` / `-confirm`. The
      editor inspector's textareas are clipped, and its group headings have no type class.
    - **Tone and text slips:**
      - Attention gives failed rows the waiting rail.
      - A config group card's eyebrow takes the gate card's `status-waiting` tone.
      - The `risk.updated` journal line prints a raw `risk_…` id.
      - A few counts still join with a plain space (`${n} inside`).
    - **The configuration studio (#333) hand-rolls its save bar.** It has no change count, no
      `returnFocus` and no giving-way note, unlike `DraftBar`.

## Repeating this review

1. Read the artifact's files: the Artifact tool's `read` with `paths` for `project/README.md`,
   the eight sections, `tokens.json`, `components/bundle.css`, `components/index.d.ts` and
   each `components/<Name>/README.md` and `preview.html`.
2. Compare tokens programmatically against `packages/design/tokens.json`, by family and name.
   It is a list format, not DTCG.
3. Review each area's components and screens against `packages/app/renderer/src`. For every
   divergence, check `docs/design`, `RULES.md`, ADRs and comments before calling it drift.
4. Run the app and look: `node .claude/skills/orca-demo-dev/scripts/start.mjs --seed` builds a
   workspace with data on every surface and starts the daemon and the app. The first pass of
   this review did not, and the three layout bugs above were found by looking. Measure what a
   test cannot: happy-dom has no cascade or layout, and the crumbs' 14px and the `ch` half-em
   were found in a real Chromium.
