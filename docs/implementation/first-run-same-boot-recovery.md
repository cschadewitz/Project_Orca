# Same-boot first-run ownership reconciliation — 9 October 2026

This replacement slice targets #570 on #572 `db9bdc6c5fe086b905a702dd44fe5dc0ff2313aa`.
That baseline preserves corrected #569 `1a2e003e04beaa2e13cd35115faa6c4234145264`
and #567 `9ac19ead4347180e44be6162a41d2d5726b3f929`. Casey rejected the
whole-computer restart prerequisite in #577 `3deeeed4b4a8f3a069263668d76065675425c307`.
No reboot route is included in this slice. No constituent ancestry is rewritten. The
person-confirmed route for an attempt left by an earlier boot was added later, by the
owner's 14 October decision; see [After a restart](#after-a-restart-person-confirmed-end).

## Lifetime fencing before writers enter

New version-2 claims retain the original append-only anchor/claim chain and add a
`kernel-lifetime-v1` contract, host/boot/kernel-domain identity, the exact existing
store identity or verified absence, and a hash of a random launch capability.
The capability stays in main memory and the exact spawned child's environment.
It is never stored as plaintext, passed through preload, or inherited by subsequent
agent/plugin work: bootstrap captures and removes it before constructing runtime objects.

The Node-only `@orca/protocol/first-run-fence` subpath is shared by CLI bootstrap
and app main. The renderer's protocol barrel remains node-free. Before opening
stores, loading plugins or provisioning auth, matching CLI/bootstrap acquires a
stable exclusive loopback listener keyed by canonical workspace path, device,
inode and owner. It uses `exclusive: true`, `reusePort: false` and no alternate-port
fallback. A collision refuses access. The supported writer retains that listener
for its complete process lifetime and receives no release capability; `unref()`
permits natural process exit without releasing the handle while work is running.
The kernel releases it on process exit, including app-independent child exit.
See [Node's listen contract](https://nodejs.org/api/net.html#serverlistenoptions-callback).

Under that handle, bootstrap rereads the exact current claim, verifies its launch
capability/config/boot/domain/store bindings and refuses any prior child, writer,
terminal or recovery entry. It creates a missing store directory, captures its
canonical identity, and fsyncs `writer.json` before runtime writes begin. This
record binds claim digest, reservation, workspace/store identity, PID and a random
process generation. PID reuse cannot substitute for that generation. App attachment
requires this record and the returned direct-child PID; authenticated hello still
binds workspace/instance identity and exact store. An older bundled binary that
omits the attestation is refused rather than silently admitted to the new contract.
The fence endpoint returns only a record digest, never paths, credentials or host facts.

Direct CLI/ACP/bootstrap access to a first-run store requires the main-only launch
capability; nested cwd, symlink and store aliases cannot bypass the journal. Direct
auth and demo mutations also refuse these stores before writing. Other stores
retain their existing execution/lease semantics. The updater replacement owner
must not mutate this journal or bypass the admission guard. A replacement child
for this store needs an authorized fresh reservation; this slice does not grant one
through an updater operation.

## Explicit operator recovery and outcomes

Review same-boot recovery appends an immutable `recovery-request.json` binding the
exact claim/child/identity/writer/config evidence, anchor and current store identity.
It starts no process, sends no signal, changes no credential and replays no work.
Only a main-issued UUID crosses IPC. Review invalidates the lost/surviving app
owner's ability to reuse or settle that attempt through its old captured object.

Reconcile returns distinct supported outcomes:

- **Surviving owned daemon:** the occupied fence returns the digest of the exact
  retained writer record. Preserve it. No adoption, shutdown or replacement launch
  occurs; its existing authorized lifecycle must finish or an operator must decide
  how to stop/reattach it. Such a lifecycle action is outside this slice.
- **Unknown/foreign writer:** the fence cannot be acquired and its response does
  not match the retained process generation. Preserve everything for operator review.
  A timeout or a listener answering is never quiescence evidence.
- **Exited writer / interrupted pre-writer launch:** recovery acquires the same
  exclusive kernel handle, then rechecks caller epoch, boot/domain, anchor, all
  retained bytes, config and exact store identity while holding it. Only then does
  it fsync `recovery.json` with `exclusive-writer-quiescent` evidence. No PID absence
  query is made. Release occurs after durable settlement. A delayed old child must
  acquire the fence and reread its claim; the retained recovery entries refuse it
  before store/auth writes. Competing reconciliations cannot append two resolutions.

Connect subsequently reserves a fresh generation and follows the original
credential-backed hello/discovery/activation route. Any store with a retained
resolution suppresses both startup and timer continuation recovery. Inspect retained
work and continue it explicitly; ownership settlement is not clean work completion,
external-effect rollback, runtime-drain-v1 or updater replacement authority.

Reconciliation preserves all auth files, ownership/audit history, journals, protected
intents and retained work byte-for-byte. **Normal subsequent Connect retains the
existing `bootstrapLocalOwner` policy, which rotates the local bootstrap credential.**
This is not a reset by recovery. Reusing that credential would change the auth policy;
that choice was surfaced before making any exception, and no exception is implemented.
First-run launch also waits for the exact child's completed token-file announcement
before accepting hello, closing the old-token/startup-metadata race found in recreation.

## After a restart: person-confirmed end

Same-boot recovery cannot settle an attempt claimed on an earlier boot: its fence and
writer belonged to that boot, and the claim and writer boot checks refuse it. Before
14 October such an attempt blocked the workspace for good. This is the ordinary result
of a power loss, a crash or a forced restart. It is also ordinary on Windows, where
shutdown, restart and logout emit no quit events to settle the child's exit.

**Owner decision (14 October 2026):** an attempt from an earlier boot is settled only by
an explicit, person-confirmed resolution. It is never automatic, and it never requires a
restart. This is distinct from #577's rejected route, which made a whole-computer restart
the prerequisite and settled it as `same-host-new-boot-fenced` through its own reboot
schemas and `recovery-host.ts`. None of that is composed here.

The flow:

1. **Startup.** `status()` reports `recovery` / `previous-boot` with the attempt's
   reservation ID when the latest attempt is an unsettled version-2 claim whose recorded
   host matches this host and whose boot ID differs from the current one. This check
   runs before a pending same-boot request, which can no longer be reconciled. Startup
   does not connect, and nothing is settled by reading the state or by Connect. A legacy
   version-1 claim recorded no boot and is not offered. Another host's boot is not a
   restart of this one and is not offered either.
2. **Confirm.** Config shows that the last session ended uncleanly before this computer
   restarted and offers **Mark previous session ended**. The action has no way back,
   so it asks on its own row: **Keep** first and focused, then **✕ Confirm previous
   session ended** in the danger tone, with the consequence beneath and `Esc` through
   the layer stack (`docs/design/RULES.md` rule 17). Only the shown reservation ID
   crosses IPC (`orca:workspace.firstRun.endPreviousSession`), under the same caller,
   epoch and update-window guards as the other setup routes.
3. **Settle.** `endPreviousBootSession` first rechecks that the reservation is still
   the unsettled latest attempt from an earlier boot of this host. It applies the store
   rules of same-boot recovery: the attested writer's store, or the claim's store with no
   child. Then it acquires the same kernel lifetime fence. If anything live holds the
   fence, it refuses and writes nothing. While holding the fence it rechecks the caller,
   every retained byte, the boot and the store. Only then does it fsync
   `ended-after-reboot.json`, release the fence and verify the journal strictly.
4. **Continue.** Connect then reserves a fresh generation as usual. The settlement counts
   as a resolution for the CLI continuation fence, so retained runs wait for explicit
   inspection and continuation, as after same-boot reconciliation.

The settlement binds the reservation, claim, anchor and config digests, the store
identity and the confirming boot. It records `reason: "person-confirmed-after-reboot"`,
`observation: "fence-free-after-reboot"` and the actor (`person`, `desktop-app`, the
owning uid). It also carries a digest of every other record of the attempt. Inspection
accepts it only on an attempt that was not otherwise settled, from the claim's host on a
different boot, confirmed by the workspace owner, with nothing added afterwards. A pending
same-boot request is resolved by it. The checkpoint's carried resolution bit includes it
when compaction folds the attempt. Any failed check refuses with
"The previous session was not marked ended…" and changes nothing. The Windows native
writer admits the new file name, and the boot identity is the platform one already
recorded (`boot_id`, `kern.bootsessionuuid`, the native Windows boot ID).

## Save-before-Bind interruption

The reviewed saved-configuration binding, shared domain schema, local executable
preflight and tests from #577 are retained and adapted. Main still validates unchanged
project/store/local-host/pause/sample roots and assets, excludes plugins/remote hosts/
outside-workspace asset paths, bounds agents, and reports executable availability
without executing a provider or inferring ACP/sign-in compatibility.

After app loss, explicit Review saved configuration may read the exact local saved
bytes when no surviving owned config client can be captured. Bind acquires the writer
fence, rechecks intact evidence, exact saved revision, boot/domain/store and caller,
then appends `reviewed-quiescent-config` evidence and updates only the app selection
receipt. A busy/foreign fence refuses binding. Repeating explicit review/bind after
journal append but interrupted receipt publication is idempotent and appends no duplicate
binding. Config text/env/credentials never enter ownership records or receipts.
Configs are bounded to 1 MiB; ownership records remain bounded to 4096 bytes.

Binding does not itself reconcile an uncertain startup, start an agent, grant permission
or continue work. Perform explicit ownership recovery next. Broken/missing selection
receipts, corrupted records, root/asset changes and unverified pre-ledger stores remain
refused; this is not guessed configuration repair.

## Compatibility and authority limits

Version-1 uncertain #569 claims never attested to a lifetime fence. They remain
preserved/refused: acquiring a new listener cannot prove an unfenced old writer has
stopped. Existing matching direct-child terminal evidence remains readable and permits
normal new reservation. Torn claim/anchor/writer/request records, replaced stores,
missing writer records after child attachment, stale review handles, wrong boot/domain,
unsupported volume/owner and exhausted budgets also refuse. Interruption after store
creation but before writer attestation remains uncertain if that store was absent in
the claim; it cannot be silently explained away.

The contract requires matching cooperative binaries, one host/kernel network domain,
and an approved locally attached store. Linux records `/proc/self/ns/net` identity
in addition to machine/boot identity; another network namespace cannot establish
quiescence over that store. Linux accepts ext-family, XFS, Btrfs and local overlay
(reference-container upper storage); tmpfs/network/unknown types refuse. Darwin uses
fixed bounded sysctl/ioreg observations and requires internal APFS from diskutil.
Windows remains blocked by the inherited current-owner/platform observation boundary.
Native filesystem ownership, actual mount exclusivity, concurrent same-principal
pathname replacement, deliberate coherent evidence rewriting, uncooperative older
writers and physical durability are outside this bounded path-based portable proof.
No on-disk hash is represented as authentication against its own OS principal.

## Shared-owner wiring and superseded #577 code

[The 184-line wiring patch](patches/first-run-same-boot-wiring-db9bdc6.patch) applies
against unchanged #572 main/preload/Workspace/test blobs. It passes the launch
capability through Workspace and main into the bundled child, supplies the surviving
owned configuration capture, and mounts recovery/configuration IPC in preload.
Two capture tests and the real Workspace fixture adjustment are included. Shared
entrypoint files remain untouched in this slice; the integrator must apply this patch
and validate the final composed head before acceptance.

Do not compose #577's `recovery-host.ts`, reboot request/resolution schemas,
`same-host-new-boot-fenced` route in `recovery.ts`/`ownership.ts`, reboot-only CLI
pending fence, restart-required UI/tests, or `first-run-recovery-wiring-f4ca654.patch`.
This replacement supplies different schemas, lifetime admission and same-boot recovery.
Reusable #577 configuration/preflight/schema/binding tests are copied by path from its
pinned head, with offline interruption support added; #577 itself is not merged.

## Evidence and remaining gates

Focused source checks use installed Node 24.19.0, Vitest 5.0.2 and TypeScript 7.0.2.
The requested Node 24.21.0/pnpm 12.4.2 binaries are unavailable; pnpm is not invoked.
App declares the already-used YAML parser for offline config reads; its installed
workspace dependency is linked for execution without installing or changing lockfiles.

The real Linux fixture launches an app-owner process that actually spawns its own
compiled authenticated CLI daemon. The test verifies their OS parent/child relationship,
crashes the app owner, distinguishes the surviving daemon, then explicitly ends the
disposable child and verifies same-boot recovery/recreation with the same workspace ID
and a different instance ID. Fixture cleanup checks captured process birth before
signalling; production recovery never signals. Other cases cover pre-writer interruption,
retired launch capability, foreign occupied fence, competing reconciliation, wrong
boot/domain/caller/store, legacy refusal, retained evidence and offline Save-before-Bind.
Existing in-memory child tests use clearly labeled synthetic attestation fixtures;
they do not claim a real lifetime fence.

Final focused selection: **109 passed, one inherited Windows-only skip in five files**,
5.76 seconds with at most two workers. The isolated final wiring selection has
**13 passing Workspace tests**, including its real authenticated CLI-child case.
Root and renderer no-emit TypeScript, changed-file ESLint/Prettier and patch/whitespace
checks pass. These are narrow portable results, not combined native acceptance. No broad suite/coverage,
Actions dispatch, merge, release, deployment, provider execution or live installation
change occurs. Publication uses a skip-actions commit marker. Physical Mac/Windows,
packaged matching-binary enforcement, real-agent/secure-storage acceptance and the final
shared-owner composition remain separate gates. Surviving-orphan lifecycle and legacy
unfenced migration need explicit independent authority, not a reboot fallback.
