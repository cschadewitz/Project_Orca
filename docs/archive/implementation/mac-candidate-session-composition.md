# Candidate-session guard composition (#387)

This slice starts at merged main `db579fb7ac9cfce2e4e6901713088a80602311da`,
which includes #550's reviewed updater/restart/recovery groundwork and #470's
crash/export implementation. It closes the documented candidate-session guard
composition gap without editing main/index, preload or the diagnostics owner's files.

`createMacCandidateSession` composes the actual candidate session with
`MacUpdateGuards`, the caller's `Workspace` and all-window `DraftWindowBoundary`.
The caller still supplies the approved catalog, bounded transport and read-only
native inspection ports. No feed, trust policy, native engine or OS floor is chosen.
The factory has no renderer input, download URL default, install/stop/restore callback
or production constructor call. Main/index and preload wiring require parent-coordinated
ownership before either file changes.

The session accepts a complete captured preparation adapter only; partial adapters
retain its original disabled candidate guard. Approval still binds the manifest digest,
channel and compatibility/recovery references to one process-local offer. Deferral
retires that ID. A fresh offer and approval repeat catalog/download/native inspection;
reconsideration cannot revive consent or substitute another candidate.

`reconsider` responds to supported activity notifications without a poll or timer.
While busy, it uses the reviewed coordinator's pending reconsideration mechanism.
Downloaded verified bytes remain owned while active work prevents admission. Once
idle, the same approved session acquires the reviewed window and authenticated
runtime guards, including local target reservation and new-admission refusal.

After both guards, a captured read-only `checkPrepared` receives the exact immutable
binding, owned directory and target, labelled **scope: preparation-only**. It can
return only untouched `refused` or `unknown`; positive or malformed results normalize
to unknown. The factory checks draft ownership before and after this callback.
There is no positive complete-state/recovery/native activation authority in this
slice, and the installation adapter remains hard-refused. Unknown evidence retains
owners and seals the session; native authenticity remains separately reported by
`verification` rather than being relabelled by guard uncertainty.

Operation ownership is reserved before adapters run, including synchronous callbacks.
Immediate deferral before an operation starts cannot reapprove its retired offer.
`settled` observes current operation/cleanup settlement, without granting readiness.
Deferral waits for pending download/preparation settlement before discarding owned
download bytes. If admission/window cleanup becomes unknown, the candidate evidence
is retained instead of erased. This removes a deletion race introduced by allowing
the real session to reach actual guard acquisition. It deletes no user state or keys.

Focused tests reuse the merged rehearsal's actual candidate reader/downloader,
sandboxed preload, window boundary, authenticated loopback runtime and public models.
They construct the production composition factory, rather than patching private
fields or building another coordinator. OS windows, catalog/native inspection and
candidate-shaped artifacts remain synthetic; the actual guarded RPC path executes.
Checks cover exact approval, waiting/reconsideration, deferral/fresh inspection,
queued-operation cancellation, lost/malformed/wrong-target admission evidence,
guard-release uncertainty and unsupported positive checkpoint results. Retained
candidate bytes and real admission refusal are observed. Owned fixture cleanup closes
its disposable daemon before removing test roots. No host app/provider is touched.

Remaining implementation and platform gates:

- Main/index/preload offer and approval integration, coordinated through parent with
  diagnostics ownership. This factory is ready for that integration but is not called
  by the production app entrypoint.
- Select and prove the locked Electron native autoUpdater versus electron-updater
  MacUpdater engine's staging, defer/cancellation and ordinary-quit/relaunch behavior.
  No engine is selected here; manual replacement does not satisfy approved automatic
  installation after approval of the specific candidate.
- Approved catalog/native inspection adapters and production approval cadence,
  expiry/revocation; D4 OS floor and D5 version policy remain open.
- All configured app/CLI/ACP/external writer quiescence, complete protected-state set
  plus matching verified binary, durable recovery identity, compatibility of all writes,
  supported restore/newer-work/plugin contracts. Existing inventory keeps consistency
  unknown and recovery eligibility unavailable. Binary-only rollback is unsafe.
- App/UI replacement, daemon replacement, restart/reconnect and admission reopening
  under matching app/build/daemon/protocol/store identity. A startup-only receipt is
  insufficient recovery or reopening authority.
- Physical signed Apple Silicon N → N+1, native packaging/app lifecycle, old
  `dev.orca.desktop` → `com.schadewitz.orca` Keychain/encrypted-intent/TCC continuity
  and unassisted #390/#388 acceptance. These remain unrun; no reset/deletion workaround.

Pinned Node 24.21.0/pnpm 12.4.2 and the frozen trust policy remain in force. Only author
self-review and parent's minimal review are requested. Parent owns CI and merge;
no live runtime replacement, deployment, signing, credentials or permissions change.
