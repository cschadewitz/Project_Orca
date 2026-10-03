# Preview, consent and state specification

A wireframe/state proposal for #416 and #386/#389 integration, not a shipped UI. Build
future UI from `ui/` primitives, `Menu`, `KeyboardMap`, the layer stack and tokens under
[design rules](../../design/RULES.md). No literal design values are proposed here.
No completion percentage, ETA or agent cost is available or implied.

## Manual entry and consent copy

Entry: “Preview diagnostic file” remains accessible before daemon handshake and offline.
It does not capture until the tester chooses **Allow once**. No selected checkbox, default
approval, upload preference or previous export substitutes for consent. Normal ORCA use
continues when the tester declines or cancels.

> Prepare diagnostic metadata once?
>
> ORCA will prepare available app and system versions, connection and failure categories,
> bounded timings, and counts of missing information. This one-time action ends when the
> preview is ready, after one minute, or when you cancel. It does not read prompts, source
> code, agent output, logs, configuration or private execution records. Missing information
> is shown as “unknown.” Nothing will be sent. You can review every byte before saving a
> local file. Saving and sharing are separate choices.

Buttons: **Cancel** (initial focus), **Allow once**. “One minute” is D1's unapproved proposed
ceiling. Preparing captures only current safe observations and subsequent safe events in
that scope; it does not retroactively retain history. A failure that occurred before
consent may have a safe current outcome; without one, it stays unknown.

Separate settings action: **Keep diagnostic metadata temporarily** (off by default).

> Keep a temporary diagnostic history?
>
> With this separate permission, ORCA will retain only the listed diagnostic metadata in
> protected local storage, up to 2 MiB and 2,048 events, for up to 24 hours. It stops on
> expiry, opt-out or app restart. It never sends this history. Exporting still requires a
> separate preview and save action. Turning this off stops collection, invalidates open
> previews and deletes ORCA's diagnostic history. Files you saved and copies you shared
> remain under your or the recipient's control.

Buttons: **Keep off** (initial focus), **Allow temporary history**. Display remaining
retention duration when measurable, never a fabricated clock. “2 MiB / 24 hours” are
review proposals, not accepted policy. Manual export does not depend on upload consent;
there is no upload consent or network sharing implementation in this stage.

For rolling export, a separate action says **Preview current history** and explains that
only the latest eligible safe events (at most 256) will be included. It freezes a snapshot;
ongoing history does not mutate that preview. Turning history off invalidates the snapshot.

## Ready preview wireframe

```text
Diagnostic file preview                         [Cancel]
Nothing has been sent. Review the entire file before saving.

Included: versions, safe outcomes, relative timings and local aliases
Unknown: [explanation of unknown values in this exact snapshot]
Omitted: [unavailable / invalid / budget / expired counts, or unknown]
Never included: prompts, code, outputs, logs, configuration, private records

Exact file content — [actual byte count] bytes
+-------------------------------------------------------+
| [entire canonical JSON, read-only and scrollable]      |
| [all fields and events, no ellipsis or hidden payload] |
+-------------------------------------------------------+

Save locally to: [chosen full local path; UI only] [Choose location]
This JSON file is readable by anyone who can access it.
Metadata may identify you in a small group. Choose carefully where
it is saved; a synced folder may copy it elsewhere. You decide if
and with whom to share it. Recipient copies cannot be recalled.

[Back]                                      [Save local file]
```

The destination picker proposes `orca-diagnostic-<reportId>.json`; no date, username,
workspace name or title. Saving stays disabled until the local destination is selected
and displayed. A native picker may choose it first, but return to this preview for final
confirmation; choosing a destination is not consent to write. A destination path is only
UI state and never serialized, scanned into a bundle, logged or sent to the daemon.
Explain that external sync software is outside ORCA's control; do not promise it is absent.

The human summary is derived from the same frozen object and cannot hide fields. Counts
are safe-observation omissions; no inventory of excluded private sources is performed.
Unknown and saturated counts get literal explanations, not invented numeric totals. The
full read-only JSON remains keyboard-selectable and readable; no copy-all auto-action.
A selected fixture's exact bytes and digest are in [fixtures](fixtures/README.md).

## States and transitions

| State | Allowed action / event | Result and data lifetime |
| --- | --- | --- |
| Off | Open preview or history disclosure | Disclosure only; no capture/disk/network |
| Disclosure | Cancel / decline | Off; normal execution unaffected |
| Disclosure | Allow once | One-shot preparing, one 2-second active preparation deadline within 60-second grant |
| Disclosure | Allow temporary history | Rolling starts only after storage/key/ACL preflight succeeds; grant lasts at most 24 hours and never survives restart |
| Rolling | Preview current history, explicit snapshot consent | Preparing a bounded immutable snapshot; rolling grant remains separate |
| Preparing | Success | Validate and scan a single frozen byte buffer; ready preview, no file yet |
| Preparing | Cancel / back / expired / throw / deadline | Invalidate snapshot and one-shot grant, no raw fallback. Rolling producer failure stops rolling and invokes protected cleanup |
| Ready | Choose location / change destination | Same exact bytes, selected destination visible; invalid destination disables Save |
| Ready | Save local file | Revalidate grant, buffer identity and destination; save exactly once with owner-only creation and atomic publication |
| Ready | Back | Discard snapshot and one-shot grant, return to disclosure; rolling setting unaffected |
| Ready | Cancel / preview expiry / opt-out / restart / uncertain clock | Discard bytes; no save. Opt-out/restart/expiry also stops and purges rolling storage |
| Saving | Cancel / I/O failure / disk full | No successful final file; remove only operation-owned temporary file. Show cleanup-pending if necessary, never report success |
| Saving | Atomic publish wins cancellation race | Show that the file was saved; cancel cannot claim to undo an already committed file. No transmission occurred |
| Saved | Close | Off for one-shot, rolling continues only under its existing grant; discard preview memory. No share action is triggered |
| Failure | Retry | Return to appropriate disclosure for a new grant/snapshot; no automatic retry or unsafe-source fallback |

Save rechecks consent immediately before publication; opt-out invalidates all prepared
buffers and generation tokens. A successful atomic publication is the precise local-save
commit point. Partial file/cleanup failures never cause retry of execution operations.
Retry after a save failure re-prepares with new consent rather than keeping an invisible
stale buffer. Restart is off, clears previews, revokes old diagnostic key and attempts
orphan cleanup; it never resumes old collection automatically.

Wall-clock movement neither extends nor shortens an active grant: use a monotonic source
that accounts for sleep. If elapsed time cannot be trusted on wake/discontinuity, expire
conservatively. Purge before accepting another event. The
[state fixtures](fixtures/state-cases.json) specify these expected traces; named actions
abbreviate the full consent/destination flow above. They are not executable runtime tests.

## Keyboard, accessibility and byte-equivalence obligations

- All actions have accessible text names. Tab order follows disclosure, summary, JSON,
  destination, Back, Save; Cancel is the safe initial disclosure action. No focus hidden
  behind overlays; Esc uses the existing layer stack to cancel and restore trigger focus.
- Use existing keyboard-map commands for entry/retry; menus use `Menu`, never a competing
  focus handler. Announce preparation completion/failure once through the existing live
  region. Do not announce every JSON line or rolling event.
- The JSON region has its own named keyboard-focusable scroller; summary/actions remain
  reachable at a 340px-high window and with zoom/large text. If the overall surface needs
  a root scroller, bound the exact-content well deliberately and test nested focus/wheel
  behavior. Do not trap keyboard scrolling or let body clipping hide the save controls.
- Read-only exact text preserves whitespace; screen-reader users can access the complete
  content and unknown/omission explanations. Colour never carries meaning alone. Test
  both themes, visible focus, VoiceOver and Windows screen reader behavior on real builds.
- Tests bind the preview text, original immutable bytes, byte count and final disk bytes.
  Assert exact byte equality including final LF, all fields/events, before and after
  changing destination; rejection/cancel/expiry must not write or share. Inject a changing
  collector while reading preview and prove the saved file stays the frozen snapshot.
- Target-like participant must explain included/excluded information, unknowns, destination,
  separate sharing and recall limits without coaching. Save is never named “Send.”

All accessibility, participant, concurrency, save-cancellation and byte-on-disk checks
above remain **not run** in this preparation. The offline serialization test proves only
that the committed synthetic JSON has the proposed canonical bytes.
