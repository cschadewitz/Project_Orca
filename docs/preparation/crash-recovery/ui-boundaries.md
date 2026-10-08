> Decision 9 (4 October 2026) and the current implementation instruction supersede any pending-owner-review wording below for fixed private plaintext staging, same-filesystem no-replace destinations, content-free key-independent metadata and visible residual plaintext cleanup failures. Acknowledged summaries are removed on opt-out after cleanup completes; unresolved obligations remain until safely resolved. Native/independent acceptance remains separate.

# Crash-recovery diagnostics: UI and bridge boundaries

Preparation for [#469](https://github.com/cschadewitz/Project_Orca/issues/469), within
[#416](https://github.com/cschadewitz/Project_Orca/issues/416). This is a UI companion to
the lead-owned [engineering contract](integration-contract.md), frozen for technical/privacy
review; it does not implement or activate a screen. The
[consolidated decisions](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976190374)
settle the product scope. In particular, the
[persistent-setting decision](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976121327)
supersedes routine restart re-consent. The contract is authoritative for numeric budgets,
deadlines, clocks, storage and key lifecycle. Any material retention, consent, collection,
sharing or exposure change returns to Casey and Cal. Actual user opt-in, technical/privacy
review, independent review and native acceptance remain separate gates.

## Existing ownership and source seams

| Owner / source | Reuse and boundary |
| --- | --- |
| [#438](https://github.com/cschadewitz/Project_Orca/pull/438), `docs/preparation/manual-diagnostics-implementation/` | Decision preparation for #436. Extend its questions with a crash addendum; its volatile-only recommendation is not a decision for #469. |
| [#441](https://github.com/cschadewitz/Project_Orca/pull/441), disabled app-main pre-trigger buffer and draft schema | Buffer/coverage/omission work belongs to that PR. Its `start()` has no production caller and is not consent; its frozen snapshot gives no save authority. Recheck its head before integration. |
| [#455](https://github.com/cschadewitz/Project_Orca/pull/455), synthetic benchmark | 5,250 offered events, 4,096 retained, 1,154 evicted; retained coverage was 238.95 seconds. This does not measure the newly approved 8,192-event ceiling. Five minutes is a configured horizon, not guaranteed coverage. Linux/tmpfs numbers prove neither native checkpoint latency nor durability. |
| `docs/preparation/manual-diagnostics-contract/` | Draft closed schema, privacy model, exact-byte preview, consent states and fixtures from #421/#430. Old rolling caps, volatile restart behavior and prose remain proposals; #469 must reconcile them. |
| `packages/app/renderer/src/App.tsx`, `routes.tsx`, `chrome/surfaces.ts` | Five existing surfaces and no diagnostics UI. The app chrome owns entry/navigation. Manual entry must remain reachable before daemon handshake and while offline. |
| `packages/app/renderer/src/config/preferences-section.tsx` | App-owned preferences are distinct from daemon configuration. A future rolling-capture disclosure/setting could be discoverable here, but immediate-save preference behavior is not consent and cannot imply automatic capture. Placement awaits UX review. |
| `packages/app/src/bridge.ts`, `src/preload/index.cts`, `src/main/index.ts` | The context bridge is the sole renderer-to-main path. Generic daemon handlers await `workspace.ready()` and reject stale target epochs; pre-handshake diagnostics need a narrow main-owned path that does not wait for the daemon. The #469 lead owns these shared files. |
| `packages/app/renderer/src/daemon-connection/boundary.tsx` | A target change unmounts or inerts the old child tree and may wait for draft disposal. Main must separately invalidate any preview/save authority; renderer unmount is not revocation. |
| `packages/app/renderer/src/layers-context.tsx`, `a11y/announce.ts`, `ui/` | Reuse the one layer stack, keyboard map, announcer, `Button`, `Text`, `StateView`, `ConfigField` and `Menu`; no second Escape handler, live region or popover focus system. |

The current bridge has no diagnostics API or local-save dialog. `src/main/index.ts` has an
open-store dialog, an example of main owning native UI rather than an export path.
`src/main/admission-intents.ts` has an unrelated encrypted journal. It offers publication
and test patterns but cannot supply diagnostics keys, payloads or failure semantics.
The renderer must never read execution stores, logs or raw daemon replies to construct a
report. #386 and #389 own onboarding/support wording; #390 owns physical acceptance.

## Consent and recovery visibility

Main owns the persisted setting and its consent-scope version, separate from per-process
authority epochs that are never restored after restart. An explicit choice after
the reviewed disclosure records opt-in for that exact scope. A matching valid record
survives restart without another consent prompt. Missing, corrupt, unknown or future
versions provide no authority; an unrelated saved preference, export or issue approval
cannot be migrated into opt-in. An editorial-only wording update preserves the same
scope version. A material expansion needs Casey and Cal's decision and a new explicit
choice; it cannot silently relabel an old record. Scope mismatch pauses affected operations
and offers review, with existing data still subject to its original expiry and deletion.

First launch offers `Keep off` and `Enable local diagnostics`, initially focusing the safe
decline. Dismissal leaves the setting off. Settings exposes the same disclosure, toggle
and 1–15 minute lookback control with five-minute default. A remembered opt-in expresses
user intent; runtime availability is separate and still requires current authority,
secure storage and the independent activation/acceptance gates.

Main's availability read is reachable before daemon handshake and while offline. With
the setting off, it reports off or cleanup pending without revealing recovered content.
With matching consent, it may report a generic previous-session candidate, its typed
availability state and supported actions. Candidate discovery is not authenticated
content: untrusted headers cannot supply event names, paths or a claimed retention age.
Authenticate and validate the bounded envelope and age before exposing report-derived
details. Only an explicit `Preview` action renders the recovered content; startup never
automatically opens a preview or saves it. `Discard` is available without decrypting the
payload. Recovery never extends expiry or starts execution actions. New capture after
restart uses the valid persistent choice and remains independent of recovery preview.

The state model distinguishes `off`, `enabled`, `unavailable`, `candidate`, `preparing`,
`ready`, `saving`, `saved`, `expired`, `deleting` and `cleanup pending`. A failed diagnostic
operation does not infer daemon connection state or change execution behavior. Safe
closed error codes carry no raw exceptions, diagnostic content or filesystem paths.

## Exact preview and export authority

Main permits one immutable preview across the application, replacing the previous handle
only after invalidating it and receiving the renderer's old-view disposal acknowledgment.
Its nonrenewing lifetime is five minutes; a recovered preview's expiry is
also clipped to the source checkpoint's remaining retention. A current-memory preview
uses its own freeze time and TTL. Reopening, destination
changes and Save retries never renew the original checkpoint lifetime. The handle binds
the exact canonical UTF-8 bytes, byte count and digest to consent generation, window,
target epoch and source generation. The renderer cannot submit arbitrary export JSON.
Its entire read-only exact text, including the final newline, is available without
ellipsis. The summary derives from those same bytes: included categories, honest unknowns,
omissions, effective coverage and checkpoint tail loss. Later capture never updates it.

Renderer reload, target change, cancel/back, expiry, source deletion or recovered-candidate replacement,
key loss and opt-out revoke the handle and destination/save authority not yet dispatched
in main. Already-dispatched publication retains only its pending outcome, not authority
for new work.
Current capture can continue independently: its preview pins an immutable snapshot id,
so routine CURRENT checkpoint refreshes neither revoke the preview nor change its bytes.
Replacing a recovered candidate invalidates its preview and requires a fresh explicit
Preview; a new generation can never silently retarget the old handle.
Releasing plaintext references is not a claim of immediate heap zeroization or forensic
erasure. A resource failure closes the preview and reports bounded unavailability.

The native picker selects a destination only. Main binds an opaque destination token to
the preview and displays the full selected path locally before a separate final `Save`
action. The path never enters the report, daemon traffic, settings or diagnostic logs.
Changing the destination revokes the prior token. No default path or picker completion
authorizes a write. One export can be in flight; repeated Save is rejected or joins that
same operation, never creating a second export. This first slice does not overwrite an
existing destination: `Choose a different filename` explains that limitation before Save.

Capture/checkpoint files and their staging files remain encrypted. In accordance with
[#470's clarification](https://github.com/cschadewitz/Project_Orca/pull/470#issuecomment-5976092045),
only explicit final Save may create one operation-owned restricted-access plaintext
temporary file for the exact reviewed bytes. The proposed
[export-cleanup correction](export-cleanup-proposal.md) places it in one fixed private
app-owned slot, with key-independent ownership/identity checks and no durable destination
path. Its 1 MiB allowance remains separate from the 4 MiB retained-store ceiling.
Only verified same-filesystem native no-replace publication is supported; explain
unsupported destinations before creating plaintext. Cleanup needs no retained diagnostics
key. Failed cleanup can leave plaintext in the private slot and blocks new Save; unknown
publication is reported separately. Decision 8 permits the explicit acknowledgement
flow below without changing the earlier unknown result. Remaining storage exceptions
need Casey and Cal review before
implementation, including its destination restriction and residual plaintext exposure.

## Save, discard, opt-out and replacement races

The lead-owned storage contract supplies the publication primitive and one ordering for
revocation and publication. Main rechecks the consent, preview, source, destination and
deadline immediately before native publication dispatch. A check followed by an unrelated
asynchronous rename is insufficient: there must be no gap where revocation can be accepted
and the stale write subsequently publish. Native publication dispatch is the point of no
return, ordered with revocation: a later opt-out revokes future work but must not claim
the already dispatched operation was canceled. Completion may remain pending; slow
filesystem work cannot block execution.

| Ordered outcome | Required UI result |
| --- | --- |
| Opt-out, discard, expiry or recovered-candidate replacement wins before publication dispatch | Revoke affected previews and queued writes immediately; cancel publication, remove operation-owned temporary files and show cancellation or cleanup pending. No stale Save success. |
| Publication dispatch wins before revocation | Show save pending until completion. If successful, report that Save was admitted before revocation and subsequently completed. The user-owned export remains; deletion must not claim to remove it. If publication fails, report failure and cleanup outcome. |
| Native completion is unknown after deadline or interruption | Show publication outcome unknown. Block while old work or staging remains unresolved; after proven cessation and verified cleanup offer explicit acknowledgement under the contract, then a separate new Save. Acknowledgement does not reconcile the missing outcome or mean no file was written. |
| A recovered candidate is replaced after its preview was prepared | Invalidate that source generation's preview and destination token. Never substitute new bytes into the old handle. Routine CURRENT checkpoint refreshes leave a pinned current-session preview unchanged. |
| Picker returns after cancel, target change or opt-out | Ignore its destination; no write and no restored authority. |

Opt-out stops capture and advances authority before asynchronous cleanup. It attempts deletion of
ORCA-owned history, previews and diagnostics-only key material; it never deletes shared
app material or user exports. Report durable opt-out success only after the disabled
setting and revocation are persisted. Only confirmed logical revocation followed by
a persistence failure says “Off for this session; the setting or cleanup could not
be completed.” A transport failure or stale request rejected before main accepts
revocation instead says it could not be confirmed and diagnostics may remain on.
Local preview disposal provides no revocation evidence; later authoritative On
status removes stale Off feedback. An app crash before durable
disable is a limitation to test, not guaranteed crash-proof revocation. Re-enabling waits
for old-state cleanup and cannot resurrect an old operation. Discard
deletes the selected retained source and its preview without silently changing the
persistent setting. The copy must say that new capture continues if enabled. Cleanup
pending is distinct from success and does not preserve Save authority. Clean exit deletes
the current session's checkpoint; a recovered previous candidate follows its original
expiry/discard rule.

## Draft user wording for technical/privacy review

The reviewed producer allowlist must substantiate every category claim before this copy
is used. These sentences propose the exact disclosure structure without approving new
content. #386/#389 retain onboarding/support ownership.

- First launch/settings: “Enable local diagnostics? ORCA keeps limited diagnostic metadata
  locally, encrypted on disk. The lookback defaults to five minutes and can be set from
  one to fifteen minutes. Size limits can leave less history. After an app crash, one
  previous session may be available for up to 24 hours. This setting stays on across
  restarts until you turn it off. ORCA does not upload this data. Preview and saving a
  local file are separate choices.”
- Durability: “Checkpoints are attempted about every five seconds. A crash can lose more
  than five seconds when writes are delayed or fail. Recovery after power loss is not
  guaranteed. This version cannot recover history after an operating-system restart or
  when its age cannot be verified.” Reboot-limited recovery is owner-approved;
  native clock verification and the remaining technical/privacy review still apply. Show latest completed checkpoint age or `unknown`, actual retained coverage
  and missing-history reasons next to the preview.
- Recovery: “Diagnostic history from a previous app session may be available. Preview it
  before deciding whether to save a local file.” Actions: `Preview` and `Discard`.
- Preview: “This is the complete content that will be saved. The preview expires at the
  time shown and may become unavailable sooner if its source expires or changes.” The
  absolute display time is advisory; main uses the contract's authoritative deadline.
- Save: “Save this exact content to the location shown? The file will be unencrypted.
  Other people or software with access to this location may read or sync it. ORCA will
  not automatically delete files you save. Saving uses a temporary unencrypted file in
  ORCA’s private folder. If cleanup fails, it can remain until cleanup succeeds.”
  Before confirmation disclose: “This version can save only to supported locations on
  the same filesystem as ORCA’s private staging folder.”
- Opt-out: “Turning this off stops collection and cancels saves that have not started
  publication. ORCA attempts to remove retained history, unsaved previews, temporary
  export files and diagnostics keys. An earlier save may still complete. Saved files
  remain yours. Cleanup failures will be shown; diagnostics keys are not kept merely
  to find temporary files.”
- Pending Save after opt-out: “Diagnostics are off. An earlier save is still pending.” Late success:
  “The save started before diagnostics were turned off and has now completed. ORCA
  will not delete that file.” Unknown outcome: “ORCA cannot confirm whether the earlier
  save completed. It may already exist. ORCA will not find, change or delete that file.”
- Save-again acknowledgement (decision 8): button `Acknowledge and save again`.
  “After ORCA confirms that the earlier operation cannot write and safely finishes
  cleanup, you can acknowledge the unknown result. This does not save a file. Review
  a current preview, choose a filename again, then select Save.” Show the reason when
  the button is disabled: earlier work may still write, or cleanup is unresolved.
  On commit: “Earlier result: unknown (acknowledged).” Before the next Save repeat:
  “An earlier export may already exist and will not be deleted.”
- Expiry: “Expired history cannot be opened. ORCA removes expired files when it next runs;
  it cannot remove them while closed.”
- Cleanup failure: “Diagnostics access is disabled. Some local diagnostic files could not
  be removed. Cleanup is pending. An unencrypted export temporary may remain.” Show
  this exception next to opt-out/Save status when applicable, and report key-wrapper
  cleanup separately from file cleanup and unknown publication. Do not claim secure erasure of storage, snapshots or
  backups; do not surface a raw exception as the explanation.

Acknowledgement is a main-validated, operation/epoch-bound action. It does not close
an unknown result as success, failure or cancellation. A valid current preview may
be reused; a stale/expired preview needs explicit preparation again. Always discard
the old destination/save token and require fresh native selection, then separate final
Save. “New” means freshly selected and currently nonexistent, not historically different.
No-overwrite refuses any earlier export at that name. Opt-out/scope/expiry gates still
apply; the acknowledgement action does not turn capture on or renew a preview.

While acknowledgement persistence is pending, disable duplicate action; repeated
requests are idempotent and never open a picker or save. Failed/uncertain acknowledgement
persistence remains blocked. Show the acknowledgement as complete only after durable
commit and revalidated cleanup/writer cessation. After restart never resume Save
silently. A newer successful Save leaves the earlier acknowledged result unknown.
Only the latest acknowledged unknown is detailed; if older outcomes are compacted,
show “Other earlier exports may also exist; ORCA does not keep a complete export history.”
The bounded summary survives restart as housekeeping metadata. Decision 9 requires removal on opt-out after cleanup completes; unresolved obligations remain until safely resolved. This grants no capture/save authority.

## Interaction and acceptance sketch

- Disclosure starts with safe decline/cancel focused. Consent is an explicit action; no
  selected checkbox, startup prompt or recovery banner silently grants it. A valid prior
  opt-in for the same scope persists across restarts. Pre-handshake and offline paths use
  locally known facts and honest unknowns.
- Use `useTransientLayer` for a transient disclosure/preview, the existing keyboard map
  for commands, and `Menu` only for a menu of choices. Restore trigger focus on close.
  Use the one announcer for preparation/save/delete outcomes; never speak each retained
  event or JSON line. Assertive announcements need the app's permission-ask rules.
- The app window does not scroll. Bound a named keyboard-focusable exact-content region
  and preserve access to summary, destination and actions at 340px height and large text.
  Keep the full content in the accessibility tree; verify both themes, visible focus,
  VoiceOver and a Windows screen reader on real builds. A new surface needs the repository's
  scroll and accessibility sweeps; a dialog still needs measured overflow.
- Test exact identity across preview text, byte count, destination changes and local file,
  including the final newline. Inject new events during preview to prove immutability.
  Test cancel/back/retry, repeated Save, opt-out/deletion versus queued or in-flight Save,
  cancelled picker, existing destination, disk failure and publication dispatch winning
  cancellation. Assert encrypted-only capture/checkpoint staging; separately test the
  explicit export temporary file's permissions, byte identity, lifetime and cleanup.
  Assert no diagnostic network path or execution mutation. Use bounded workers and
  disposable synthetic profiles. Add the acknowledgement/crash/repeated-click/previous-file
  cases C21–C26; verify failed cleanup/live native work cannot be bypassed.
  Test matching consent restart, mismatched scope, and
  late replies after each per-process epoch change.
- Packaged Mac/Windows tests must verify actual picker, permissions, key access, restart
  and screen-reader behavior. Linux/mock tests and #455's tmpfs results cannot establish
  these claims; #390 still needs its own physical Mac acceptance.

## Remaining review and acceptance

This note incorporates recorded product decisions and proposes engineering detail for the
single shared contract. It supplies no runtime implementation or technical/privacy sign-off.
Review the clock and key adapters, resource measurements, producer provenance, copy and
native publication/revocation behavior together before activation. The independently
reviewed implementation must stay default-off until actual user opt-in and retain the
separate native acceptance/activation gate. No synthetic result substitutes for packaged
Mac/Windows or physical-Mac acceptance, and #416 remains open.
