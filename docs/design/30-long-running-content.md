# Long-running content

Runs last hours and produce output measured in megabytes. Four patterns carry this, and they
are shared by the run tree, the event timeline and the agent output pane.

## Virtualisation

Every list in the app is virtualised above 200 rows: the run tree, the timeline, the output
pane, the plan table, the journal. Rows are a fixed height (`row-comfortable` or
`row-compact`), which is what makes fixed-height virtualisation possible and is a reason the
density toggle changes a token rather than letting rows size to content. A row whose content
would wrap truncates with an end ellipsis and reveals the full string in the detail pane, not
in a tooltip.

The scrollbar carries a **minimap of status**: a 4px gutter with a tick in the status colour
for every failed, waiting or blocked row in the whole list, not just the rendered window. It
is the only way to know that something is wrong 4,000 rows below.

## Sticky context

The header of the current section stays pinned while its content scrolls: in the run tree, the
ancestor chain of the topmost visible row; in the timeline, the current step; in the output
pane, the current tool call. The sticky element takes `shadow-sticky` only while something is
scrolled beneath it. Past six levels of nesting the run tree stops indenting and relies on the
sticky ancestor chain, so a deeply nested step never starts 200px from the left edge.

## Following without losing your place

Streaming panes have two modes and one rule.

- **Following** — pinned to the bottom, new output scrolls in. The mode is shown by a
  `status-running` caret at the end of the stream.
- **Held** — the person has scrolled up. Following stops *immediately*, and a
  **Jump to latest** button appears at the bottom edge showing how many lines have arrived
  since (`↓ 412 new lines`). Nothing scrolls under the reader's eyes, ever.

The rule: scrolling away never discards buffered content, and returning to the bottom by any
means (the button, `End`, `G`) re-enters following. A finished run opens in held mode at the
top of the failing step if there is one, otherwise at the top.

## Buffering and trimming

The renderer keeps the last 50,000 **events** of a step's output in memory and the full log on
disk. When the buffer trims, a marker row in `ink-tertiary` says so and offers **Load earlier
output**, which pages backwards from disk. The app never silently shows a partial log.

Events, not lines, because a step's output *is* its `agent.update` events: there is no
separate log file, and `runs.events` pages over them with a `stepRunId` filter rather than a
method of its own (#158). One `agent.update` can render many lines, so 50,000 events is a
larger buffer than 50,000 lines, not a smaller one. The reason to count them this way is that
the trim boundary has to be addressable: **Load earlier output** pages backwards with that
event's cursor, and a line boundary is not a thing the wire can name.

Long single lines (a base64 blob, a minified bundle) are collapsed at 2,000 characters to a
`… 84,102 more characters` affordance rather than wrapped, because one such line can otherwise
own a screen. The glyph is `…` (U+2026), the bundled ellipsis — not the midline `⋯` (U+22EF)
this line used to ask for, which no bundled face carries and which would therefore have
fallen through to the OS in exactly the way #194 exists to catch. Bundling U+22EF instead is
a legitimate alternative; it is not a thing to reach for without adding it to
`tools/font-build/build-fonts.js` first.

## Rules and guides are borders, not glyphs

`mono-log` stays at **12px/18px**. The tight line height is the reason a screen of log is
worth scrolling, and it is what the whole pattern above is built on: fixed-height
virtualisation, the buffer size, the number of lines a failing step shows without scrolling.

The cost, found on `#type` and filed as #212, is that box-drawing verticals do not join at
that line height. A 12px glyph in an 18px line box leaves 6px of leading between one `│` and
the next, so a continuous guide drawn with `│` or `├─` reads as a dashed one. Loosening the
line height until the glyphs meet would trade the reason for the line height against the
appearance of a guide, on every surface that uses `mono-log`.

So neither: **the structure is drawn with CSS borders.** A guide down a nested subtree is a
hairline `border-left` (`orca-tree-guide`), the seam either side of a timeline marker is a
hairline `border-top` on a pseudo-element (`orca-timeline-rule`), and a step frame is a
bordered box. The system already draws every other separator that way — a hairline in
`border-hairline` — so the guides are not a special case, they were the exception. A border
is continuous by construction, scales with the pane rather than the glyph, and can be
coloured and dashed as a state without touching the text.

Box-drawing characters stay in the character stream itself: output an agent produced, a
`tree` command's output, a diff. That is content, not chrome, and it is rendered as it
arrived. The `#type` proof surface draws its frame with real U+2500–257F glyphs on purpose —
it is proving the bundled faces carry them on the same advance width — so the verticals on
that page show the gap. That is the finding, not a defect, and the page says so.

## Time

Absolute times in `mono-id` for anything a person may need to correlate with another tool;
relative times in `caption` for recency ("14:02:31 · 6m ago"). Durations are rendered to two
units at most (`1h 12m`, `4.2s`). A duration that is still accruing ticks at 1Hz and no faster.
