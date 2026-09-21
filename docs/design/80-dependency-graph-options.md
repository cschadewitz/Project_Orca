# Dependency graph: two options, side by side

Both are built, with the same graph, the same nodes and the same edges, so the difference you
are looking at is the frame and nothing else. They are in the component table as
**Option A · dependency graph** (`ScreenDepsDedicated`) and **Option B · dependency graph**
(`ScreenDepsMode`).

## What actually differs

| | **A — its own screen** | **B — a mode of Plan** |
| --- | --- | --- |
| Object header | Its own (`plan ▸ Dependencies`) | Plan's, with a segmented mode control |
| Selection | Independent of the schedule table | Shared: the selected row *is* the focused node |
| Filters | Graph-shaped, its own set | Row filters shared with Schedule; graph-only controls in a second rail |
| Canvas width | Full window minus the inspector | Full window; no inspector, a pinned row strip instead |
| Item detail | A relationship inspector on the right | The schedule row, pinned under the canvas, plus the explain popover |
| Deep link | `orca://plan/deps?focus=…` | `orca://plan?mode=deps&focus=…` |
| Cost of getting there | A navigation step from the table | A mode switch that keeps everything |
| Cost of leaving | Re-find your row in the table | Nothing |

## The honest objection to B

A mode with its own canvas and its own filter rail is a dedicated screen wearing a segmented
control. That is true, and the screen shows it: the second rail in Option B is the seam. What
survives the objection is selection and the back button — the two things a person notices
when they are doing the actual phase-2 job rather than admiring the IA.

## The honest objection to A

Nothing about the graph is *worth* a separate destination except its size. Every other reason
one might give — its own filters, its own inspector, its own link — B can have too, and does.
The one thing A genuinely gets is the inspector: a panel about the *relationship* (blocked by,
blocks, waive) rather than about the item as a row. In B, that content has to fit in the
explain popover or the pinned strip, and it is a squeeze.

## What I'd do

**Ship B, and keep A's inspector.** The graph becomes a mode of Plan, and the relationship
detail moves into the docked right panel — the same dock the artifact panel uses on the Runs
surface, which is otherwise empty on Plan. That takes B's shared selection and A's inspector
and drops only A's separate destination, which was the part nobody wanted.

The thing that would change my answer: if the graph turns out to be where you *start* rather
than where you land — if you open the app and go look at the dependency graph the way you'd
open a project board — then it deserves its own destination and A is right. That is an
empirical question about how you use it, and you will know inside a week of phase 2.

## As built (v0.5.0)

B shipped, with A's inspector, in #170 (`packages/app/renderer/src/plan/`). What is on
screen now:

- **The sidebar is requests and filters.** The plan's requests as a list, chips for the
  seven classifications with the plan's own counts beside them, and chips for the work-item
  statuses. Classification, status and request are `items.list` parameters, so the daemon
  applies them to the whole plan; the text field narrows what is held and the count says
  which ("3 of 9 items").
- **The object header gained the mode variant**, which is `ObjectHeaderProps.mode` and
  draws `.orca-seg`. It has **two** positions, Schedule and Journal. The graph (#171), the
  risk matrix (#172) and the decision matrix (#173) are v0.6.0 and are *absent* from the
  control rather than disabled in it: a segment that never does anything is a dead end, and
  the control will gain each position with the mode behind it.
- **The docked panel is a Plan surface as well as a Runs surface.** The schedule row's
  selection opens the work-item inspector there — title, slug, status, classification,
  request, the priority reasons verbatim, its dependencies with both the stored `status`
  and the live `evaluation.detail`, its risks and the claim. #171's relationship inspector
  (blocked by, blocks, waive) is the same dock with the edge selected instead of the row.
- **The explanation is the badge's `why`, in the one `Menu`**, listing `schedule.explain`'s
  lines word for word. `orca://item/<slug>` lands on Plan with it open, which is what made
  `Menu` take an optional controlled `open` — a link that arrives is not a click.

  **The lines are copied, not followed.** Choosing a row copies that line and nothing else.
  The lines name work items, decisions and risks — "waiting for decision datastore", "risk
  key-leak: open" — and none of those names is a link to the thing it names, because the
  surfaces that would receive them are #171's, #172's and #173's. That half moves with
  them; until then the one act a read-only popover can honestly offer is taking the line
  with you.

  **A failed read is not one of the lines.** A protocol error goes in the menu's `note`
  (added for this, `component-api.d.ts`) rather than into the list: a menu row is something
  a person can choose and copy, and an error folded in among the scheduler's own words
  would leave the clipboard holding a sentence ORCA never wrote about their work item.
- **The schedule table is eight columns**: classification, slug, title, request, status,
  priority, risk, claim, on fixed `col-*` tracks. The **status** column is the item's own
  stored status and is *not* the classification beside it — the classification is where the
  scheduler put the item, the status is what the item says about itself, and an item is
  routinely `pending` *and* `ready`. They are drawn so they cannot be confused: the
  classification is the tinted `ScheduleBadge` with the **why** on it, the status is a plain
  `Chip` carrying the word and glyph from `semantics.json`'s `workItemStatus` (added for
  this), with no tint at all — a tinted chip in ORCA means a run status.
- **The table pages.** `items.list` answers a window, so the surface sends its own `limit`
  and walks it with `offset`; "Load more items" sits in the bar beside the count and appends
  in place. The control is *not* a last row in the table: `.orca-list__scroller` clips what
  is inside it, and a row that is not a work item would be a row of a different height in a
  list whose arithmetic is `--row-h` (rule 9). The count says what is held, so "200 of 260
  items" is a fact with a control next to it rather than a number over rows that are not
  there.
- **Crumbs are `plan ▸ work item`, not `request ▸ work item`.** An item belongs to a request
  and the table has a column saying which, but the *object* on screen is the plan: the mode
  control, the counts, the filters and every read on this surface are the plan's, and a
  trail whose root is not the thing the header is about is a trail that leads somewhere the
  back-press does not go. A request is a filter here, not an ancestor.
- **`TimelineEntry` was not reused and was not promoted to `ui/`** for the plan journal,
  though the journal is drawn on the same `.orca-timeline-entry` class. The justification
  lives with the component, in `packages/design/src/component-api.d.ts`: an event row
  carries a run status, an event kind, a sequence range and a copy menu for an event id, and
  a plan journal entry has none of the four — it has an origin (who did it) where an event
  has a status (what happened). Sharing would have made four props optional to serve one
  caller each. What *is* shared is the class, which is where the grid, the row height and
  the truncation live.
- **Two lists, two scopes**: the schedule table is `list`, the journal is `plan-journal`
  (`docs/design/50-accessibility-and-keyboard.md`). Both hold a selection. A journal row's
  `Enter` does nothing yet — the acts a record of something that already happened could lead
  to are #171's and #178's — but the selection moves, because "where am I in this list" is
  not an act and does not wait on them.

What is *not* built, and is deliberately not stubbed: the graph, the risk matrix, the
decision matrix, the pinned row strip under the canvas, the second (graph-only) filter
rail, and `orca://plan?mode=deps&focus=…`. Every write on this surface is #178's, and every
link *out* of an explanation line is #171's.

If you pick B, the three concrete changes to the rest of the system are: the Plan sidebar
loses its Schedule/Dependencies/Risks/Decisions/Journal list in favour of requests and
filters (as drawn in Option B); the object header gains a mode segmented control, which is a
new `ObjectHeader` variant; and the docked panel becomes a Plan surface as well as a Runs
surface, which its component spec should then say.
