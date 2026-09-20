# Data connection states

The app has five connection states. Each has one canonical rendering, used in the status bar
and, where it changes what a screen can show, as a banner on that screen. The rule underneath
all of them: **the app never shows a value that might be wrong without saying it might be
wrong.**

| State | Status bar | Banner | Data shown | Writes |
| --- | --- | --- | --- | --- |
| **Live** | `● connected` in `status-succeeded` | none | live | enabled |
| **Reconnecting** | `◌ reconnecting… 3s` in `status-waiting`, spinner | none for the first 5s, then a thin bar on affected screens | last-known, values at `opacity-stale` | queued, buttons show "will send on reconnect" |
| **Disconnected** | `◷ disconnected · 2m ago` in `status-stale` | persistent bar on every screen with data | last-known, values at `opacity-stale`, every timestamp switched to absolute | disabled with the reason on the control |
| **File mode** | `◷ file mode · read-only` in `status-stale` | persistent bar naming the store being replayed | whatever the event log and artifact files contain, replayed | disabled, and the buttons are absent rather than disabled |
| **Version mismatch** | `▣ daemon 0.11 · app 0.9` in `status-blocked` | blocking dialog on first detection, then a persistent bar | last-known | disabled |

## Reconnecting

Silent for five seconds, because a WebSocket blip that resolves in 400ms should not flash a
banner at someone reading a log. After five seconds the status bar changes and a 2px bar
appears under the object header on screens whose data is now stale. Streaming panes keep the
output they have, mark the stream `◷ paused — reconnecting` inline at the point the stream
stopped, and resume in place when the connection returns, with a `── reconnected 14:07:22 ──`
rule in `ink-tertiary` so the seam in the log is visible rather than invisible.

## Disconnected

Every value keeps its label at full strength and drops the *value* to `opacity-stale`; the
label tells you what you are looking at, the dimming tells you not to trust its freshness.
Relative timestamps ("6m ago") are replaced by absolute ones, because a relative time computed
against a stale clock is a lie. Running steps do not keep animating: the pulse stops and the
glyph becomes `◷`.

## File mode

A genuinely different product mode, not a degraded one, and the design says so: the banner
names the store being replayed and offers **Connect to a daemon**. What is chosen is a
workspace, not a single log file — a run's history is its event log and its artifacts
together, and half of it is not a mode. Writes are *absent*, not
disabled — a screen with no cancel button reads as a viewer; a screen with a greyed cancel
button reads as broken. The event timeline and run tree are fully usable, because they are a
replay of the event log either way; what is missing is streaming, gates and control.

## Version mismatch

Blocking, once, with the two versions and what is likely to break, then a persistent bar. The
app stays readable because the event log format is the compatibility surface, but anything
that requires an RPC the app cannot type-check is disabled and says why. Never attempt a
partial degradation the person cannot see.

## Where the implementation stands (#163)

The machine is `packages/app/src/main/connection-state.ts` — the one place `SubscriptionState`,
the `hello` result and a bundled daemon's exit are folded onto these five states.

**The reconnect seam is real** as of #158: the output pane marks `◷ paused — reconnecting`
where the stream stopped and draws the `── reconnected hh:mm:ss ──` rule when it returns,
driven from `useConnection()` transitions. It is not a live region (rule 11) — the status bar
has already said the word.

**`reconnecting` gives up at backoff saturation** as of #239: three consecutive failures at
the 5s cap — about twenty seconds of real silence, and the seventh failure overall with
today's `RECONNECT_BACKOFF_MS`. It is a fact about the retry loop rather than a stopwatch, so
it survives a change to that array, and it is a *rendering* change: the subscription goes on
retrying, because giving up for real would need a reconnect control and nothing has one.
`DaemonSubscription` reports its retry count beside its state — on every failure, not only
the first, since the count is news when the word is not — and `connectionStateFor` reads it.

**File mode is implemented** as of #164, and it is `orca serve --read-only` over a chosen
store rather than a second store path in the renderer (ADR 0008). File ▸ Open a store… stops
the daemon this process started, starts one with `--read-only` on the chosen workspace and
resets the machine (`src/main/workspace.ts`). `runs.control` is then absent from `hello`, so
the writes are already *absent* through `useWritability()` and the bar only has to name the
store being replayed and offer **Connect to a daemon**. The mode is an *input* to the machine
rather than something it can deduce: nothing about the socket or the handshake distinguishes
a read-only daemon from a writable one, which is why `ConnectionInputs` carries it.

One thing above is still not true, and is written here rather than approximated in code:

- **Writes are not queued while reconnecting.** There is no outbox — that belongs with the
  control methods — so a control says "the daemon is not answering; wait for the connection to
  come back" rather than promise a send the app cannot make. The table's "will send on
  reconnect" is the intent, not the behaviour.

The two classes this spec needs are now in the component layer (#240): `.orca-stale-rule` for
the 2px bar, and the `.orca-dialog` family for a blocking dialog that is not the command
palette. `renderer/src/chrome/connection.css` is gone — the app writes no CSS of its own for
these states. The second blocking dialog the design wants is the gate card, and it inherits
all of it.
