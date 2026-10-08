# Crash-recovery diagnostics: engineering contract RC1

Accepted disabled implementation contract, amended after export-cleanup review, for [#469](https://github.com/cschadewitz/Project_Orca/issues/469),
4 October 2026. **Owner direction is recorded; implementation and independent/native evidence do not authorize production activation.** This document is the single authority for
this slice's engineering parameters; companion storage, UI and test notes explain
it. It supersedes this directory's policy-neutral seam. It does not silently revise
or approve the older D1–D8 schema, one-shot flow or producer inventory.

## Recorded choices and review boundary

Read the consolidated [decision 6 and engineering gates](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976190374)
with its linked decisions 1–5:

| Product choice | Binding scope |
| --- | --- |
| Crash scope | One previous explicitly opted-in session after Electron main/full-app crash; no OS/power-loss survival guarantee |
| Retention | Up to 24 hours; refuse expired recovery and attempt cleanup when ORCA runs; clean exit removes the current session checkpoint; user exports remain user-owned |
| Consent | Persistent user setting, offered on first start, default off until explicit opt-in; same approved scope survives restarts; Settings opt-out stops capture, revokes unsaved authority and removes owned history |
| Cadence | Approximately five seconds, one checkpoint in flight; delayed/failed work can lose more than five seconds; show latest completed checkpoint age and omissions |
| Report | Whole-minute lookback 1–15, default 5; complete canonical uncompressed UTF-8 report at most 1,048,576 bytes and at most 8,192 events, whichever binds first |
| Keys | Separate diagnostics key protected by OS secure storage; unavailable protection disables persistence; no execution-key reuse, plaintext fallback or shared-key deletion |

These records report Casey's product direction. They are not a claim that Cal has
approved RC1, that technical/privacy review has occurred, or that a tester opted in.
The user authorized conservative engineering selection within these choices. Any
material retention, consent, collection, sharing or exposure change returns to
**Casey and Cal**. Do not turn a proposed budget into an accepted measurement.

The owner explicitly approved reboot-limited recovery in
[decision 7](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976357825). That availability choice is settled; native clock verification is still
required. [Decision 9](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5977241702) approves the export-cleanup correction below and the disabled implementation. It supersedes RC1's key-dependent external cleanup locator. Native technical evidence remains required.
[Decision 8](https://github.com/cschadewitz/Project_Orca/issues/469#issuecomment-5976828540)
approves the explicit bounded Save-again behavior below, replacing the indefinite
unknown-outcome block. Decision 9 settles the final bounded export design; material deviations still require owner review.

## Ownership, exact inputs and integration order

| Owner | Boundary / exact inspected head |
| --- | --- |
| #469 lead | This contract, schema reconciliation, consent authority, main/preload/bridge integration |
| Storage track | `storage-research.md`, platform adapter and publication analysis in separate worktree |
| UI track | `ui-boundaries.md`, wording/accessibility/race analysis in separate worktree |
| Test track | `test-matrix.md`, disposable helper scaffolding in separate worktree; one worker |
| #436 / #438 | Existing decision/source inventory: `5201922e795e6e614f427d35ffba1ee8bee82337` |
| #441 | Existing disabled ring/schema: `97097ea076044555b401d49b8e75da8cc1e42df9` |
| #455 | Existing benchmark: `38a50e0c0ca4465afc4ec7f6ecaef496739756b3`, stacked on #441 |
| #470 before RC1 | `69e6319220e04f13b226edc4de6fc0ccfea2d158`, based on `b9b8807252e39c506c24b17ec0c637701e4a68d1` |

The three peer PR heads were re-read on 4 October. No peer code is imported,
recreated or changed in this revision. #441 remains the ring/schema owner; #455's
5,250 offered / 4,096 retained / 1,154 evicted burst and 238.95-second coverage do
not measure 8,192 events. Before code integration, coordinate an exact accepted
#441 head and jointly reconcile its validator, report envelope, count ceiling and
coverage semantics; import its work once. #455's harness must be repinned and rerun
on that implementation. Do not silently adopt its old results or old 4,096 cap.

Order: recorded owner decisions → agreed disabled storage/lifecycle and schema
→ synthetic integration → frozen integrated SHA → fresh independent review →
packaged/native and physical acceptance. The last two are separate from this lead's
work. #416 remains open; #386/#389 own onboarding/support and #390 physical acceptance.

## Clock, expiry and lost tail

Use two distinct clocks. Live lookback uses validated monotonic elapsed time, with
sleep included or explicit invalidation across an unmeasurable sleep. Recovery uses
a native **suspend-inclusive elapsed-since-boot value and boot identity**, authenticated
with the checkpoint. Boot identity is local control data, never report content or
renderer metadata. `Date.now()`, file mtime and a process-relative timer alone cannot
prove elapsed age across app restart. Native clock adapter conformance is a gate.

At snapshot start, freeze the checkpoint's elapsed anchor. Expiry is that anchor
plus 86,400,000 ms, conservatively earlier than an unknowable crash time. At every
recovery/preview/save check, require matching boot identity, finite nonnegative
safe-integer readings and no elapsed rollback; age must be strictly less than 24h.
A later completed write retains the snapshot anchor, not its completion time.
Reopen, preview, export, rename, retry, promotion to previous, key rewrap and cleanup
never renew it. A fresh checkpoint of the current live ring gets a new anchor and
must already exclude events outside the configured live horizon. A copied recovery
report is never recaptured as current history.

Wall time is optional local display data and cannot extend eligibility. If native
elapsed continuity is unavailable, boot changes, age regresses, a suspend cannot be
accounted for or arithmetic overflows: invalidate affected previews, refuse recovery
with `age_uncertain`, and attempt owned-file cleanup. No wall-only fallback. Thus
reboot recovery is not promised by RC1; retaining across untrusted time would require
a reviewed new mechanism and, if it changes user-visible retention, Casey and Cal.
While closed, ORCA cannot physically delete at expiry. While open, check on each
operation and a bounded timer; delayed scheduling never admits publication after expiry. A publication admitted
before expiry may complete later; report that outcome honestly.

Record snapshot position and completion separately. Show time since the latest
successfully published checkpoint, actual retained coverage, capacity/age/invalid
omissions, and whether checkpoint attempts were missed. A crash's exact lost-event
count is normally unknown. Do not label the target interval a maximum lost tail or
claim continuous coverage from oldest-event age. Recovery must disclose: “Events
after the last completed checkpoint may be missing. Delays or failed writes can
leave more than five seconds missing.”

## Aggregate resource contract

These are selected **implementation ceilings and acceptance targets**, not measured
results. MiB means 1,048,576 bytes; KiB means 1,024 bytes.

| Resource | RC1 bound and accounting |
| --- | --- |
| Complete report | 1 MiB uncompressed canonical UTF-8, including envelope, coverage, omissions, formatting and final newline; 8,192 events independently; no smaller preview/save cutoff |
| Retained workspace | 4 MiB aggregate logical file bytes, including current, previous, staging, old files, wrapped keys, control records, cleanup remnants and reservations |
| Record slot | At most 1 MiB report plus 16 KiB framing/authentication/key overhead; at most three ciphertext slots (previous, committed current, replacement staging) |
| Control/key files | At most 64 KiB aggregate, including their replacement copies; at most 16 directory entries; reject unexpected entries without recursive scans |
| Export staging | Approved fixed private export slot: one plaintext temporary file, at most 1 MiB, only after explicit final Save; aggregate unsaved owned file ceiling 5 MiB |
| Retained payload memory | At most 8 MiB explicitly reserved byte buffers across ingress, ring, serialization, seal/open, IPC and frozen preview; reserve before allocating; release only when underlying work settles |
| Preview copies | One app-wide main frozen report and one renderer text view; no second parsed report tree, hidden preview cache or retained IPC history; old view must acknowledge disposal before replacement |
| Measured memory gate | At most 32 MiB incremental diagnostics managed/external memory across main/worker/renderer versus paired idle baseline; sample transient peaks and report method/limitations separately from RSS |
| Work queue | One checkpoint, one expensive prepare/decrypt/serialize operation and one Save maximum; checkpoint work coalesces into a dirty bit, never queues snapshots; bounded 256 enum-pair ingress queue drops on pressure |
| Deadlines | Two seconds preparation/validation; ten seconds each key or file operation; five-second checkpoint target; one background cleanup attempt per launch plus explicit user retry |
| Preview lifetime | Five minutes from freeze, nonrenewing, also clipped by source retention expiry and revocation; destination changes do not renew it |

Three maximum record slots plus the 64 KiB control allowance fit below 4 MiB;
remaining room is not permission for a fourth slot. Logical-byte bounds exclude
filesystem allocation units, journals, snapshots/backups and already published
user exports; measure allocated sizes on native filesystems and disclose them.
Never call these limits a device-wide physical-disk bound. Unknown/oversized or
uncleanable owned state prevents new reservations/persistence; no accumulation of
abandoned generations. No compression is needed in RC1; no decompression bomb surface.

The 8 MiB ledger bounds controlled binary allocations, not JS engine objects,
strings or OS allocations. The separate 32 MiB gate measures heapUsed + external
across processes (arrayBuffers is a subset of external, reported separately, not
added twice); report renderer equivalents, RSS and native allocation limitations
separately. It is not a bound on all OS/native allocations;
a heap sampler is not a hard allocator limit. Use compact ring entries, transfer
ownership where possible, bounded serialization and one renderer string. If fresh
8,192-event tests cannot meet the target, revise the engineering budget as one
reviewed contract; never silently reduce approved report/event limits. Keep main
callbacks short (target 4 ms chunks), move expensive work off the execution path,
and measure event-loop tails under paired execution load. Do not invent an unmeasured
hard responsiveness guarantee.

A timeout changes authority/status, **not proof that native work was canceled**.
Keep its slot, reservation and generation fence until settled or worker termination
is confirmed. Do not start a replacement writer/native call while it remains alive.
Work not yet admitted to publication cannot publish with a revoked epoch.
Already-dispatched native publication follows the ordering rule below; a late
physical completion cannot restore logical authority. Report unavailable/cleanup-pending;
ordinary ORCA execution never waits on a diagnostic queue, key prompt or lock.

## Key adapter and authenticated format

Select a random 32-byte diagnostics data-encryption key per capture session, plus a
separate diagnostics control-authentication key per opted-in profile epoch.
This durable epoch is distinct from the process epoch: create it only after explicit
opt-in and prior-state cleanup, preserve it across clean exits/restarts for the same
setting scope, and replace it after opt-out/new opt-in. Wrapped plaintext envelopes
bind key purpose, profile epoch and key ID; reject control/session-key substitution. Protect
these keys with Electron's **asynchronous OS-backed safeStorage wrapper**, not report
encryption directly with the shared safeStorage secret. Installed Electron 44 types
expose `isAsyncEncryptionAvailable`, `encryptStringAsync` and `decryptStringAsync`.
The [official API documentation](https://www.electronjs.org/docs/latest/api/safe-storage)
describes asynchronous availability and platform-dependent protection. This is API
research, not proof of packaged identity, provider choice or native permissions.

RC1 production adapter targets reviewed macOS/Windows protection only; unsupported
or unverified providers stay unavailable. Check availability after app readiness;
never fall back to synchronous wrapping, a hardcoded/basic-text backend or plaintext.
Persist only wrapped, versioned key envelopes. Delete those diagnostics-owned
wrappers and ciphertext on opt-out; do not remove Electron's shared Keychain entry,
DPAPI/app state, admission keys or other execution material. Releasing a JS string
or deleting a wrapper is not forensic erasure or protection from copied backups.

Use AES-256-GCM with a fresh cryptographically random 96-bit nonce and full 128-bit
tag per checkpoint; nonce reuse under a session key is forbidden. A new process
always gets a new capture-session key, never resumes the previous writer. Bound
sessions to the single current and single previous roles. Authenticated additional
data binds format/schema/scope revision, internal session ID, key ID, generation,
snapshot/expiry anchors, boot identity and exact plaintext byte length. Authenticate
control manifests with the separate control key; fixed-length/bounded parsing precedes
allocation, authentication precedes report parsing, and schema/canonical-byte/secret
scan validation precedes preview. Do not export internal IDs, clock anchors, wrapped
keys, ciphertext or authentication fields. Each newly prepared public report gets
fresh independent report/session IDs; saving a preview preserves those exact IDs.

On unavailable or lost keys, refuse affected recovery; no execution-key lookup,
regeneration-over-old-history, plaintext retry or forced security-setting change.
Destroy owned unreadable state only through the fenced cleanup path. Missing control
key means all checkpoint roles are untrusted and no scan may promote a stray file.
Rotate session keys at new capture session and after opt-out/new opt-in. Provider
rotation may rewrap an existing key under the same identity/expiry, serialized within
the disk budget; do not rewrite the report or extend retention. A failed rewrap keeps
only a still-valid committed wrapper or yields unavailable, never dual unbounded
copies. Native tests must verify adapter results, rotation flags and loss behavior.

## Replacement, deletion and publication

One profile-scoped coordinator owns all diagnostics mutations, independent of any
execution lock. A second writer fails closed. All file names are fixed/bounded or
random opaque owned names; reject symlinks, reparse points, unexpected owners and
unsafe parent components using native handle-based checks. POSIX owner-only modes
and Windows effective DACL/owner checks must hold before bytes are written. Do not
repair permissions or change credentials under this task's authority.

An authenticated control manifest identifies current, previous, authorized generation
and revocations. It is the only publication authority; never recover by choosing the
newest-looking file. Reserve full staging and control replacement bytes first, seal
before disk write, create exclusively, write/flush/close, then publish the manifest
with an atomic platform-tested replacement. Recovery accepts only the referenced
complete authenticated generation. Old ciphertext remains budgeted until deletion
succeeds. A crash before manifest commit leaves the predecessor authoritative; after
commit it leaves the new generation authoritative unless the durable setting or a
later revocation denies it; unreferenced staging is cleanup
only. A malformed/missing manifest means refusal, not fallback resurrection.
Manifest publication dispatch is ordered with revocation just like export dispatch.
A non-cancellable call holds the mutation slot until its outcome is known; opt-out
immediately revokes in-memory authority, and a durable disabled setting overrides
even a physically late manifest. Never report cleanup complete with unresolved writes.

On restart, with valid unchanged opt-in, validate age and roles before capture.
An unclean current session replaces the older previous candidate: durably revoke
and clean the older previous slot before promotion/new allocation. If cleanup cannot
complete, new persistence pauses visibly. An existing previous candidate survives a
later clean session until its original expiry or explicit discard. Reopening does
not rotate a previous candidate into a new session. At clean exit, durably mark the
current role closed/revoked before unlinking its key/checkpoint. A crash before that
commit is treated as unclean; after it, leftover bytes are cleanup only. Exit does
not block ordinary execution indefinitely: unfinished cleanup is reported next launch.

Opt-out immediately advances the in-memory epoch, clears the ring, revokes all
previews/pickers/saves and marks the persistent setting disabled. Durable disable and
revocation must precede reporting a completed opt-out; if either write fails, report
“off for this session; could not save setting/finish cleanup,” never durable success.
A valid durable disabled setting takes precedence over any old manifest. In-flight
work is drained/fenced; then delete diagnostics-owned files and wrappers. Report
logical revocation separately from confirmed file cleanup. Partial deletion cannot
re-enable recovery. A later opt-in waits for old-state cleanup before allocating.
An app crash before disable can be persisted is an explicitly tested limitation,
not a claim of crash-proof consent revocation.

Discarding the previous candidate revokes that source and its previews without
turning the persistent capture setting off; UI says current capture continues. A
“delete all and turn off” action follows opt-out. Expiry and recovered-candidate replacement invalidate
source-bound handles. Normal current-checkpoint replacement does not invalidate a
pinned current-memory preview; its snapshot identity is distinct from the writer
generation and its original preview deadline remains unchanged. No action removes a successfully published user export. Whole-profile rollback of
settings, manifests and key wrappers together is outside this threat model; local
authentication is not a trusted anti-rollback service.

## Consent, bridge and preview/save races

Persist `{enabled, scopeVersion}` only through an explicit main-validated choice;
missing/invalid/unknown scope is off. Same approved scope survives restart without
routine re-consent; a material scope revision needs new disclosure and Casey/Cal
review. Policy approval never writes the user's setting. Build-time production
activation remains off through the separate review/native pass. Pre-consent events,
keys and checkpoint bytes are zero; no retroactive reconstruction from logs/stores.

Main owns a process epoch, target/window authority, source generation and opaque
single-use operation handles. A read-only status method returns closed safe enums
and bounded counts, never exception text or private paths. Under valid opt-in it may
show a generic recovery candidate after bounded envelope/control checks; full report
decryption/validation/display requires explicit Preview. Off/invalid scope exposes
only off/cleanup status. No recovery action resumes agents or waits for daemon hello.

Conceptual bridge methods: `status`, `setEnabled(choice, scopeVersion)`,
`preparePreview(current|previous)`, `closePreview(handle)`,
`chooseDestination(handle)`, `save(handle, destinationToken)`,
`discardPrevious`, `retryCleanup` and `acknowledgeUnknown(operationHandle)`. Main validates the current sender/window/target
and epoch for each. Renderer never supplies report JSON, ciphertext, key, source path
or arbitrary writable path; the native picker owns the destination token. These are the implemented main-owned bridge seams; production capture remains gated off.

The preview freezes one canonical buffer and its digest/length. The renderer displays
that entire exact text, including omissions and final newline, with summary derived
from the same bytes. No live refresh, parse/reserialize on save or secret rescan that
silently edits bytes. A failed scan refuses the entire preview. Reload, target change,
close/back, timeout, opt-out, source expiry/delete, recovered-candidate replacement and authority failure
revoke the handle; renderer disposal acknowledges removal before a new preview is
admitted. New current events alone do not mutate an existing preview. For a current
memory snapshot, expiry derives from freeze time plus the five-minute preview TTL;
for recovery it also cannot outlive the checkpoint's original deadline.

Select destination, show its path and sharing warning, then require a separate Save.
The approved [export-cleanup correction](export-cleanup-proposal.md) requires one fixed,
private app-owned staging slot, discoverable without a diagnostics key, in place
of RC1's destination-adjacent plaintext temporary and encrypted external locator.
Only final Save permits plaintext staging; capture/checkpoints remain encrypted.
The approved restriction is a verified same-filesystem native no-replace move to a
new destination. Unsupported destinations are refused before plaintext creation;
no copy/delete or destination-adjacent fallback. Native adapter guarantees must be established on the exact candidate; unsupported adapters fail closed.

Before plaintext, persist bounded key-independent operation intent and verified
staging identity under private filesystem protection. Persist no destination path;
cleanup never scans user directories or deletes published exports. The accepted design
specifies crash gaps, identity refusal, key deletion, resource accounting and
unknown publication. Neither the session data keys nor the control-authentication
key is retained merely for export cleanup. Failed wrapper deletion remains visible;
key loss cannot itself prevent locating the fixed slot. Uncertain ownership or an
unresolved native writer still prevents cleanup success and new Save admission.

Temporary plaintext can survive failed cleanup or app exit until a safe retry;
there is no forensic erasure guarantee. Decision 9 approves the same-filesystem restriction, residual plaintext exposure and bounded key-independent metadata. Cleanup failures remain visible. Exact-copy verification and native proof remain acceptance gates.

Serialize final publication admission with all revocations. Immediately before native
no-replace publication dispatch, recheck epoch, source/preview deadline, sender,
destination identity and frozen digest. **Dispatch is the point of no return for
ordering**, not evidence of successful publication. Revocation ordered before dispatch
prevents it and cleans staging. Revocation ordered after dispatch cannot promise
cancellation: mark publication pending until the native result is known; if it succeeds,
report “Save was admitted before revocation and completed” and leave that user-owned file. If the syscall's outcome
is uncertain, use only the live operation's verified destination identity/digest.
After restart, the proposal retains no destination locator: report unknown, never
infer success from a missing staging file, scan for the export, retry or overwrite. A hung publication keeps its single slot/reservation until resolved.
Cleanup failure is separate from save failure. Never claim “nothing saved” on timeout.
Repeated Save shares one operation result; no duplicate file or fresh collection.
The explicit acknowledgement flow below admits a separate new operation, never a retry.

## Acknowledge unknown outcome and save again

This is the owner-approved direction in decision 8 and the task follow-up. It
supersedes the indefinite block in `edb66b4`; it does not reconcile the missing
publication result. Keep the earlier result `unknown`, separately from acknowledgement,
cleanup and any new Save result. No timeout, restart, missing filename, elapsed time,
opt-in or user click can prove that native work stopped or staging was removed safely.

| State / transition | Required evidence and effect |
| --- | --- |
| `unknown_blocked` | Hold the old operation slot/reservations. Old native/process work may still write, or staging safety/cleanup is unresolved. Acknowledge and new Save are refused. Late known completion is reported honestly before acknowledgement; it cannot restore revoked authority. |
| `unknown_ready` | Main proves all old writers cannot write, validates the bounded recorded staging identity and safe parent/ownership, and confirms the owned file removed or safely absent. Keep the outcome unknown and block a new Save until acknowledgement commits. |
| Explicit `Acknowledge and save again` → `acknowledged_unknown` | Under the serialized gate recheck evidence, sender/epoch and exact old-operation handle; durably replace the bounded record with acknowledgement plus the unchanged unknown outcome. Only after commit release the old reservation/slot. Failure or uncertain commit stays blocked; no picker, write, consent change or Save is triggered by this action. |
| Separate new Save | Require current consent/scope and unexpired exact-byte preview; explicitly choose destination again and show it, then require a new Save action. Allocate a fresh operation ID and atomically replace current intent while preserving the bounded unknown-history record. No old destination/save token or old effect is reused. |

Proof of cessation must cover every process/worker/native handle capable of writing:
a settled native completion or confirmed termination plus reviewed platform evidence
that no surviving writer can later publish. A new main process, PID check, lock acquisition
or worker-termination request alone is insufficient. A valid committed acknowledgement records the completed old-operation safety checks;
it is not necessary to reconstruct retired historical file/process identities. On
restart freshly verify the private fixed slot is safely empty and no current or
incomplete operation can write. Unexpected staging or ambiguous current state still
blocks: the summary is not a bypass. Unknown or malformed identity/state, a moved
root, failed unlink or uncertain writer cessation fails closed.
Absence is checked through verified native directory/identity state; it never establishes
a Save outcome. Lost keys do not bypass any check and are not required for locating the
approved fixed slot. Opt-out, expiry and consent/preview revocation remain independent.

Before acknowledgement show: “The earlier export may already exist. ORCA cannot
confirm its result and will not find, change or delete that file. After safe cleanup,
you can acknowledge the unknown result and choose to save again.” The button is
**Acknowledge and save again**; adjacent copy says it does not save a file. Disable
it with a safe reason while work or cleanup is unresolved. Offer current Preview if
needed, then a fresh picker and separate final Save; acknowledgement never renews a
preview or grants consent. Repeat the earlier-export warning before the new Save.
Exact wording/accessibility remain for review; the behavior is approved.

“New destination” means freshly selected and currently nonexistent, not proven
historically different: no historical destination path is retained for comparison.
Never reuse the old token. Recheck under atomic native no-overwrite publication;
if a possible earlier export occupies that filename, refuse it unchanged. A later
Save's success never changes the earlier unknown result.

### Bounded acknowledgement and interruption

Use one current-operation record and one latest acknowledged-unknown summary in
the same bounded cleanup envelope; at most one atomic replacement copy. All copies
of intent, staging identity and acknowledgement metadata together stay within the
existing **8 KiB** sub-budget of the **64 KiB** control allowance and **16-entry**
ceiling; no per-acknowledgement files or append-only ledger. The summary contains
only the most recent opaque acknowledged operation ID, fixed `outcome: unknown`,
`acknowledged: true`, and a boolean `olderUnknowns` (saturating, never a count).
No report bytes, hashes, timestamps, destination paths or keys. Preserve it across
new-operation intent replacement and known success/failure; replacing it on a later
acknowledgement folds the older unknown into the boolean, never into success.
UI says only the latest acknowledged unknown is detailed and older unknowns may
exist; it must not imply a complete export history.

Metadata may retain one bounded summary across restarts; it supplies no capture/save authority. On opt-out, remove acknowledged summaries only after owned cleanup completes. Preserve unresolved obligations until writers have ceased and cleanup is verified; never erase them to bypass the gate. Decision 9 supersedes the earlier proposed retention across opt-out.
Never erase an unacknowledged current operation to make space. An acknowledgement
commit replaces that current obligation with the summary atomically; the next
intent retains the summary. No path retention is needed for duplicate protection.
After a failed startup metadata read, an empty in-memory state proves nothing.
Reread the bounded durable journal after cleanup before reporting completion or
admitting new capture. An unreadable journal stays blocked; a newly discovered
operation cannot inherit a known outcome from another operation ID.

Crash before acknowledgement commit leaves `unknown_blocked`/`unknown_ready`, after
fresh safety checks; a safely committed acknowledgement leaves `acknowledged_unknown`.
Interrupted replacement admits only a complete valid predecessor or committed successor;
malformed/ambiguous records stay blocked, never infer acknowledgement. A crash after
commit but before in-memory reservation release cannot cause a second release or
publication: reconstruct reservations from verified physical state and bounded records.
A crash while preparing the new intent recovers either acknowledged idle state or
one new unresolved operation; never automatically dispatch either operation.

Repeated acknowledgement for the same handle is idempotent while it is retained;
older/stale handles return stale with no mutation. Repeated new Save joins the same
new operation or returns already-in-progress; it cannot allocate another ID or file.
Callbacks carry their operation ID and epoch and may never mutate a newer operation,
release its reservation, or erase its prior-unknown summary. A delayed callback is not
proof that native work remained alive: writer cessation must already have been proven.
If cessation cannot be proven, acknowledgement remains blocked. The acknowledged
record remains unknown; do not silently relabel it from stale callbacks.

## Content, failure and review gates

No producer is enabled by RC1. Reuse #438's inventory and #441's closed primitive
`(phase, code)` seam; a future producer row must identify source, current authority,
projection, exclusion tests and reviewer. No arbitrary objects, errors, messages,
logger/audit/RPC bodies, stdout/stderr, private-store reads, paths or identifiers enter
the ring. Unknown evidence stays unknown. No uploads, network endpoint, raw logs,
crash dumps, execution repair/retry or credential/access change is introduced.

Use closed diagnostics result codes such as `off`, `unavailable`, `age_uncertain`,
`expired`, `capacity_limited`, `stale_preview`, `publication_pending`, `saved`, and
`cleanup_pending`. Failures cannot throw into execution, hold execution locks, retry
admission/resume or change durable run state. No free-form errors in UI or logs.

The accepted disabled implementation proceeds under decisions 1–9 and the current task instruction. Before activation, obtain independent technical/privacy review as one unit:
clock adapter and conservative reboot refusal; total logical and measured resource
limits; authenticated format/control-key lifecycle; publication/cleanup linearization;
consent scope/version and exact UI/support copy; closed producer provenance. Any
material change returns to Casey and Cal. In particular do not quietly add cross-boot
retention, broader producers, automatic preview, longer preview leases, overwrite,
weaker provider/ACL fallback or uploads to solve an implementation inconvenience.

Then run the [test matrix](test-matrix.md) against the actual implementation, including
real kill boundaries, stale async completion, byte-for-byte export, aggregate reservation
pressure, loss/rotation and paired execution/network observations. Existing six helpers
prove only scaffolding. Record exact SHA and actual checks. Mac identity/Keychain,
Windows DPAPI/DACL/path behavior, accessibility, native load and physical Mac acceptance
remain **not run**; Linux fixtures cannot approve them.
