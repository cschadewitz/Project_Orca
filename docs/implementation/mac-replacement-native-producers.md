# Native replacement journal producer — #571 / #387

The current fixed-path closed-window successor is documented in
[mac-closed-window-fixed-path.md](mac-closed-window-fixed-path.md). It preserves this
constituent and replaces its earlier ledger/topology assumptions with the approved
closed-window invariant. The #580 patch below remains historical; use the successor's
#584-pinned handoff. Existing encrypted legacy namespaces are retained and refused,
because their AAD binds the original path.

This focused dependent slice starts at exact [#580](https://github.com/cschadewitz/Project_Orca/pull/580)
`b45b2a0d7df15798e6ba985d71f6e9d507d9cee4`. The branch is
`calcifer/native-replacement-journal-producer`. Author and committer:
Calcifer Schadewitz `<schadewitzcalcifer@gmail.com>`.
Read this alongside [the composition inventory](app-native-recovery-composition.md).

## Concrete correction

The existing `MacReplacementJournal` requests `replacement.tmp` and `replacement.enc`,
but the actual `diagnostics_storage` native backend rejected both names. Its existing
replacement tests used `PosixFixtureNativeAdapter`, which accepted those names and
therefore did not exercise this production incompatibility.

The compiled backend now has an explicit `replacementStorage: 1` capability and a
separate handle namespace. That namespace permits only the journal's encrypted
envelope/temp file (40 KiB) and its kernel lock (4 KiB). It rejects diagnostics files,
export/picker operations, reverse replacement and deletion of recovery evidence.
The diagnostics namespace still rejects updater files. Root traversal, owner/mode,
native ACL checks, no-follow handles, inode checks, descriptor budgets, file flush
and directory sync remain the existing native implementation. Older addons lacking
the capability fail closed; the current package source digest already includes
`storage.c`, so rebuilding/staging the resources is necessary.

A missing updater root is **unknown**, not a request to create an empty root.
Unlike diagnostics, the replacement namespace never implicitly provisions its root.
Neither this native storage nor its kernel lock covers other protected roots or
app/daemon/CLI/ACP writers.

`mac-replacement-storage.ts` loads the fixed packaged native backend on Darwin.
`mac-replacement-startup.ts` constructs the actual encrypted journal with the existing
async safeStorage key adapter and the existing `MacReplacementBootstrap`. This is
a concrete journal producer/composition, not another update preparation coordinator.
The bootstrap starts closed synchronously. Dispatching any journal commit or closing
the owner seals ordinary startup synchronously; cached or late clear reads cannot
reopen it. Closing waits for dispatched work to settle and closes held native
descriptors even when a changed pathname prevents ordinary lock release. It retains
records and incomplete temp files. No automatic restore or admission reopening is added.

## Pinned integration handoff

[571-native-bootstrap.patch](patches/571-native-bootstrap.patch) is pinned to #580
`b45b2a0d7df15798e6ba985d71f6e9d507d9cee4`. It changes only the integrator's main
entrypoint and its existing IPC regression file. It is supplied unapplied: shared
main, preload, Workspace, first-run files and the admission-intent journal are
unchanged in this branch.

The patch mounts the native startup owner synchronously at the separate
`userData/native-replacement` root, injects the existing Workspace bootstrap gate,
and inspects after Electron readiness before ordinary diagnostics/first-run/child
startup. It closes preference writes, intent/guided IPC, first-run caller checks,
diagnostics IPC and connection preference saves while bootstrap is unresolved or
closed. Unknown startup opens a recovery shell with existing data retained. Main
still constructs a sessionless `MacUpdateApplication`; installation and diagnostic
production capture remain disabled.

**Do not apply this as a complete replacement implementation.** The initial namespace
provisioning/continuity authority must be supplied first. With no valid pre-existing
native updater root, the proposed Mac composition intentionally remains closed.
It does not fence independent CLI/ACP processes or supply the closed replacement
child. An in-process gate check cannot replace all-writer ownership, write accounting
or a persistent native supervisor fence.

> **Superseded (2026-10-14).** The later closed-window composition settled the
> provisioning authority: main provisions a sibling `<userData>-native-replacement`
> namespace at the first packaged Mac launch, before any producer, and leaves the
> former `userData/native-replacement` root closed. Decision 4 below is answered the
> same way. Its failure modes, re-anchoring and the confirmed reset are in
> [the Mac startup gate](mac-closed-window-fixed-path.md#the-mac-startup-gate).

## Decisions reported before capture/restore coding

The requested remaining implementation requires an explicit topology/security contract:

1. May every app-owned protected root and its matching signed app move into immutable
   generations selected by one trusted native supervisor before any writer starts?
   This changes live paths. Alternatively, must current paths remain fixed? Fixed
   paths across arbitrary volumes do not currently have an atomic complete-pair
   selection implementation; automatic restore must stay unavailable until one exists.
2. Keychain and TCC are system-owned state, outside these app directories. May they
   remain in place, with exact continuity verified and selection refused on any loss?
   This is not a Keychain/TCC export/restore contract. No key, intent journal or native
   permission database may be reset, regenerated or silently bypassed.
3. What approved launch/isolation authority excludes older or unmanaged writers from
   every configured root? A cooperative lock works only for participating binaries.
   A process inventory, PID disappearance, FSEvents or content digest cannot prove
   the absence of all writes, including write-and-revert or migration activity.
4. Who may provision the first recovery namespace, and what durable authority lets
   bootstrap distinguish an authorized initial empty namespace from lost/replaced
   recovery identity? Existing paths/keys cannot be treated as disposable defaults.

These decisions are unresolved in this slice. The topology/Keychain choice was
surfaced for clarification before coding around it; no response was available at
publication. No all-writer owner, ledger, full-state capture, continuity certificate,
complete-pair restore or native closed child is fabricated to fill that gap.

Once decided, the ledger must live outside replaceable generations, bind the complete
configured root/launch set and increment durably before every authorized mutation,
including startup, migration and writes later reverted. Unknown write acknowledgement
must poison no-newer-write proof. Copies must preserve complete content, topology,
keys, access controls and matching verified signed binary; both generations remain
intact on any uncertain copy/selection. Existing `MacReplacementRecovery` equality
checks remain necessary, and their synthetic tests are not producer proof.

## Immediate contract with the same-boot owner

Task `task01a11ec6-a426-7060-841a-484a08bee018` retains first-run ownership and
reconciliation. No journal/first-run file from that task is edited or replaced here.
Its integration must consult **the same** replacement closure before Save, Bind,
reconciliation or child startup; all authorized protected mutations must enter the
same all-write authority once that authority is approved/implemented. It must refuse
if replacement ownership or ledger accounting cannot be established. The pinned main
patch already uses the existing first-run `held`/caller-check hooks; it introduces
no competing first-run owner, receipt, reboot rule or fencing journal. The shared
integrator must reconcile those hooks with the same-boot task's exact accepted head.

## Focused evidence

The focused four-file run has **45 passing cases, zero skips**, including 16 cases
in the new native storage file (14 actual Node-API/backend cases and two bootstrap/
unsupported-platform cases). The other three files cover existing replacement
commit/recovery policy and diagnostics native storage. Test state, synthetic wrapped
keys, compiled addon and crash processes are disposable temporary resources.

The native cases compile this exact `storage.c` with Node-API 8 and verified local
Node 24.19.0 headers, then use `createHandleRelativeStorage`, `MacReplacementJournal`
and the concrete startup owner. They exercise an encrypted envelope larger than the
old 4 KiB limit, fresh closed bootstrap, competing handles/processes, SIGKILL after
temp flush or after rename, lost pre/post-rename acknowledgement, corrupt envelope/
wrapped key, unsafe permissions, hard links/symlinks, root substitution, missing-root
refusal, capability/namespace rejection and the 40 KiB bound. Positive pair digests
in these records are explicitly synthetic; the tests prove journal behavior only.

The pinned patch applies to its exact base. In a disposable applied tree, **three
selected main IPC cases pass**: the two new bootstrap-closure regressions and the
existing Mac window lease case. Thirteen other cases were excluded by name selection.
The new cases use a synthetic closed bootstrap with actual main/Workspace/IPC;
they prove consumer composition, not native writer capture. Root no-emit TypeScript,
changed-file ESLint/Prettier and applied-patch TypeScript/ESLint/Prettier pass.

Native test invocation (explicit local header path; no automatic download/install):

```sh
ORCA_REPLACEMENT_NATIVE_TEST_HEADERS=/absolute/verified/include/node \
  node_modules/.bin/vitest run packages/app/test/mac-replacement-native-storage.test.ts \
  packages/app/test/diagnostics-native-storage.test.ts \
  packages/app/test/mac-replacement-commit.test.ts \
  packages/app/test/mac-replacement-recovery.test.ts --maxWorkers 2
```

The local run used Node 24.19.0, Vitest 5.0.2 and TypeScript 7.0.2. Official Node
24.19.0 headers were downloaded into `/tmp` and checked against the published
SHA-256 (`54f14a297d47ea0794fe272363703d9dc419c96ac68f20d890f98b63754a3e4c`).
Dependency manifests, lockfile, coverage and workflows are unchanged. No broad suite,
Actions dispatch, merge, live host/access change, activation or release was performed.

Actual Darwin compilation/loading, signed N-to-N+1 execution, power-loss durability,
ACL/xattr preservation, Keychain/TCC continuity and physical fault/recovery acceptance
remain explicit Mac validation. The requested capture/ledger/full-pair/closed-child
producers and parent #571/#387 acceptance remain open.
