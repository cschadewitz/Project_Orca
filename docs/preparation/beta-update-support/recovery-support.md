# Draft beta recovery and support runbook

**For review under #387/#389; not a shipped user guide.** Replace proposed control
names with tested candidate wording before giving this to testers. Do not publish to
the Hub from this preparation. No instruction here authorizes actual recovery or
collection. Casey and the coordinator must supply the agreed private support route;
no contact address, access grant or retention policy is invented.

## Current recovery boundary

Current source is main `c1eba301702fef0466b2d3481c36d62331ee7d48`, protocol 2.0/operator-journals-v4.
Earlier protocol 1.10/config-generations-v3 references are historical audit evidence,
not current downgrade compatibility. [README](README.md) records the approved Mac
bundle/Team identity and Windows continuity exception. Native old-to-new Mac Keychain,
OS-permission, notification and URL handling checks remain required before distribution;
unchanged userData paths do not prove access to the existing encrypted intent journal.
This runbook implements no migration/recovery and authorizes no key/journal reset.

## Plain-language tester guidance to validate

1. If an update is offered, read which version it will install and that it needs a
   restart. Choose the update only when you agree, or leave it for later. The approved
   design waits for safe idle and protects drafts; until that design exists and passes
   testing, do not present this wording as a current control.
2. If work is active or an edit is unsaved, leave the update waiting or defer it. Use
   normal app controls to finish work and handle drafts deliberately. Do not force quit,
   cancel a job just for an update, or repeatedly submit a request whose outcome is unknown.
3. If an update, launch or recovery fails, stop changes. Inspect the app's existing safe
   status and candidate version if available. Write a short description of the stage and
   what you expected; use `unknown` when the app cannot establish what happened.
4. Stop for a publisher/security warning, wrong workspace, unexpected cost/credentials,
   unexplained changes or possible data loss. Do not disable Gatekeeper, remove quarantine,
   use Terminal repair commands, reinstall over uncertain state or downgrade experimentally.
5. Ask Casey through the agreed private route. Optional [feedback](../beta-feedback/report-template.md)
   is enough. Once implemented and validated, #416's in-app manual preview/local export
   may help: inspect the exact contents, cancel if unsure, and separately choose whether
   and to whom to share. Export does not upload. If unavailable, there is no raw-log fallback.

Do not send prompts, code/diffs, screenshots, paths, raw output/logs, credentials,
workplace material, private stores or keys. A safe code can be shared if separately
identified; an arbitrary error message is not a safe code. Declining diagnostics does
not block ordinary use. This does not authorize remote access or another reproduction.

## Triage decisions for an authorized beta support human

| Observation | Allowed safe next step | Stop boundary |
| --- | --- | --- |
| Known download failure, old app untouched and healthy | Explain network/availability issue; a user may retry the same approved download through tested UI after authority/trust checks. | No alternate credential, public feed or unverified package. Unknown activation is not a download failure. |
| Draft/activity blocker | Explain which generic blocker the normal app reports; wait/defer and preserve work. | No automated draft discard, answering, cancellation, lease deletion or force kill. |
| Lost admission response or uncertain run status | Inspect supported authorized status/admission receipt if available; preserve request identity. | Never resubmit as a new request to discover whether the old one ran. No success/failure inferred from absent transport. |
| Failed resume/restart or mismatched daemon/store | Record safe observed phase and escalate to Casey/runtime owner. | No repeated restart, repair or competing daemon until ownership and effects are established. |
| Signature/notary/publisher/feed trust failure | Stop installation, report candidate identity and safe reason through agreed route. | No bypass, allow-downgrade, legacy mode or weaker verification. |
| Missing/corrupt protected record/key, incompatible or unknown store | Preserve state and escalate to Casey. | No key regeneration, editing/copying individual ciphertexts, replaying redacted data, epoch edits or private-store surgery. |
| App fails before handshake | Use candidate's validated #416 startup path if available, or safe text report. Daemon/store status remains unknown. | No raw stdout/stderr or store probes to fill missing diagnostic facts. |

Support reads only existing authorized projections. It does not acquire credentials,
issue remote commands, restart an agent, answer a gate, install a candidate or manipulate
stores merely because a diagnostic report arrived. #394–396 own later supported recovery;
this table does not pre-implement those capabilities. The support owner records what is
known, unknown and not attempted, an escalation owner and a safe next decision. Do not
turn a temporary return to connectivity into proof no provider side effect occurred.

## Engineering recovery contract: complete state, not binary-only rollback

The exact candidate must inventory its data ownership before an update. A complete
consistent pre-upgrade backup must cover all configured stores (including separate CLI/
ACP stores where used), public events, encrypted private execution and private workflow
directories **with both hidden `.execution-key` files**, legacy workflow snapshots,
immutable workflow/template/config generations and references, configuration and permission
sidecars, credentials through their supported protected storage, plan/operator/admission/
revision journals, artifacts and associated indexes, and any other candidate-owned durable
state. Include app preferences and durable drafts needed for recovery. Unsaved memory-only
drafts must be resolved or proven durably preserved before shutdown; a filesystem copy
cannot preserve them. Inventory external workspace/worktree data and external credential
stores separately; do not claim the app-store backup protects external provider effects.

This is an inventory obligation, not an assertion every item exists in the audited main.
Current-main candidates use operator-journals-v4, so their matching journals must be included. Establish
actual roots through supported ownership/configuration, not guessed home-directory paths.
Do not request/upload this inventory or its private values for diagnostics.

A valid snapshot is taken at a documented consistent, quiescent boundary after all writers
are fenced/stopped, or via a proven equivalent snapshot procedure. Copying a live store
is not consistency evidence. Retain the matching verified binary and shipped assets,
source/build/protocol/store identity, platform access controls and snapshot completeness
record. The backup contains sensitive material; agree local destination, access, encryption,
retention and deletion before execution. No automatic cloud sync/upload is authorized.

Restore testing uses isolated disposable synthetic state with no active external tools.
Verify candidate/backup pairing, file integrity, key availability, authorized public views,
protected-history/gate/draft readability and replay semantics without exposing plaintext.
Refuse mixed-era stores, absent keys, corrupt records or an incomplete set. Keep the failed
state and any later work separate; do not silently overwrite it or pretend restoring an
old snapshot recovers work done afterward. Do not copy locks/leases blindly into an active
installation; let the reviewed supported restore procedure establish inactive ownership.

Before selecting an older binary, prove it can read **all writes already made**, including
startup/migration writes. Equal epochs are insufficient evidence. The operator release
marker is enforced by managed activation/recovery, not every direct startup; bypassing a
managed launcher does not make a downgrade safe. If compatibility cannot be proven, a
binary-only rollback is prohibited. A complete matching pre-upgrade restore may be considered
only under a separately approved, tested procedure with explicit treatment of newer work.
When uncertain, leave execution closed/stopped through the supported owner and escalate.
Never delete a recovery/admission journal or edit an epoch marker to force reopening.

Uninstall/reinstall must explain that app binaries and user state are separate. Neither
operation implies deletion of stores, credentials, backups or keys, nor repairs corruption.
An identity change also cannot be assumed to retain OS-protected key access; validate
the existing encrypted intent journal and Keychain continuity without resetting either.
No automatic cleanup, reinitialization or replacement of protected keys is part of recovery.
