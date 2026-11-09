# Attention: the model

Several runs can wait at once, and a waiting run costs the person something every minute it
waits. The design treats "what needs me" as a first-class, always-visible quantity rather than
as a notification that can be missed.

## Three tiers

| Tier | What | Where it appears | Interrupts? |
| --- | --- | --- | --- |
| **Permission ask** | An agent is blocked mid-turn, wants to run a command or write a file | Title bar, Attention, the step it came from, OS notification immediately | Yes |
| **Gate** | A run is paused for a human decision | Title bar, Attention, the run it came from, OS notification after 60s | No |
| **Failure** | A run failed and will not proceed | Attention (below waits), the run, OS notification on run failure only | No |

A running run is **not** a fourth tier and is not in the count: it asks nothing of anybody.
It appears on this surface in one place only — where the empty state would otherwise be, when
nothing is waiting and nothing has failed — because the surface is the app's landing screen
and "your work is all moving, here it is" is a better answer there than "nothing needs you"
over a blank page (#256). The rows are the failures' rows, `Enter` opens the selected run, and
the moment anything waits or fails the tiers above take the screen back.

A permission ask is more urgent than a gate because an agent turn is held open and a host is
occupied while it waits. It is the only thing in the app that may steal focus, and only when
the window is already focused — it never raises the window.

## The count is one number

The title bar shows `◆ 2 waiting` in `status-waiting` whenever any tier-1 or tier-2 item is
open, and nothing at all when none is. It is a button; it opens Attention. The sidebar's
Attention row carries the same number, and so does the dock or taskbar badge — the same number
outside the window, since a person who is not looking at the app is exactly who it is for. It
is the daemon's own count (`inputs.list`'s `waiting`) rather than a tally any of the three
keeps, because three counters are three chances to disagree. There is exactly one number in
the app for this, and permission asks and gates are summed into it — a person should not have
to learn two counters to know whether they are needed.

## Answering

Gates and permission asks are answered **in place, from either surface**. The same
`GateCard` / `PermissionCard` component renders in the Attention list and inline in the run,
with identical controls and identical keyboard handling. Answering from the list keeps the
person in the list and advances focus to the next waiting item, so five gates can be cleared
in five keystrokes without navigating. That is the only thing that moves focus: an ask that
arrives, or one answered somewhere else, leaves the person on the card they were on — in the
note they were typing — and focus follows only when that card itself goes.

Keyboard, on a focused card: `1`–`9` select an option, `Enter` submits the selected option,
`Shift+Enter` submits with a note, `G` jumps to the run the card came from, `J`/`K` move
between cards. The destructive option is never bound to `1` and never focused by default.
`Enter` on a button inside the card presses that button — **Deny** selects deny, **Always
deny** sends its own answer — and never submits the card's selection in its place.

A note is part of the record: it is written onto `human.answered` beside the answer, so the
reason a person gave outlives the window they gave it in. The run does not branch on it — the
option id is the whole of the decision — and a card must not present it as anything more.

## What an answer must show before it is given

Every gate card carries, without a click: the question, the run and work item it belongs to,
how long it has waited, the artifacts the decision is about (as chips that open the docked
panel), and the options with their consequences. If a gate's artifacts have not loaded, the
options are disabled with the reason stated — the app does not let a person approve something
it could not show them.

A permission card carries one thing more: **who is asking.** An agent's turn is what is being
held open, so the card names the agent and the host it runs on — "claude-local on build-01" —
rather than only the run, because that is what makes "always" a grant a person can size. A
workflow gate has no agent, and saying nothing is the honest answer there.

**Always allow** and **Always deny** answer this call the same way as the rule they write.
Each sends the selected option when it goes that way, and otherwise the one option that does.
An option is a rejection when it is marked `destructive`, which the engine reads off ACP's
`reject_once` / `reject_always` kinds. When no option, or more than one, goes that way and the
selection doesn't, the button is disabled and says why. It never sends an allow with a deny
rule. The daemon refuses that mismatch from any client too.

## Request changes and recorded corrections

A gate that offers a revision action also carries a **Request changes** form
(`attention/revision-card.tsx`, docs/revision-input.md). It is the same component on Attention
and inline in step detail. It is shown only when the gate names its current revision boundary,
the decision's artifacts have loaded, and the connection supports revisions. Otherwise the card
says which of those is missing in one `caption` line instead of offering the form. A submitted
correction stays on the surface as a **Recorded correction** card while it is pending. It can
be edited only while the daemon says a replacement is still allowed, and **Refresh correction**
re-reads it. The person's draft is kept while it re-reads.

## Scoped permission choices

A permission card can carry a **scoped permission review** in place of its plain options
(`attention/scoped-rule-choices.tsx`, #702). It separates three outcomes and says which one
happened:
- a one-time answer, which creates no rule
- a denial, which creates no rule
- a reviewed rule save, which does not approve or dispatch the call it came from

A stale review is sent nothing and can be reviewed again. A reply lost after dispatch is
reported as uncertain, not refused, and the card tells the person not to repeat the choice
until they refresh. As of 0.7.0 this is inactive: it renders only when an owner injects a review
port, and no production registration or policy default changes.

## Notifications

OS notifications are opt-in per tier and default to permission asks only. Clicking one focuses
the window and opens that card's deep link. Notifications are coalesced: a second ask while
one is unanswered updates the existing notification's count rather than posting a new one.
When the app is unfocused for longer than a configurable interval, gates escalate to
notifications too.

## Auto-approved gates

A gate that the config auto-approves never enters this system. It appears in the event
timeline as an `auto-approved` entry in `ink-secondary` with the policy that approved it, so
the record is complete, and it never raises a count.
