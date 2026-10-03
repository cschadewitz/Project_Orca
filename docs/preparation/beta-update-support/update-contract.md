# Proposed approval-based update contract

**Implementation requirement, not current Mac behavior.** This contract consumes
[#387's approved preference](https://github.com/cschadewitz/Project_Orca/issues/387).
All interface names below are conceptual obligations, not new RPCs or shipped UI labels.

## Approval and phase boundaries

Proposed safe default: approval binds one immutable candidate and authorizes download,
verification, installation and restart only when safe activation is proven. Show the
restart implication before approval. Do not pre-stage native updater bytes before
approval until the selected engine proves that staging cannot imply later installation.
Checking policy/frequency is still a product decision; never treat checking as consent.

| Phase | Required behavior and visible state |
| --- | --- |
| Available | Show verified current/target version, publisher/channel, concise release changes, restart need and compatibility/support eligibility. Unverified metadata is not an install offer. Offer approve or defer; no countdown/default acceptance. |
| Approved | Bind approval to artifact digest, version, architecture, publisher, channel and compatibility identity; duplicate clicks create no second operation. Never silently substitute a newer candidate. |
| Downloading | Bounded download to owned staging, truthful byte progress only; active work continues. Offline/authorization/full-disk errors are update failures, not run failures. Credentials/raw errors stay out of renderer and diagnostics. |
| Verifying | Validate exact bytes and trusted publisher, expected artifact/build/app/daemon/protocol/store identity and support matrix. A checksum from the same untrusted feed alone is insufficient trust. Fail closed on mismatch. |
| Waiting for safe activation | Preserve jobs/drafts; explain the blockers and let the person defer the update. No automatic cancel, answering inputs, provider replay, forced quit or timeout kill. Do not infer safe idle from a disconnected UI. |
| Preparing | Revalidate candidate and approval, all window acknowledgements, current daemon ownership/identity and compatibility. Atomically close admission through the supported owner; prevent fresh work racing with shutdown. If any check is unknown/busy, release only guards whose ownership is proven and remain blocked. |
| Installing/restarting | Only after a proven safe boundary and any required verified backup, stop the owned daemon and activate the exact candidate. Do not stop/install an external daemon. Persist minimal recovery identity without secrets and prevent competing activation. |
| Verifying startup | Prove expected app/daemon/protocol/capabilities/store/workspace identity before reopening admission. Do not report installed-and-ready merely because an installer exited or a window appeared. |
| Failed/unknown | Retain truthful phase and a safe support code if available. Known recoverable pre-activation failures may return to the old usable state. Ambiguous activation/store state stops for Casey; no blind retry or fabricated successful resume. |

Changing bytes/publisher/channel/compatibility or restart consequences invalidates the
approval. Proposed approval is session-bound; approval persistence across quit/crash and
expiry need explicit review. Until then a restart must not resurrect permission to install.
Deferral before activation must prevent future automatic apply, including native staging
on ordinary exit/relaunch. If an engine cannot honor this, reject that engine design.
Once activation has committed, do not promise cancellation or reverse the operation
without verified recovery semantics. Explain this boundary before approval.

## Active work and drafts

Prefer **wait for safe idle**, with a user-visible defer option while jobs are active.
The product owner must decide whether a later explicit interruption option is wanted;
implementation must first prove checkpoint/resume semantics for each supported job type.
Do not offer "restart now and resume everything". External provider effects may already
have occurred; cancellation cannot undo them and resubmission may duplicate them.

Reuse existing draft coordination across every window and the daemon's atomic admission
prepare. A missing/unresponsive window, unsaved edit/answer, live callback, in-flight
operation, uncertain admission, unknown ownership or stale observation blocks activation.
Users choose how to save/send/discard their own drafts through normal controls; the
updater neither discards nor sends them. A parked gate can be restart-safe only when the
exact candidate/runtime proves durable state and no active lease/callback. "Waiting" is
not a universal idle signal. New activity after the offer requires a fresh guard check.

The UI may subscribe to existing safe status to re-evaluate a waiting proposal. It must
not poll private stores or reissue mutations to infer liveness. Waiting/defer/cancel UX,
approval lifetime and any automatic retry policy remain review decisions. Default to
no automatic activation retry following an uncertain outcome.

## Interface responsibilities to freeze before implementation

- Candidate resolver: trusted channel and immutable artifact metadata, supported OS/arch,
  bundle/publisher identity, source/build, app/daemon/protocol/store compatibility and
  rollback constraints. Supply the existing #402 identity contract, not a second manifest.
- Updater adapter: select/download/verify/stage/activate exact approved bytes, report typed
  phases and bounded errors; document engine-internal apply-on-quit/relaunch behavior.
  No arbitrary URL/path/command installation RPC or renderer-held feed credentials.
- App guard coordinator: all-window draft acknowledgements, approval/candidate binding,
  prevention of duplicate actions, owned-daemon-only stop and truthful recovery result.
- Runtime maintenance owner: atomic admission fencing, activity classification, durable
  guard ownership and recovery outcome; use current APIs, do not duplicate journals.
- Compatibility/backup owner: establish which writes can occur at startup; complete
  consistent backup plus matching binary and isolated restore proof before a risky change.
- Delivery owner: restricted immutable feed publication, updater metadata and artifact
  integrity, signing/notary/staple evidence, publisher verification and revocation response.
  Provisioning/service choices require separate approval. No embedded repository token.

## Trust and privacy review

Review feed compromise, malicious metadata/redirects, wrong architecture/publisher,
replayed old signed packages, downgrade/version spoofing, partial publication, revoked
or expired signing material, offline trust checks and credential revocation. Distinguish
certificate expiry/timestamp and revocation semantics on the selected platform instead
of declaring every expired certificate invalid or ignoring revocation. No security bypass
or fallback to unsigned/public/older code. Unknown trust means stop; retain the currently
known-safe app where that remains possible. A forward fixed candidate can be preferable
to rollback, but publishing/installing it requires the normal reviewed path.

HTTPS, artifact checksums, code signatures/notarization and feed freshness solve different
problems. Freeze a reviewed freshness/anti-replay policy and trust root; do not invent
new signing keys in this preparation. Match configured channel/architecture and reject
unexpected cross-origin credential forwarding. Strip credentials from error surfaces;
never reuse execution keys for feeds or diagnostics. Disclose necessary update-check
metadata and bound logs/retention through separately reviewed choices. No diagnostic
upload, telemetry or support remote command follows from update approval.
