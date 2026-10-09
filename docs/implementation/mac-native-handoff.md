# Mac app routing and candidate native lifecycle — #387

This slice follows #556 (`d06ef1e754e5cb5e997cd8413b583aeb64c6741e`) and the
accepted [#439 handoff](../preparation/beta-update-support/acceptance-handoff.md)
at `39d4cf75b9e46dd267ccf0ae044f29f220fe667d`. It implements app/preload approval
routing and a candidate Electron native lifecycle adapter. It does **not** enable
production Mac updates, select the final engine, implement supported restoration,
or complete #387 / invited Apple Silicon acceptance.

## Implemented boundary

`MacUpdateApplication` projects only phase, blocker, version and the exact trusted
offer's ID, manifest digest, channel and compatibility/recovery references. Main
registers its actual IPC handlers and the sandboxed preload exposes `macUpdates`.
Approval/defer accepts exactly three fields. The main-owned window, main frame,
renderer admission epoch, current workspace epoch and offered target epoch must
match. Approval is refused while update windows are held; defer can reach the
coordinator during preparation. The coordinator still refuses deferral once the
synchronous commit edge is sealed. No renderer supplies a feed, archive path,
native capability, recovery readiness or replacement target.

The Mac header action says approval permits automatic update **and restart**. Main
pushes intermediate transitions; an action response cannot overwrite a newer
offer or defer. The shared nonce/renderer/native-window draft freeze remains in
`UpdateControl`, including its existing remount ownership. Unknown outcomes expose
recovery-required, with no retry/restore button that would imply safe reopening.

Production constructs `new MacUpdateApplication()` without a session. It returns
unavailable and hides the controls. There is no catalog polling, persisted consent,
environment override, native constructor call or production native handoff. A
trusted owner must supply an accepted delivery resolver and the full commit/recovery
composition before this default can change. #556's preparation-only session still
normalizes positive checkpoint results to unknown and hard-refuses activation.

## Candidate native lifecycle implementation

`MacNativeHandoff` uses the installed Electron `AutoUpdater` interface with type-only
imports. Native and commit-owner ports are absent by default. Its owner port must
positively establish exact process-local approval, freshness/trust/identity,
held drafts/admissions, clean owned daemon stop, all protected writers quiescent,
verified complete state plus matching binary, durable recovery/restart identity
and accepted signed Mac engine **before** any native feed/check operation.
An interface result is not evidence that these producers exist.

The adapter rereads the existing delivery-v1 manifest, validates its exact digest,
candidate/Team identity and binding, and verifies the manifest's ZIP size/hash.
Files must be regular, privately owned, singly linked and opened without following
the final symlink; directory containment and an explicit byte budget are checked.
It captures the served ZIP bytes before calling the commit owner. The private
loopback server serves only those immutable bytes and one legacy server-format
feed, under an unpredictable process-local path, with bounded requests and time.
It does not extract archives, invent a second artifact manifest, use delta updates,
disable ATS, publish a catalog or relax signature verification. Native acceptance
must prove this loopback/ATS behavior with the shipped signed app.

After owner readiness, it sets the feed and calls `checkForUpdates()` once. Only a
matching download URL after that check permits one automatic `quitAndInstall()`.
`committed` means that quit/relaunch was **requested**, not that installation,
relaunch, identity verification or admission reopening succeeded. All later native
errors, unexpected no-update/download events, timeouts and thrown operations are
unknown. No path releases admission/drafts, removes candidate or protected state,
restores a binary, or retries native staging. Late events cannot cause another quit;
late errors are absorbed by a sealed owner. Reconstructing a wrapper over the same
Electron singleton preserves the attempt; a different target cannot reuse it.
This conservative singleton latch lasts for the process even after known refusal.

The pinned [Electron 44.4.5 API](https://raw.githubusercontent.com/electron/electron/v44.4.5/docs/api/auto-updater.md)
documents that checking downloads automatically, repeated checks download twice,
and downloaded updates can apply on the next start. It provides no cancellation
API. The [Squirrel server format](https://github.com/Squirrel/Squirrel.Mac#server-support)
uses a ZIP URL; this adapter emits only the legacy `url`/`name` fields. Consequently,
native checking is a commit action, never a metadata preview or pre-approval
download. Source inspection of the locked `electron-updater` MacUpdater also shows
its loopback proxy and native-check handoff; `autoInstallOnAppQuit=false` is not a
withdrawal guarantee once native staging occurs. Those source findings do not
select an engine or prove ordinary-quit/native cancellation acceptance. If #513
changes the Electron binary, inspect/probe that exact version again before enabling.

## Validation and remaining ownership

Portable tests use actual owned delivery-shaped bytes, real local HTTP transport,
the actual sandboxed preload, candidate/session guards and React primitives. Native
events and positive commit-owner readiness are explicit **synthetic** inputs.
They verify wrong target/digest/frame/epoch refusal, exact candidate projections,
guarded approval/defer, immutable ZIP serving, one check/quit, malformed/unknown
owner outcomes, timeout, late events and wrapper recreation. Existing Windows
update, Mac remount, session, coordinator and preload checks cover regressions.
No Mac signed binary, live user state or system permission is touched.

A subsequent, fresh implementation owner must compose the clean owned stop receipt
with the actual captured child (Workspace currently exposes no updater child-stop
capability), complete protected-writer capture, durable recovery identity and a
closed startup/reconnect fence. The normal app quit drain still uses ordinary
Workspace shutdown; it has not been relabeled as clean updater stop or recovery.
Diagnostics/crash capture is not the full protected-state restoration producer.
The process-local #539 restart proof does not survive app replacement by itself.
Do not connect this native adapter to #556's negative-only checkpoint as a shortcut.

Product/security owners still need the supported restore and newer-work treatment
from #394–396, final engine/lifecycle selection, approved catalog trust and consent
freshness/revocation policy, plus the unresolved OS floor/version mapping. The
accepted `dev.orca.desktop` → `com.schadewitz.orca` continuity requires Keychain,
intent-journal and TCC preservation; deleting/resetting state is never a fallback.

Before production activation, physical signed Apple Silicon N→N+1 must demonstrate
approval/defer and ordinary quit/relaunch behavior, signature/ATS/owned ZIP staging,
active work/callback/draft/new-admission guarding, clean stop and crash recovery,
matching UI/daemon/protocol/store identities **before admissions**, complete protected
state plus matching-binary restore, Keychain/intent/TCC continuity and wrong/external
target no-touch. #390/#388 unassisted tester acceptance remains unrun. An initial
signed engine lifecycle pass may take 1–2 hours once reviewed N/N+1 artifacts and
Mac access exist; the full fault/continuity acceptance matrix is a separate gate,
with no reliable completion estimate until restoration contracts/producers exist.
