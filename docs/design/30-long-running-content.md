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

The renderer keeps the last 50,000 lines of a step's output in memory and the full log on
disk. When the buffer trims, a marker row in `ink-tertiary` says so and offers **Load earlier
output**, which pages backwards from disk. The app never silently shows a partial log.

Long single lines (a base64 blob, a minified bundle) are collapsed at 2,000 characters to a
`… 84,102 more characters` affordance rather than wrapped, because one such line can otherwise
own a screen. The glyph is `…` (U+2026), the bundled ellipsis — not the midline `⋯` (U+22EF)
this line used to ask for, which no bundled face carries and which would therefore have
fallen through to the OS in exactly the way #194 exists to catch. Bundling U+22EF instead is
a legitimate alternative; it is not a thing to reach for without adding it to
`tools/font-build/build-fonts.js` first.

## Time

Absolute times in `mono-id` for anything a person may need to correlate with another tool;
relative times in `caption` for recency ("14:02:31 · 6m ago"). Durations are rendered to two
units at most (`1h 12m`, `4.2s`). A duration that is still accruing ticks at 1Hz and no faster.
