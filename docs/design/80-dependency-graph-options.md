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
- **Two lists, two scopes**: the schedule table is `list`, the journal is `plan-journal`
  (`docs/design/50-accessibility-and-keyboard.md`).

What is *not* built, and is deliberately not stubbed: the graph, the risk matrix, the
decision matrix, the pinned row strip under the canvas, the second (graph-only) filter
rail, and `orca://plan?mode=deps&focus=…`. Every write on this surface is #178's.

If you pick B, the three concrete changes to the rest of the system are: the Plan sidebar
loses its Schedule/Dependencies/Risks/Decisions/Journal list in favour of requests and
filters (as drawn in Option B); the object header gains a mode segmented control, which is a
new `ObjectHeader` variant; and the docked panel becomes a Plan surface as well as a Runs
surface, which its component spec should then say.
