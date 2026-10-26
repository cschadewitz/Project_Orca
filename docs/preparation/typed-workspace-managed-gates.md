# Typed workspace managed compatibility gate (#702 / #706)

Design for parent review; **no runtime gate, marker, schema, migration or activation is
implemented by this document**. Inspected main:
`df2e623175f58f2031efb0bb7386d2de1cae8990`. Also inspected
[#728](https://github.com/cschadewitz/Project_Orca/pull/728) at
`9e892d56ad3648e512dd7fc6c44bbd2f2fb23f57` and its
[persistence analysis](https://github.com/cschadewitz/Project_Orca/blob/9e892d56ad3648e512dd7fc6c44bbd2f2fb23f57/docs/preparation/strict-rule-persistence-compatibility.md).
That refusal-only writer is **not** the typed-safe floor: legacy repair still accepts
malformed or missing existing material. The persistence worker alone owns the typed
sidecar/schema/command and marker encoding. This document specifies required behavior,
not another file format. Cal owns this managed gate slice; parent owns interface approval,
independent review and merges. Reuse #702 and #706, already assigned to
`calciferschadewitz`; do not create a parallel policy-store issue.

## Decision, implementation hold and activation prerequisites

After explicit typed opt-in, require a reviewed typed-safe writer/runtime floor for
managed launch and writes. Refuse binary rollback and whole-root restoration for that
workspace, even to an otherwise compatible build, until a typed-safe recovery path is
separately reviewed. Legacy workspaces keep their existing behavior. Unknown typed state
closes the managed path; it does not become an empty legacy policy.

Runtime implementation remains on hold until parent review of the shared persistence
inspection/ownership contract and exact design. Requirements for enabling a typed path
are distinct from preparing its default-off implementation or accepting legacy beta:

1. Parent-approved persistence inspection/ownership contract, including durable typed
   enrollment intent, original identity/root-role binding and floor outside selected
   releases and managed restore targets. A marker only inside the sidecar/store can
   disappear when a v1 backup replaces it. The existing update namespace is resettable;
   it is not sufficient as an unmodified typed enrollment witness. This enrollment need
   not track every policy edit for the first path described below.
2. An independently accepted mapping from exact executable/build identity to supported
   typed writer/runtime contract. There is no accepted release number yet. Neither
   `orcaVersion`, protocol/store epoch equality, candidate declarations nor a future
   `minimumWriterVersion` field establishes that mapping by itself. This is an activation
   prerequisite for the enabled path, not a prerequisite to implementing default-off Linux
   seams or legacy beta. An unknown build mapping simply cannot enable typed operation.
3. Parent review of the first-path gate placement and shared owner/module boundary below.
   No new package/export or manifest field is selected here. Later App integration may
   import only protocol/design; agents cannot gain a reverse dependency on App or protocol.

Keep typed creation, migration and activation off until the enabled path's prerequisites
are resolved. A build without the enforcing runtime path is incompatible even if it can
parse the typed file. Incomplete Mac/Windows gates block enabling those paths; default-off
Linux implementation and legacy beta have no such dependency.

## First bounded path and root model

The first proposed implementation path is an explicitly non-hostile, managed Linux
deployment with a complete audited launch inventory and self-contained atomic policy
persistence. It may refuse App, remote, plugin and arbitrary-root launches, all updates,
binary rollback, whole-root restoration and other recovery, plus root-retarget/reset
while typed-enrolled. No provider breadth or forward-update support is required to build
this default-off path. The managed owner enforces enrollment/floor and restore refusal;
persistence owns the current policy generation,
revision and missing/corrupt checks under its writer lock. Durable enrollment survives
release selection and remembers that the workspace opted in. It is not an external
per-edit policy history. Manual file rollback, hostile same-user edits and arbitrary disk
rollback are outside this path. No first-path necessity for external per-edit high-water
history has been established under these assumptions. Future typed-safe recovery needs
a stronger anti-rollback proof before it can restore formerly positive grants.

Keep two exact sets distinct: **logical root roles** name configuration, sidecar, store
and control relationships; **physical protection/restore targets** are the deduplicated,
non-overlapping directory identities used by the existing ownership mechanisms. Preserve
every logical role and its identity/path binding when mapping it to a covering physical
target. For example, configDir `<workspace>`, sidecar `<workspace>/orca.permissions.json`
and storeDir `<workspace>/.orca` intentionally share one protection target `<workspace>`;
they are not three independently restored targets. Distinct roles may share an exact
directory when explicitly bound that way. Repeated identical role inputs are idempotent;
conflicting bindings for one role, omitted roles, ambiguous aliases or changed identities
refuse. Independently restored overlapping targets refuse. Control must remain outside
the policy/restore targets; it cannot be collapsed into a restorable parent.

This follows the descendant collapsing in
[`enrollUpdateWindowRoots`](../../packages/protocol/src/update-window.ts) and its existing
[nested store enrollment test](../../packages/protocol/test/update-window.test.ts).
Existing enrolled targets cannot be silently broadened to a parent: logical containment
does not authorize replacing an established physical ownership set. The gate validates
both the exact role mapping and the resulting physical target set.

## Source inventory and exact gate placements

Each row is a required integration seam, not a claim that it enforces this policy today.
The Linux CLI/persistence and Debian rows define the first path; App/Mac/Windows rows
record subsequent platform obligations and do not block that bounded path's acceptance.
The two `typed-workspace-*.test.ts` launch/CLI files are proposed; other listed tests exist.
The gate owner adds managed-path decisions; persistence owns schema parsing and every
sidecar writer's in-lock checks. Existing auth, signing, sandbox and update fences remain.

| Path / current entrypoint | Existing behavior and required guard | Regression owner / file |
| --- | --- | --- |
| CLI `src/main.ts:main`, `src/update-bootstrap.ts:enterCommandUpdateBootstrap`, `enterConfiguredUpdateBootstrap`; `src/bootstrap.ts:bootstrap` | The command gate inspects cwd/config/dir/home ancestors, then bootstrap enrolls resolved config/store roots before file stores/plugins. Inspect typed compatibility before root enrollment, first-run ownership writes, stores, identity initialization, auth/key creation, plugin load or resume. Recheck after resolving the actual config/store set. Help/version remain usable. Direct exported bootstrap and auth/init routes need the same guard, not just argv dispatch. | Managed gate: `packages/cli/test/typed-workspace-compatibility.test.ts`; existing `update-bootstrap.test.ts`, `runtime-launch.test.ts`. |
| App `src/main/workspace.ts:firstRunConnection`, `makeConnection`, `performSwitch`; `src/main/daemon-process.ts:startBundledDaemon` / `startOnce`; composition in `src/main/index.ts` | Check exact managed bundle and original configured roots before **each** spawn/retry, including file-mode/read-only and saved-receipt recovery. A read-only child still bootstraps stores and auth. Typed refusal must be terminal in both `performSwitch` (its startup-error catch falls back to a default URL) and `makeConnection` (its no-owned-child branch uses `daemon?.url ?? defaultUrl`). Neither fallback may connect an incompatible/unverified daemon. Reuse/reconnect also verifies current identity; no stale child/hello becomes authority. The first Linux mode may refuse this entire App path. | Managed gate: `packages/app/test/typed-workspace-launch.test.ts`; existing `workspace.test.ts`, `daemon-process.test.ts`, `first-run-windows.test.ts`. |
| Agents `src/permissions.ts:recordAlwaysDecision`, `replacePermissionPolicyFile`; daemon `src/config-model.ts:set`, `apply`, `writeConfigFile`, `writeSidecarFile`; `src/control.ts:prepareAlways` / `answer` | App policy editor forwards RPC, not filesystem writes. Config replacements and live standing answers funnel into these writers. Persistence must inspect under the existing sidecar lock and immediately before rename; refuse missing/corrupt/unknown typed state, v1 replacement over enrollment, or incompatible owner. Daemon guards saved config/apply too: a store/config-path edit cannot evade the original enrollment. Preserve current original-principal authorization and captured ceiling. Legacy append lacks the final authorization callback; typed commands must not copy that gap. | Persistence owns `permission-writer-compatibility.test.ts` and typed writer tests; managed owner coordinates daemon `config-methods.test.ts` and CLI root-retarget regressions. |
| Debian `tools/deploy/orca-release.py:Deployment.launch`, `exec_release`, `activate`, `restore` | CLI/ACP wrappers hold shared flock; daemon deliberately bypasses it to start closed. That flock alone cannot exclude a live/paused daemon during opt-in: require explicit daemon lifetime exclusion/settlement in the shared owner contract and gate every service launch. Activation holds exclusive admission and checks store epoch. `restore` stops service, selects previous binary, starts it and resumes. Check **all** cli/acp/daemon roles/targets before exec and before update/recovery effects, including old journals and automatic failure rollback. First mode may categorically refuse every enrolled update/recovery before stop/select rather than support compatible forward updates. Equal epochs do not authorize typed recovery. Preserve pending journals on refusal. | Managed gate: `tools/deploy/test_release.py`, fake releases/service/exec only. |
| Mac `src/main/mac-managed-update-application.ts:revalidateBounded`, `activate`, `captureClosedRecovery`, `verifyClosed`, `restoreClosed`; `mac-native-providers.ts:startClosed` | Recheck all window roots and exact accepted candidate/previous image before handoff and closed startup. `startClosed` currently assumes `<workspace>/.orca`; refuse unsupported layouts, never infer another identity. Gate within the lower restore owner too, so direct callers cannot bypass composition. | Managed gate: existing `mac-managed-update-application.test.ts`, `mac-fixed-path-recovery.test.ts`, `mac-native-providers.test.ts`. |
| Mac `src/main/mac-fixed-path-recovery.ts:backupPrevious`, `restore`; `mac-fixed-path-files.ts:PairTreePort.restore` | Fixed-path recovery restores each complete root and then binary, with append-only receipts; a lost receipt can repeat restore on same boot. Inspect current, previous and retained failed-candidate typed evidence **before capture/write of restore intent and before every tree restore**, including existing `restore.json`/step receipts. Typed/unknown means refuse; never reach native restore or its deletion/staging mechanics. Keep backups and receipts intact. Low-level tree port is a mechanism, not an independently authorized managed recovery entrypoint. | Managed gate: extend `mac-fixed-path-recovery.test.ts` with zero restore-call and byte-preservation assertions. |
| Mac `src/main/mac-replacement-recovery.ts:MacReplacementRecovery.recover` / owner `restorePair` | Existing complete root/write-revision/continuity equality still required for legacy. For typed/unknown, refuse before `restoring` commit and selection, irrespective of equality. Also gate candidate closed startup. Interrupted or old records cannot provide a typed recovery exemption. | Managed gate: extend `mac-replacement-recovery.test.ts`; fake owner only. |
| Mac `src/main/mac-managed-replacement-startup.ts:initialize`, `enrollProtectedRoots`, `reset`; `mac-update-namespace.ts:reanchorMacUpdateNamespace`, `macUpdateNamespaceResettable`, `resetMacUpdateNamespace`; `index.ts:offerUpdateProtectionReset` | Startup can re-anchor an open namespace after move/restore or offer explicit reset for lost records. Typed enrollment must veto automatic re-anchor/reset that loses original identity, role/target binding or floor, even if no update attempt exists. Read the independent enrollment witness before provisioning/repair. Existing confirmation to reset update protection does not authorize resetting typed compatibility. | Managed gate: extend `mac-managed-replacement-startup.test.ts`; include missing control plus surviving workspace enrollment. |
| Windows `src/main/updates.ts:Updates.act` restart branch; `update-driver.ts:install` | NSIS disallows numeric downgrade but exposes only a version string, without trusted typed compatibility evidence. Initially refuse typed/unknown managed installer restart before stopping a daemon or invoking `quitAndInstall` when proof is unavailable. Preserve the existing positively-not-launched versus unknown distinction; unknown must never trigger resume/reconnect. No feed/signing relaxation. | Managed gate: `updates.test.ts`, `update-driver.test.ts`, `first-run-windows.test.ts`; fake installer only. |

Paths in rows are relative to the named package unless explicitly prefixed. Store
`recovery-inventory.ts`/`recovery-validation.ts` are read-only engineering evidence with
recovery disabled; they must not be promoted to gate authority. Existing
`workspaceIdentity()` can initialize/renew identity and is backed up with the store;
the gate needs a non-mutating read before that function, bound to original enrollment.

## Minimal persistence handoff for review

Required semantic facts, with names/encoding/API selected by the persistence owner:

- A distinction between proven never-typed legacy, coherently typed, and unavailable
  (including pending opt-in/write, corrupt, missing, ambiguous, stale or unknown).
  Missing sidecar, empty text or a v1 document is insufficient to prove legacy once
  enrolled. A truly legacy workspace retains its historical repair behavior; a damaged
  typed workspace cannot enter that repair path.
- Original workspace identity plus every configured logical role binding (configuration,
  sidecar, store and managed control relationship), independent of a restored identity
  file, and its mapping to deduplicated physical targets as specified above. Include
  physical identities/canonical paths where the owner relies on them; lexical containment
  alone cannot establish ownership. One typed role blocks the entire multi-target recovery
  operation. Intentional containment/exact shared directories retain all role bindings;
  ambiguous aliases, conflicting/omitted roles and independently restored overlaps refuse.
- The required typed format/semantic contract and writer/runtime floor, bound to an
  accepted exact build identity. Unknown future values fail closed. Floor cannot be
  lowered by a full-text replacement, config apply, enrollment reset or old manifest.
- An exact committed policy generation and content binding, plus durable transition
  status in the self-contained policy persistence contract. Any successful create/edit/
  revoke or expiry edit advances this binding; revoked records/tombstones are retained
  according to that sole contract. Recheck the current generation under ownership; neither
  a sidecar revision nor an enrollment receipt establishes current principal authority.
- A durable typed enrollment witness outside **all** managed restore targets, selected
  release directories and backup pair selection. It binds typed intent/enrollment, original
  identity, role-to-target mapping and floor. Missing/corrupt/pending enrollment or missing/
  corrupt typed material refuses; no automatic legacy repair/reset is permitted. Normal
  policy edits do not require updating an external generation witness in the first path.
  Per-edit external anti-rollback history is a stronger future typed-recovery requirement
  to evaluate, not an additional database or cross-file commit prerequisite here. A
  restorable marker/timestamp alone cannot prove that an old positive grant is current.
- A fresh, owner-bound inspection and recheck mechanism. The gate consumes trusted
  parsed evidence from the same owner; callers cannot submit a boolean, marker path or
  client-supplied workspace ID as proof. The owner can report refusal separately from
  uncertain publication. No competing marker reader is implemented by this slice.
- Genuine final writer ownership through publication. Current agents
  `permissions.ts:withPolicyLock` / `breakIfStale` permits age-based takeover; a paused
  earlier writer can later rename its stale snapshot over a revocation, then its cleanup
  can remove another owner's lock. Atomic rename and an earlier revision/authority check
  do not prevent that race. Persistence must establish non-stealable ownership through
  publication, or an equivalent atomic fencing/publication mechanism; a check followed
  by an unfenced rename is insufficient. Storage owns this correction and its paused-
  writer regression; the managed gate must not label the existing age-based lock safe.

Opt-in must first close admissions and exclude incompatible existing writers under the
complete managed lifetime fence. Then durably record typed intent before publishing typed
material and complete enrollment only with valid committed typed material before reopening.
A crash at any opt-in edge leaves pending/unavailable; it never rolls back to legacy or
silently retries a write. The persistence owner specifies atomic policy publication and
its uncertain-outcome rules;
the managed owner specifies the one-time enrollment ordering and lock order, without an
inverse lock. Prove concurrent legacy append/replacement cannot cross opt-in. Later policy
edits use the self-contained atomic policy commit and current authority checks, without a
mandatory external per-edit commit. Missing/corrupt policy remains unavailable after any
edit. A safe opt-in/enrollment protocol and atomic policy contract remain prerequisites.
CLI/ACP shared launcher locks alone are not that complete fence: the daemon's bypass
requires its own verifiable lifetime exclusion, including suspended/paused processes,
before enrollment and through subsequent managed ownership changes. PID absence, an
idle RPC response or a stale lock age does not establish that exclusion.

## Gate behavior and authority lifetime

| Trusted observation | Managed ordinary launch / writes | Managed binary or whole-root recovery |
| --- | --- | --- |
| Proven never-typed legacy | Existing behavior and existing safeguards | Existing behavior and existing safeguards |
| Coherently typed, exact supported floor/build, current generation | Only through the reviewed enforcing runtime/writer | Refused, preserve evidence |
| Typed with incompatible/unknown build or contract | Refused before producer/spawn | Refused, preserve evidence |
| Enrollment/material missing, corrupt, pending, mixed or changed | Refused; recovery shell/read-only diagnostic inspection only | Refused, preserve evidence |

Owner snapshots input before awaits, retains the exact original identity/root set and
accepted image, and validates before and after asynchronous inspection and immediately
before spawn, rename, pointer selection or restore dispatch. Reads use bounded no-follow
file handles, regular single-link checks, owner/access validation, stable file/path identity
and canonical ancestors; symlinked policy/control/root aliases and hardlinked metadata
refuse. Do not outlaw legitimate internal binary framework links already handled by the
existing verified image/tree port. File reads alone cannot fence another participating
writer: retain lifetime enrollment ownership and persistence's reviewed final publication
owner, rather than trusting the existing age-based lock. Later supported update selection
also retains exclusive physical-target ownership. Under ownership loss, changed generation,
root replacement or late completion, discard the positive result and stay closed.

Durable receipts establish identity/evidence only. They cannot resurrect a boot/session
lease, installation consent, live answer callback, execution permit or original credential.
Reacquire current same-boot ownership with all slots and verify current principal authority;
cross-boot/uncertain ownership remains an explicit recovery concern. Restored old auth,
allow rules or approval records cannot regain authority from a receipt. Typed restore is
refused even when content equals a backup, so there is no equality-based grant replay.

Refusal must happen before restore intent/capture mutations where possible and always
before the first replacement/deletion/installer/stop. Preserve exact existing roots,
both pairs and old journals. If an operation was already dispatched, retain closed
uncertain state and inspect its actual outcome before any retry; never label it a clean
refusal. A typed workspace already partially restored stays closed without resuming
legacy steps, deleting evidence or manufacturing a fresh identity.

Actionable result: "Typed workspace compatibility could not be verified. Managed startup
or rollback is blocked. Keep the workspace, recovery folder and matching binaries intact;
use an accepted typed-safe build for inspection and request reviewed typed recovery."
Expose a bounded reason (unsupported build, incomplete enrollment, generation mismatch,
identity/root mismatch or recovery unsupported), not rule contents, tokens or raw paths
from untrusted records. No force/repair bypass is introduced.

## Supported boundary

The managed release wrapper/supervisor and its enrollment witness must remain outside
the selected/restored release and root trees. Opt-in requires a complete launch inventory
and exclusion of already running incompatible writers; a new binary checking its own
version after it started is not prevention of old-binary launch. Updated App launch code
checks the bundled child before spawning; managed updater selection prevents returning
the App itself to an incompatible build. A user manually opening an old App, invoking an
old CLI outside the managed wrapper, restoring the external witness together with all
roots outside this recovery owner, or changing files as the same OS user is outside
this managed-path guarantee. Metadata cannot retrofit checks into those executables.
Do not claim protection against hostile same-user edits or arbitrary disk rollback.
Unsupported/unmanaged launch configurations cannot opt in through the supported path.

## Bounded implementation and acceptance

First consume the parent-approved persistence inspection contract without modifying its
schema/command files. Implement only the reviewed default-off managed Linux scope:
approved shared decision/owner seam, Linux CLI/bootstrap/writer integration and Debian
launch plus categorical enrolled update/rollback/recovery/retarget/reset refusal. Refuse
App/remote/plugin/arbitrary-root launch when outside the accepted scope. Validate normal
nested config/store roles with one covering physical target. No App/Mac/Windows beta
barrier is added. Later platform slices separately add
App spawn without URL fallback, Mac restore/resume/reset vetoes and Windows installer
refusal. A platform lacking trusted contract/build proof remains unavailable for typed
opt-in; its unfinished integration does not block bounded Linux acceptance. Passing
Linux fixtures does not establish acceptance for another platform.
The exact accepted-build mapping is needed before enabling this mode, not before writing
its disabled guards/tests. Legacy beta acceptance gains no new all-platform dependency.

Required synthetic cases, owned in the files above, apply to each claimed platform path.
Linux acceptance covers its launch/writer/enrollment and release/recovery seams; Mac/App/
Windows-specific fixtures remain later platform acceptance, not first-path prerequisites:

1. Legacy absent/v1/repair and existing recovery remain unchanged; help/version work.
2. Typed floor supported/older/unknown, future contract, v1 replacement, empty/truncated
   sidecar, missing/corrupt enrollment/marker/identity and pending opt-in/publication.
   Reject stale expected policy generations; a normal atomic policy edit must remain
   coherent without an external per-edit witness write. Assert no refused policy bytes
   replaced and no child/plugin/auth writer.
3. Original identity replaced at same path; cloned identity at different path; changed
   storeDir/config root; symlinked ancestors/sidecar/control; hardlinked metadata; one
   typed role among several. Accept bound nested configDir/storeDir and exact shared
   directory roles with deduplicated physical targets; preserve every role binding.
   Refuse conflicting/omitted roles, ambiguous aliases, independently restored overlaps
   and broadening of an already enrolled target.
4. Gate inspection paused at an await while generation/revocation/root/image/owner changes;
   spawn retries and reused-child/default-URL fallback never cross the refusal. Opt-in
   racing legacy append/replacement must have one serialized outcome or remain closed.
   Pause a writer past the old lock's takeover age, commit a later revocation, then resume
   the first writer: it must not publish stale bytes or remove the current owner's lock.
   A live/paused daemon that bypasses shared launcher flock must block opt-in; no generic
   service launch may escape the required daemon lifetime owner.
5. Typed present only in previous pair, failed candidate, original enrollment or interrupted
   receipt; live v1 bytes after partial restore; old pre-typed manifest/activation journal;
   resumed restore whose first root was already replaced. Assert zero further restore,
   delete, pointer-select, stop, installer or launch calls and exact evidence preservation.
6. Backup contains a formerly positive grant now revoked: refuse both binary-only and
   whole-root rollback, even with equal store epochs or an allegedly newer binary.
7. Missing/reset/moved update control, open/no-attempt re-anchor, explicit reset, stale
   boot/session/credential/approval and lost acknowledgement cannot authorize reopening.
   Refusal is stable/actionable; uncertain dispatch cannot be replayed automatically.

Use disposable synthetic roots, fake executable identities, fake service/installer/tree
ports and existing bounded test workers. No actual update/install, Mac access, credentials,
live daemon restart, network permission change or existing policy mutation. Preserve the
pinned lockfile, lifecycle policy, signing, sandbox, preflight and rollback safety checks.

This draft has source/document checks only. Runtime adversarial tests remain acceptance
work after the shared contract and exact design are approved; no test-pass claim is made
for the unimplemented gate. Nothing here completes #702/#706 or authorizes deployment.
