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

If you pick B, the three concrete changes to the rest of the system are: the Plan sidebar
loses its Schedule/Dependencies/Risks/Decisions/Journal list in favour of requests and
filters (as drawn in Option B); the object header gains a mode segmented control, which is a
new `ObjectHeader` variant; and the docked panel becomes a Plan surface as well as a Runs
surface, which its component spec should then say.
