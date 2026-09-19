# Data connection states

The app has five connection states. Each has one canonical rendering, used in the status bar
and, where it changes what a screen can show, as a banner on that screen. The rule underneath
all of them: **the app never shows a value that might be wrong without saying it might be
wrong.**

| State | Status bar | Banner | Data shown | Writes |
| --- | --- | --- | --- | --- |
| **Live** | `● connected` in `status-succeeded`, event cursor ticking | none | live | enabled |
| **Reconnecting** | `◌ reconnecting… 3s` in `status-waiting`, spinner | none for the first 5s, then a thin bar on affected screens | last-known, values at `opacity-stale` | queued, buttons show "will send on reconnect" |
| **Disconnected** | `◷ disconnected · 2m ago` in `status-stale` | persistent bar on every screen with data | last-known, values at `opacity-stale`, every timestamp switched to absolute | disabled with the reason on the control |
| **File mode** | `◷ file mode · read-only` in `status-stale` | persistent bar naming the event-log path | whatever the event log and artifact files contain, replayed | disabled, and the buttons are absent rather than disabled |
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
names the event log path and offers **Connect to a daemon**. Writes are *absent*, not
disabled — a screen with no cancel button reads as a viewer; a screen with a greyed cancel
button reads as broken. The event timeline and run tree are fully usable, because they are a
replay of the event log either way; what is missing is streaming, gates and control.

## Version mismatch

Blocking, once, with the two versions and what is likely to break, then a persistent bar. The
app stays readable because the event log format is the compatibility surface, but anything
that requires an RPC the app cannot type-check is disabled and says why. Never attempt a
partial degradation the person cannot see.
