- **app:** the Plan surface — what is coming, why it is not moving, and what it depends on.
  The schedule table lists every work item in the order the scheduler put it, with its
  classification, slug, title, priority score, risk exposure and the run holding its claim;
  the badge's **why** opens the scheduler's own explanation, word for word, in the app's one
  popover. `orca://item/<slug-or-id>` lands here with that item selected and its explanation
  open, which is the last line of the deep-link table that named an unbuilt screen.
- **app:** the Plan sidebar is requests and filters, not a list of sub-screens (option B in
  `docs/design/80-dependency-graph-options.md`). Classification, status and request are
  `items.list` parameters the daemon applies to the whole plan; the text field narrows what
  is held, and the count says which — "3 of 9 items". The counts beside each classification
  are the plan's own.
- **app:** selecting a row opens the work-item inspector in the docked panel — the panel is
  a Plan surface as well as a Runs surface now. It shows the priority reasons verbatim, the
  item's dependencies with **both** the status stored on the document and the scheduler's
  live evaluation of it, the risks that name the item, and the claim as a link to the run.
  Every write on this surface is still the palette's (#178).
- **app:** a Journal mode over the plan journal: newest first, one row per entry with the
  daemon's own summary line and the origin that wrote it, paging backwards with "Load
  earlier entries". The surface repaints from `plan.changed` and never polls — a frame's
  `kinds` say which lists went stale, and a sequence number already folded is dropped.
- **app:** the object header gained a mode segmented control, a new `ObjectHeader` variant
  (`ObjectHeaderProps.mode`). It has two positions; the dependency graph (#171), the risk
  matrix (#172) and the decision matrix (#173) are absent from it rather than disabled,
  because a segment that never does anything is a dead end.
- **app:** a `plan-journal` scope in the keyboard map, for the second list on the screen —
  one `VirtualList` per scope, so `J` means "next" in whichever of the two the focus is in.
  `Enter` on a schedule row explains it. `docs/design/50-accessibility-and-keyboard.md` has
  the table; every key in it is in the command palette.
- **design:** `SCHEDULE_PRESENTATION` carries a glyph as well as a word for each of the five
  classifications, so a schedule badge is never its tint alone (rule 4). The wire's two
  settled classifications, `done` and `failed`, have no badge and are drawn with
  `StatusChip`'s succeeded and failed; `component-api.d.ts` says so. Five `col-*` tokens for
  the schedule table's fixed columns, and a `plan` crumb type.
- **design:** `Menu` takes an optional controlled `open` / `onOpenChange`, for the one case
  a surface cannot press a trigger itself: a deep link that has to arrive with the
  explanation already open. Everything else — focus in and back, `Esc` through the layer
  stack, the roving keys, the placement — stays the primitive's.
