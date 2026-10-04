# Screen and state inventory

One workspace and one verified human enrollment at a time. Three top-level SwiftUI
destinations: Attention, Runs and Connection. Approval summary, run detail and safe
artifact detail are pushed onto a navigation stack; Back returns to the prior row
and scroll position. A persistent read-only explanation says “View only. Use ORCA
on your desktop to act.” No approve, reject, launch, cancel, resume, standing grant,
revision composer, enrollment administration or offline command queue exists.
Refreshing and navigating are the only remote interactions.

| Screen | Read inventory and navigation | Bounded layout and accessibility |
| --- | --- | --- |
| Attention | Authorized pending summaries, kind (durable gate/live ask), run, step, last-observed time, owner availability and evidence completeness. Tap opens summary; badge counts only loaded authorized pending items, marked partial when paged. | Native lazy list; one scroll owner. VoiceOver reads subject, kind, status, age and missing context. No swipe actions. |
| Approval summary | Exact run/step/input identity; safe question/summary, lifetime, observed pending/answered/expired state, approved evidence references and explicit omissions. Durable gate can remain parked; a live ask expires with its owning callback. Never present either as actionable on phone. | Scrollable readable content; IDs use mono. Missing evidence says “Evidence unavailable; review on desktop.” No option controls or captured answer values. |
| Runs | Bounded authorized run summaries, workflow, status glyph and word, update time. Status filter is server-side over authorized scope; text filter is local over held rows and says “N of M loaded.” Run selection opens detail. | Native lazy list, stable IDs and selection. Load next page explicitly; no fabricated total or progress. |
| Run detail | Same run projection plus bounded step summaries and artifact references. Parent/child facts only if authorized and supplied. Failed/cancelled are distinct; a run can be lease-stale while the read itself is fresh. | One vertical scroll region, semantic headings; no raw log firehose, graph or editor in pilot. |
| Safe artifact | Run + artifact binding, source step, revision, media type, bounded plain text, omission/truncation explanation. Follow only already authorized evidence IDs. | Scrollable inert text, no WebView/HTML, image fetch, Markdown link activation or automatic URL detection. No share/export in pilot. |
| Connection | Verified workspace/principal/enrollment aliases, protocol/schema versions, read capabilities, connection state, last successful snapshot and reason. Distinguish notification permission from host reachability. | Scrollable at largest Dynamic Type. Refresh/retry is a read; recovery needing enrollment points to the independent desktop owner. No endpoint entry or secrets. |

## Shared state vocabulary

These states apply to every remote screen, not just Connection. Connection and
data freshness are independent: a healthy transport with a pending snapshot still
shows stale data. Store server `asOf` and local receipt time separately; absolute
timestamps include timezone. A client clock never changes authority or lease state.

| Condition | Presentation and permitted recovery |
| --- | --- |
| Initial loading, no cache | Named loading state; do not say there are zero runs/asks. Preserve focus and allow Back. |
| Successful empty page | “No pending decisions” or “No runs in this scope.” A denied read is never empty. Local filter with no matches offers Clear filter. |
| Partial page | Show loaded count and truncation/next-page notice. Never call a partial attention list complete. |
| Read failed | Sanitized category and Retry; retain eligible prior snapshot with an absolute as-of label. Do not show raw server diagnostics. |
| Missing capability | “This server does not provide [surface].” Other supported read screens work. No raw-RPC fallback. |
| Denied / revoked | Remove protected content and cached pages, cancel in-flight reads. Explain access unavailable and desktop recovery; do not reveal whether an inaccessible resource exists. |
| Artifact absent, redacted, binary, too large | Keep provenance that was authorized; show the exact omission class. Do not substitute empty text or imply evidence was reviewed. |
| Offline, cache present | “Offline. Last observed [absolute time].” Stop animation; retain last observed run status without turning it into a lease-stale run. Local navigation remains available inside cache policy. |
| Offline, no eligible cache | “Offline. No saved data available.” Retry only when foregrounded/user requested; no dummy rows. |
| Reconnecting / sequence loss | Mark data stale immediately internally. Hold only the transient connection banner for the design's five seconds; never delay denial, wrong-identity blocking or freshness labeling. Restore fresh label only after validated snapshot convergence. |
| Version mismatch | Explain required and observed major versions; block unsupported reads. Same-identity eligible cache may be shown explicitly as last observed. No guessed decoder or file-mode fallback. |
| Wrong host / principal / enrollment | Block before display; detach and quarantine old cache from navigation, discard mismatched response, request independent enrollment review. Never silently follow it. |
| Application suspended then foregrounded | Mark held state stale, rediscover identity and capabilities, reread before claiming current. A push hint or foreground transition is not evidence of fresh data. |

Connection state names/glyphs come from
[semantics.json](../../../packages/design/semantics.json): `live`, `reconnecting`,
`disconnected`, `mismatch`; `file` is reserved and unsupported on this phone.
Fixture playback is labeled “Synthetic preview”, never file mode or live ORCA.
Do not inherit the desktop semantics' `writes: queued` presentation: mobile writes
are absent in every state. New enums are protocol incompatibility, not a ninth run
status. All eight canonical run statuses have examples in `runs.json`.

## Native accessibility/design review gate

Use [RULES](../../design/RULES.md) and the existing tokens/semantic vocabulary as
inputs to a reviewed Swift adapter; do not reimplement React primitives in Swift
or copy literal colors/metrics into screens. Native Dynamic Type, touch targets,
focus and list behavior need an explicit native design mapping under #473. The
desktop fixed-row rule needs declared compact/large-text row variants before UI
implementation; do not clip text to preserve a desktop pixel height. New native
metrics belong in the token source with review, not this document's sample data.

Test VoiceOver reading order, headings, Back/selection focus restoration and
rotor navigation; hide decorative glyphs from duplicate speech. Use glyph + word
for every status, maintain light/dark and increased-contrast legibility, honor
Reduce Motion and avoid color-only freshness indicators. At all Dynamic Type
sizes, including the largest accessibility size, every word and last item must
be reachable in portrait/landscape on a compact phone. Full Keyboard Access and
Switch Control can navigate all reads. Announce transitions and new attention
once through a single native announcement coordinator; never announce streamed
output or every refresh. A stale/expired alert must not repeatedly interrupt
VoiceOver as a newly actionable approval.
