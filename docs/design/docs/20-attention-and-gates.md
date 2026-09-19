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

A permission ask is more urgent than a gate because an agent turn is held open and a host is
occupied while it waits. It is the only thing in the app that may steal focus, and only when
the window is already focused — it never raises the window.

## The count is one number

The title bar shows `◆ 2 waiting` in `status-waiting` whenever any tier-1 or tier-2 item is
open, and nothing at all when none is. It is a button; it opens Attention. The sidebar's
Attention row carries the same number. There is exactly one number in the app for this, and
permission asks and gates are summed into it — a person should not have to learn two counters
to know whether they are needed.

## Answering

Gates and permission asks are answered **in place, from either surface**. The same
`GateCard` / `PermissionCard` component renders in the Attention list and inline in the run,
with identical controls and identical keyboard handling. Answering from the list keeps the
person in the list and advances focus to the next waiting item, so five gates can be cleared
in five keystrokes without navigating.

Keyboard, on a focused card: `1`–`9` select an option, `Enter` submits the selected option,
`Shift+Enter` submits with a note, `G` jumps to the run the card came from, `J`/`K` move
between cards. The destructive option is never bound to `1` and never focused by default.

## What an answer must show before it is given

Every gate card carries, without a click: the question, the run and work item it belongs to,
how long it has waited, the artifacts the decision is about (as chips that open the docked
panel), and the options with their consequences. If a gate's artifacts have not loaded, the
options are disabled with the reason stated — the app does not let a person approve something
it could not show them.

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
