# First-run recovery and saved configuration — 9 October 2026

This bounded slice consumes corrected #569 `1a2e003e04beaa2e13cd35115faa6c4234145264`
and final #567 `9ac19ead4347180e44be6162a41d2d5726b3f929`. A non-squash merge
`40f1143194ec52b9ee9578699edae15c9a494c26` preserves both; no constituent was rewritten.
The implementation owns #570 and the remaining #386 saved real-agent configuration
binding/local executable preflight. Casey's explicit recovery instruction supersedes
#570's historical deferral. Shared app entrypoints remain separately owned.

## Reviewed recovery authority and supported operator route

The proposal delivered before implementation uses explicit full-machine restart as
the smallest independent old-writer quiescence authority. It does not infer death
from PID existence/absence, callback arguments, hello, a timeout or expired run leases.
No daemon is adopted or signalled. No uncertain record, credential, retained work or
store bytes is removed/reset. Reconciliation itself starts no daemon and replays nothing.

1. In the existing Config setup section, explicitly prepare machine-restart recovery
   for the saved selected workspace. This appends `recovery-request.json` to the
   intact final ownership attempt. It binds a random request/reservation ID, the
   exact anchor and existing record digests, current config hash, exact canonical
   store directory identity (or verified absence), hashed host identity and OS boot
   generation. The request is exclusively created/fsynced; the attempt directory
   is synced. Preparation leaves any live daemon untouched. Late evidence changes
   invalidate the request rather than being silently incorporated.
2. Fully restart that same machine. Closing/restarting the app, a daemon stop return,
   sleep/wake and rechecking a PID cannot satisfy this route. After a request exists,
   the old app owner's exact evidence checks refuse reuse/settlement. Matching new
   app startup refuses the pending attempt. Matching CLI bootstrap refuses writers,
   including serve/direct run/resume/ACP and nested cwd/store aliases, before opening
   stores, loading plugins or provisioning auth. A resolved request also blocks CLI
   startup until the app reserves the subsequent verified generation.
3. Reopen the same selection and explicitly reconcile the request. Main reads trusted
   OS observations; renderer inputs contain only the main-issued UUID. The same host,
   a different boot generation, approved local volume and unchanged anchor/config/
   journal/store identities are mandatory. Append `recovery.json`, bound to the exact
   request hash and reservation, with `same-host-new-boot-fenced` observation. Preserve
   `claim.json`, child/identity/terminal records and every previous attempt verbatim.
4. Explicitly Connect to start a new owned generation through the existing hello/
   discovery/activation path. Then inspect retained work. For reconciled first-run
   stores the CLI suppresses automatic startup and timer continuation recovery;
   retained continuations require explicit operator action. This flag is derived
   from retained resolution evidence, never deleted to restore automatic retry.

Only the last intact attempt may be unsettled. Interrupted claim-only startup and
attached-child startup/cleanup can use this route. Missing/torn claim or anchor,
unknown files, malformed/stale/transplanted records, changed config, changed store,
wrong host, unknown native identity or an exhausted budget refuse. If a daemon creates
an absent store or appends child/identity evidence after preparation, reconciliation
refuses the changed evidence. Requests are not overwritten or automatically abandoned.
No boot proof, no resolution. Same-boot ordinary app crash/relaunch remains blocked;
its supported outcome is preparation followed by a full-machine restart, not automatic
orphan adoption. Corrupt evidence requires separate operator review.

## OS and filesystem boundary

Darwin reads fixed `/usr/sbin/sysctl -n kern.bootsessionuuid` and bounded
`/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice` observations, hashing IOPlatformUUID.
The existing diagnostic clock already consumes that kernel boot-session UUID. Apple's
[XNU implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c)
exposes it read-only. Recovery additionally requires `/usr/sbin/diskutil info -plist`
to identify internal APFS. No PATH-selected program or renderer-supplied OS evidence
is accepted. Every native command has a two-second/64-KiB bound, fixed argv, empty
environment and captured stderr; raw errors, machine IDs and volume output are not logged.
Unknown commands/keys/output/volume/owner refuse. No OS restart is executed by the app.

Linux reads `/etc/machine-id` and kernel boot_id, and allows only local ext-family,
XFS or Btrfs observations. Overlay, tmpfs, FUSE and network filesystem types refuse.
This cloud workspace's portable positives inject **synthetic** host/boot/local-volume
authority; they do not establish a real reboot or native volume result. Windows remains
blocked under the inherited missing reliable current-owner contract. No native helper,
credential provisioning or production diagnostic/updater activation is added.

This is a bounded local, same-principal filesystem contract. It assumes the approved
store stays exclusively attached to this host and every supported writer uses the
matching fenced app/CLI binary. Older/uncooperative binaries, cloned machine identity,
shared block devices, deliberate coherent same-principal evidence rewriting and
concurrent pathname replacement are outside its authority. Existing hash/owner/no-follow
checks are not a signed lifetime supervisor or immutable native handle proof. Physical
Mac reboot, disk identity/mount behavior, filesystem permissions, crash/power-loss
fsync durability and packaged matching-binary enforcement remain acceptance gates.
A resolution proves old local process generations cannot write after the full reboot;
it proves neither clean run completion, external-effect rollback nor updater safety.

## Real-agent saved-configuration persistence and preflight

The sample and its exact asset digests remain agent-free and JEV-free. Save/apply real
local-agent configuration through the existing structured Config review workflow, then
explicitly Review saved configuration for reopening and Bind reviewed saved configuration.
Main captures the exact surviving owned first-run daemon; no new process or alternate
endpoint is consulted. Its authenticated `config.get` snapshot must bind exact local
bytes/revision/path and saved config generation. The existing domain schema is exposed
through protocol's node-free barrel, preserving ADR 0008 and avoiding a second parser.

Rebind preserves the same project root, `.orca` store, local host, pause mode, sample
workflow and exact sample assets. Plugins, remote agents/hosts, outside-workspace workflow/
template paths, invalid generation and changed roots/assets refuse. Up to 32 local agents
are inspected using only absolute executable paths or the daemon/app PATH supplied in
main. Checks report missing, inaccessible/unknown format, incompatible native Mach-O
architecture, or executable availability **requiring an explicit handshake**. No version,
ACP support, sign-in/subscription or provider safety is inferred from availability.
No shell/login environment, tool installation, provider executable invocation, secret
projection or standing permission grant occurs.

A main-only five-minute review handle captures the receipt and exact saved hash. Binding
rechecks frame/epoch/target/files/revision, appends a bounded chained `config-rebind-NNNNNN.json`
record via the surviving exact ownership object, then atomically replaces only the app's
selection receipt. Journal/receipt retain hashes, not config text/env/credentials.
Subsequent cold startup verifies the updated hash plus unchanged identities/sample assets.
Ordinary direct-child termination includes the final config hash; old terminal records
with no config rebind remain supported. All prior claims remain intact.

Unreviewed config edits remain refused. App/child loss or a failed receipt publication
between Save and completed Bind conservatively leaves that configuration unbound;
this slice does not invent an atomic cross-file save/journal/receipt transaction or
recover config content from guesses. Preserve files and report that partial-binding
case for operator recovery; a fresh empty selection is independent new work. Binding
is not permission approval, launch, ACP/sign-in/version acceptance or #420 evidence.

## Pinned shared-owner wiring handoff

[The 141-line patch](patches/first-run-recovery-wiring-f4ca654.patch) targets #572
`f4ca6540f94ad4a06704b20d0b9c4c4dd2cc9943` exactly. It is provided for the shared owner
to apply after composing this slice. No repository main/preload/Workspace entrypoint
was edited here. No refresh/merge of #572 or #568 was performed for this handoff.

- `Workspace.captureFirstRunConfiguration(path)` returns the main-only captured client,
  lifetime/target check and `rebind(expectedHash, savedHash)`. It validates the exact owned
  daemon/path/identity and epoch without treating a reviewed pending Config save as
  terminal proof. The durable object's rebind independently checks all retained evidence.
- Main supplies that capture as `FirstRunDeps.configuration`.
- Preload adds four UUID/no-input calls: prepareRecovery, reconcileRecovery,
  reviewConfiguration and bindConfiguration. Existing installFirstRunIPC registers
  their strict schemas and frame/document/epoch/update boundaries.
- The existing setup component exposes the separate explicit controls only when the
  native bridge has the new methods. Error messages use fixed safe recovery instructions
  or generic refusal, never arbitrary native/transport text.

`git apply --check` passes against this branch's unchanged pinned entrypoint blobs.
Parent/shared owner must compose and validate the mounted app on the actual combined
head. The patch preserves #572's updater drain work and all current guarded connection,
protected-intent, draft and diagnostic boundaries.

## Validation and remaining gates

Installed Node 24.19.0, Vitest 5.0.2 and TypeScript 7.0.2 were used directly. No install,
dependency/manifest/lockfile change or pnpm invocation. No full suite/coverage, Actions
dispatch, merge, release, deployment, credential/access change or provider operation.
The requested 24.21.0/pnpm 12.4.2 binaries are not supplied by this environment.

Focused recovery/ownership/setup/Workspace/UI selection: **112 passed, one inherited
Windows-only conditional skip, five files**, 4.67 seconds, at most two workers, before
three additional UI control/privacy tests. The final UI-only selection passes **5 tests**
in 1.80 seconds, including those three new tests; the total distinct selection is
**115 passing tests** plus the same one conditional skip. Includes the real disposable compiled CLI
child from the inherited Workspace test. Source compile inputs are pinned per worker;
synthetic Electron/subscription and native boot proof remain explicit boundaries.
Exact recovery failures cover same boot, wrong host, stale request, changed config/claim/
child, unknown/missing request/anchor/claim, replaced store/journal, link attacks, unknown
volume/boot and stale epoch, without resolution/deletion/signal/startup. Configuration
checks cover reopen, hash-only persistence, stable sample/project/store identity, missing
PATH executable, changed root/store/host/plugin/workflow/asset/revision/generation/path,
changed target/epoch/config/receipt and stale review.

Root/renderer TypeScript, changed-file ESLint/Prettier and patch application checks pass.
The patch also includes two targeted Workspace capture tests. In an isolated worktree,
installed root/package dependency directories were linked without installation; root
TypeScript passes with the patch applied. The two patch-isolated capture tests pass
(11 unrelated cases excluded by name), and patched-entrypoint/test ESLint/Prettier pass. No broader acceptance is inferred. Real ACP/version/sign-in/tool/provider
execution, physical Apple Silicon/Windows device, Finder/environment, native reboot/store
fencing/durability, secure storage and packaged #386/#390 acceptance remain separate.
