# Approved drain and durable closed replacement — #571 / #387

This bounded updater/recovery slice preserves exact #568 drain
`a9412a00101a0ec6a3951c373c20df959687c694` and #567 lifecycle
`9ac19ead4347180e44be6162a41d2d5726b3f929`, composed by
`9c63e78f51a5900ae6822c2698e636261ed974b3`. No dependency branch was rewritten.
Shared-entrypoint ownership stays with #572; the implementation branch was not
refreshed to that branch. No #570 orphan reconciliation or #566 alternative policy
is included. Production updater activation remains disabled.

## Implemented source behavior

`MacUpdates` captures one process-local token for the exact approved offer/candidate
and target. It acquires/observes drain **before downloading**, so new admissions
cannot accumulate during an approved download. Candidate sessions refresh the
existing trusted catalog policy before drain observations; expiry/revocation never
permits activation. Repeated approval cannot create another drain owner. Changing
the offer while that owner is retained refuses; explicit defer and acknowledged
settlement are required before a fresh offer.

`mac-update-drain.ts` consumes strict runtime-drain-v1 proof, including captured
workspace/instance/PID. An absent/older drain API cannot fall back to prepare-only
proof. Capture reserves Workspace switching without freezing completion IPC.
Busy/parked/uncertain activity leaves drafts unfrozen; answers, continuations and
receipt reconciliation retain their existing daemon authority. Notifications call
reconsider; no polling/timer scheduler is introduced. Individual owner observations
are bounded to five seconds. A missing/lost/foreign/late proof seals recovery-required
and retains ownership. Owner defer uses defer while draining and resume after held;
only a matching released acknowledgement releases the local reservation.

Held drain proof precedes all-window draft preparation. `prepareMacDrain` consumes
the same branded lease/token and captured owner, switches to the final all-call
freeze, and reuses runtime-v1 prepare with no release interval. The resulting lease
carries that token to the native commit owner. Fresh drain proof and existing candidate
revalidation precede commitment. Lost release cannot thaw drafts or redirect cleanup.
Standalone historical prepare guards remain for existing tests/callers; the coordinator
cannot use them as a substitute for drain.

`MacReplacementCommit` composes the existing `MacNativeHandoff` owner port. With no
accepted signed-engine/current-approval/all-writer owner it refuses before stopping
or staging. A current authorization binds exact token, previous workspace/boot/PID
and previous manifest. It captures protected writers, obtains the existing clean
owned-stop receipt, verifies that receipt's target, then prepares the complete-pair
recovery journal. Approval is checked again after durable capture before native
readiness. A different candidate/target/lease cannot reuse the first attempt. Any
failure after acquiring writers/attempting stop is unknown, never resumable refusal.
No stop escalation, binary-only restore or native activation default is added.

## Durable identity and recovery

`MacReplacementJournal` uses the existing handle-relative native storage and secure
key wrapping interfaces over a separate updater-owned root. It writes authenticated
AES-GCM ciphertext, wrapping only its random 32-byte data key through safeStorage.
The root-bound envelope contains the candidate, token/fence, previous exact target,
complete configured-root set and verified prior protected-state/matching-binary pair.
It contains recovery identity, **not reusable approval**. Records are capped at 32 KiB
and envelopes at 40 KiB; roots are capped at 32. Missing/incompatible native storage
or wrapping fails closed. File/directory durability uses the existing native write
and replace guards; there is no portable production fallback.

Unacknowledged commits keep their temporary/record files and seal that journal
instance. A fresh process refuses incomplete/unrecognized files and corrupt or lost
wrapped keys. Ordinary handle close never clears replacement admission or deletes
recovery data. No key regeneration, credential/store reset, retention cleanup or
plaintext export is performed.

`MacReplacementBootstrap` starts with ordinary startup disallowed synchronously,
before journal reads. Only a positively clear journal permits ordinary startup.
A saved record or uncertain/late read keeps it closed. The integration owner must
mount this gate before normal Workspace/first-run startup and, critically, before
native child bootstrap, migrations, listen and any protected producer. Replacement
startup uses the durable fence, not a normal-start retry.

`MacReplacementRecovery` persists closed identity before native staging, a launching
intention before initial verification, and a restoring intention before pair selection.
Interrupted launching/restoring is closed and cannot repeat automatically. Startup
unknown or unconfirmed writer stop keeps existing files/fences intact. The existing
`MacRestartVerification.inspectExistingClosed` reuses its actual image, authenticated
hello, protocol/capabilities/version, store and exact fence checks on an independently
owned closed child; it launches nothing and resurrects no stop receipt or consent.

After known failed startup and positive all-writer stop, recovery captures/verifies
and durably records the **current full protected-state plus matching current binary**
before any rollback decision. Automatic selection of the prior pair requires:

1. Both complete verified pairs and exact configured-root coverage.
2. The same independently supported complete writer-ledger epoch/revision. This
   covers startup/migration writes, including writes subsequently reverted.
3. Equal whole protected-state/root/continuity digests; store-epoch equality is insufficient.
4. A fresh identical current observation under the same exclusive writer ownership,
   plus positively stopped writers immediately before native pair selection.

Any newer write or uncertain/incompatible observation preserves both generations
for explicit recovery. The supported native restore port must atomically select a
complete pair while retaining both generations; destructive overlays and binary-only
rollback are outside its contract. Lost restore acknowledgement retains restoring
and cannot retry. Restored-closed still needs fresh old-image startup checks. No
positive result reopens admissions. A fresh supervisor revalidates preserved pairs,
including their matching binary, before reporting them preserved.

## Pinned shared wiring handoff

[571-shared-wiring.patch](patches/571-shared-wiring.patch) is pinned to exact #572
`f4ca6540f94ad4a06704b20d0b9c4c4dd2cc9943`. It is an unapplied reviewable patch,
not a concurrent edit of main, preload or Workspace. It adds:

- `Workspace.captureMacUpdateDrainTarget` over its existing authenticated reservation,
  with runtime-drain-v1 RPC, independent captured PID, same-owner freeze and owned stop.
- A final `macUpdateFrozen` resource/epoch fence and optional synchronous
  `WorkspaceDeps.updateBootstrap` gate. Connect, first-run preparation and resource
  dispatch refuse while that gate is closed.
- No ordinary-quit forced shutdown of an updater-reserved daemon. Its uncertain
  ownership remains reserved for explicit reconciliation; #570 is not implemented.
- Main guard injection of captureDrain and three actual Workspace/RPC wiring tests.
  Existing production `new MacUpdateApplication()` remains unavailable. Preload needs
  no new API: the existing exact offer/digest/epoch action boundary is reused.

The integration owner applies it after composing this implementation. Before any
production activation it must construct the journal/`MacReplacementBootstrap`, inject
that gate before startup, and provide native child/bootstrap/all-writer/copy/verify/
ledger/restore ports. `MacCandidateSession` remains preparation-only and refuses
activation; it must not be used as a positive commit shortcut. No positive producer
is inferred from an interface, inventory digest, a successful source test or the
existing diagnostics root.

## Portable evidence and remaining blockers

Node 24.19.0, installed Vitest 5.0.2 and TypeScript 7.0.2; dependency manifests,
lockfile, coverage configuration and CI are unchanged by this slice. No applicable
local `.agents/skills` were present. Author/committer: Calcifer Schadewitz
`<schadewitzcalcifer@gmail.com>`.

Final affected-suite evidence spans 294 passing cases in ten files, at most two
workers: coordinator, drain, replacement commit/recovery, candidate, guards,
admission, native handoff, application/actual sandboxed preload and restart. Existing
#568's 80 daemon cases and #567/#572's broader evidence are reused, not broadly rerun.
The pinned patch applies to its exact base and was typechecked in a disposable copy;
its three actual Workspace/RPC tests separately pass. Root no-emit TypeScript,
changed-source/test ESLint, scoped Prettier and diff checks pass. No full suite,
coverage or Actions dispatch is claimed.

Initial test fixtures were corrected for explicit synthetic drain ownership,
canonical schema field ordering, mock recursion, fresh hello adoption and tightened
catalog-check counts. Self-review moved drain ahead of download, bound commit replay
to its exact lease/candidate, retained the token on admission, and revalidated a
preserved current binary. New regression assertions retain the stricter boundaries.

| Required native evidence | Status for this slice |
| --- | --- |
| Signed Apple Silicon N→N+1; selected engine/ATS/staging and ordinary quit/relaunch | Not run: Linux source environment, no reviewed signed candidate/physical Mac |
| Complete actual protected roots, independent CLI/ACP/app writer capture and all-write ledger | Native producers unavailable; POSIX files and synthetic writer ownership exercise policy only |
| Native atomic matching-binary/full-state pair capture, preservation and selection | Producer remains required; test selection preserves complete synthetic pairs only |
| `dev.orca.desktop`→`com.schadewitz.orca` Keychain/encrypted intent/TCC continuity | Not run; no credentials, journals or OS access changed |
| Native durable replacement gate before app/daemon bootstrap/migration/listen | Shared/native integration remains required; journal and wiring are portable source evidence |
| #388/#390 packaged/unassisted and physical fault/recovery acceptance | Not run; no milestone or release-gate completion claimed |

These are production blockers, not positive acceptance receipts. No merge, Actions
dispatch, release, deployment, paid/provider operation, live daemon mutation,
credential/access change or native host operation occurred. Parent owns composition,
independent exact-head review and combined CI. This owner stops after draft publication.
