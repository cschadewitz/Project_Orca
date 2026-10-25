# Closed-window fixed-path recovery — #387 / #571

This non-Mac source slice starts from combined [#584](https://github.com/cschadewitz/Project_Orca/pull/584)
`a991fbfea9da6d39dea2f0c513cc5a000d993c14` and merges the actual native journal
producer [#581](https://github.com/cschadewitz/Project_Orca/pull/581)
`50c75cf051aadb551b5e365b1acf0110b70853fc`, whose parent is #580
`b45b2a0d7df15798e6ba985d71f6e9d507d9cee4`. It retains their constituent evidence.
Author and committer: Calcifer Schadewitz `<schadewitzcalcifer@gmail.com>`.

## Invariant and scope

Exact approval durably closes admission before the existing runtime drain begins.
Existing participating writers retain their lifetime kernel ownership while natural
work finishes. Main freezes new dispatch, awaits already dispatched writes, stops
background producers and waits for actual storage settlement before releasing its
writer slots. The supervisor obtains **all** slots for **every** enrolled root before
copying or restoring. Timeout, lost acknowledgement and process recreation do not
reopen admission. Reopening requires accepted validation or verified full restoration.

The live app/config/store paths and their root inodes stay fixed. Recovery copies live
in a private external control namespace, not a versioned live state directory.
Migration writes may be undone inside the same continuously closed attempt because
ordinary work has not been admitted since its complete previous pair was captured.
An independent all-write ledger or immutable live generations is not assumed necessary.
Once admission reopens, automatic restoration from that attempt is categorically refused.
#566 remains compatibility planning; this does not implement its proposed live topology.

The actual unresolved decision is the **writer authority boundary**. These fences cover
participating managed app/CLI/daemon processes and refuse unknown roots, unsupported
volumes, aliases, changed enrollment, uncertified replacement plugins and exhausted
slots. They cannot exclude an arbitrary older binary or another program that ignores
the fence and has filesystem access. Alternatives are:

1. Approve the participating managed launch set as the supported boundary and refuse
   unsupported writers/roots before enabling replacement.
2. Require exclusion of arbitrary unmanaged writers; activation then stays blocked
   pending separately authorized OS isolation/launch authority.

The source is conservative under either choice. No OS access, permission changes,
secrets or production enablement have been added to manufacture that authority.

## Implemented producers

- `@orca/protocol/update-window` supplies private durable enrollment, per-root inode
  anchors and closed-window states. Eight exclusive loopback kernel slots per root
  bind the filesystem identity and host/kernel domain. Collisions refuse; no random
  alternate lock, PID adoption or stale-lock deletion exists. A fresh same-boot owner
  must capture every slot. A surviving child independently keeps recovery blocked.
- Initial namespace provisioning is explicit and descriptor verified, separate from
  opening a journal. Every record is written to a temporary name, flushed and renamed;
  `window.json` is published before root anchors and enrollment is published last.
  Until enrollment is published nothing can have used the window, so an interrupted
  first provisioning is repeated. Lost control behind a surviving anchor, a missing
  established journal, an unreadable published window and every phase but `open` refuse.
  Changed identities and torn records of an open window that no attempt holds are
  re-anchored at startup instead ([the Mac startup gate](#the-mac-startup-gate)).
  Darwin durable control writes require the packaged native `F_FULLFSYNC` adapter.
- `MacUpdateApplication` optionally binds exact approval to that durable close. Defer
  can reopen only the original in-process untouched approval after preparation settles.
  A durable stopping marker is written before shutdown; defer cannot cross it. Fresh
  owners cannot infer that an interrupted preparation was safely deferred.
- `MacAppWriterBarrier` seals main dispatch synchronously and awaits dispatched work,
  background settlement and the final lifetime-writer release. It cannot reopen itself.
- CLI entrypoints fence configured config/store ancestors before writer initialization.
  Closed replacement accepts only authenticated `serve --read-only --no-resume` with
  the one-use main capability. It omits controls, agent ping and automatic continuation
  recovery, retains the existing local credential and refuses plugin initialization.
- Closed first-run inspection acquires both actual kernel fences and verifies existing
  same-boot claim/writer/config identities. It creates no new claim, adopts no PID,
  writes no new writer generation and replays no work.
- `MacFixedPathRecovery` requires actual signature/whole-image and OS continuity ports.
  It verifies every complete state root and matching binary before committing the
  previous-pair receipt. Before restoration it separately preserves and verifies the
  complete current failed candidate pair, then durably records restore intent. Each
  verified restored tree gets an append-only receipt. Fresh same-boot recovery resumes
  from preserved copies without recapturing partially restored live data. Both complete
  pairs survive restoration. Final binary/state/continuity verification keeps the
  result closed until the owner explicitly reopens.
  A broken candidate is preserved with an explicit `binaryVerified: false` receipt;
  this is byte-preservation evidence, never executable/signature acceptance. Only the
  previous matching binary is signature-accepted and eligible for restored execution.
- Native copy/restore uses held descriptor-relative traversal, pre-mutation inode
  bindings and no-follow opens. Restore preserves each live root inode and update anchor.
  It preserves regular bytes, uid/gid/modes/file mtimes and supported ACL/xattr metadata.
  Internal relative symlinks are supported; external links, hardlinks, special files,
  unsafe owners and set-id entries refuse. Bounds are 1 GiB per tree/file, 65,536 entries
  and depth 64. Unsupported or oversized stores/binaries refuse before replacement.
- The existing native installer handoff receives a concrete closed-window commit owner.
  It consumes the same exact approval, observes natural owned daemon shutdown, pauses
  app writers, captures all slots and verifies the backup before permitting installation.
  It durably retains bounded public candidate/startup identity; that is recovery identity,
  never renewed consent to install.
- Replacement validation uses the existing whole-image/hello/store verifier and an
  independently owned read-only child. Exactly one migration slot per root is released
  after the one-use launch capability is durable. The supervisor retains the other slots.
  Copy/restore/reopen are unavailable while the child lives. Accepted verification plus
  an observed clean child exit and recapture of all slots can mark validated-closed.

### The Mac startup gate

`createManagedMacReplacementStartup` begins closed before producers. It combines the
native journal with the enrolled app writer and checks durable admission for every new
main dispatch. An established closed attempt produces a recovery shell. The former
`userData/native-replacement` namespace is retained and refused: its encrypted AAD binds
the original path, so silently moving or ignoring it would lose recovery authority.

**Packaged apps only.** Main mounts the gate only when `app.isPackaged` on macOS. The
updater only ever replaces a packaged app, and the `diagnostics_storage` addon with
replacement storage that the gate needs is staged only into a packaged app's resources
(`mac.extraResources`). Unpackaged Electron — `pnpm --filter @orca/app dev` and the macOS
legs of `app-smoke.yml` — starts the way Linux and Windows do: no namespace, no gate, and
no managed enrollment for the daemon it starts. Developers and CI need no staged addon.

**Main provisions at the first launch.** On the first packaged launch, before any
producer, the gate provisions `<userData>-native-replacement` (`journal/`, `window.json`,
`enrolled.json`) and the `.orca-update-window.json` guard in userData, inspects the
journal and takes the app's writer slot. Workspace, config and store roots are enrolled
before their first producer (first-run setup, the managed daemon). Any of these opens
the recovery shell for that launch, and the next launch tries again:

- the packaged addon is missing, stale or lacks replacement storage;
- userData is not on an internal APFS volume, or `diskutil`/`ioreg` exceed their 2 s bound;
- another process holds one of the root's loopback writer slots (a running `orca` command
  or daemon), or an unrelated listener holds one of their ports;
- the updater journal cannot be read: the Keychain is unavailable or slower than 5 s.

**Re-anchoring.** A directory's recorded identity is its path, device, inode and owner.
Migration Assistant, a Time Machine restore, a renamed home folder or a moved or deleted
workspace changes it, and a crash can tear provisioning or an enrollment. When the
published `window.json` is `open` with no attempt and the journal holds no record,
startup re-anchors instead of refusing (`reanchorUpdateWindow`):

- It holds the control mutex and every slot of every old and new root identity, so no
  participating writer anchored to an old identity survives the change.
- userData's guard is rewritten, or recreated, for its current identity. A workspace root
  whose directory is gone, whose guard was removed (writers there went unfenced) or which
  another namespace now anchors is de-enrolled. One whose guard is this window's, or torn,
  is re-anchored.
- Temporary records are discarded: `ClosedUpdateWindow` never acts on a state it failed
  to publish, so the published `window.json` is the only authority on an attempt.
- `window.json`, the guards and finally `enrolled.json` are republished with the current
  control identity. The window id is kept.

A workspace moved elsewhere keeps its guard and refuses participating writers, the
`orca` CLI included, until it is enrolled again. Opening it in the app does that: the
managed daemon's enrollment replaces a guard that names this window or this control path.

Re-anchoring refuses, and the recovery shell stays, for any phase but `open` or a
recorded attempt; a journal record (its AAD binds the original journal path, and it may
be an attempt); the former `userData/native-replacement` namespace; userData anchored by
another namespace; a copy of the namespace whose original control path still exists; and
a busy slot.

**A confirmed reset.** When the published window is unreadable, or gone behind a
surviving userData guard (the control folder was deleted, or userData was restored
without it), and the journal holds no record, nothing can be re-anchored and nothing
proves an attempt is not in flight. The recovery shell then offers **Reset and restart**,
with **Keep** as the default. A confirmed reset holds the slots, removes userData's guard
and the control's window and enrollment records, keeps the journal, pairs and workspace
guards, and relaunches; that launch provisions as on a first launch. A previously
enrolled workspace keeps a guard naming this control path, which is replaced when it is
enrolled again. A readable window, and so any recorded attempt, is never offered a reset.

## Integration-owner handoff

[571-closed-window-bootstrap-584.patch](patches/571-closed-window-bootstrap-584.patch)
is unapplied and pinned to the exact #584 main and IPC regression blobs above. Apply
after this source constituent. Shared main/preload/Workspace files remain owned by
the integration owner. The patch mounts a private sibling control namespace, closes
protected dispatch before inspection and supplies an app-write pause/drain hook.
It preserves #584's same-boot first-run reservation gates. Main's update application
remains sessionless until all actual production ports are bound.

The exact input blobs are main `c9a4143a02e8cdb340840948571f3ed806978c29` and IPC
regression `0f2142c59a01e2c8a62ad388434b0753d9c13a87`. `git apply --check` passes
against the source branch's unchanged #584 files. In a disposable detached worktree,
the applied patch passed **18 actual-main IPC tests**, typecheck and scoped ESLint.
The symlinked workspace lint package needed only its `tsconfigRootDir` rebound to
that worktree; no lint rules were disabled. The patch is supplied as a file, not
applied to the integration owner's shared checkout.

The startup patch enrolls **only the app root** for its disabled bootstrap slice. Before
enabling updates, the integration owner must supply the complete trusted configured
config/store root set before their producers start, reject overlapping roots, and bind:

1. The native catalog/candidate session and `MacUpdateApplication(session, window)`
   using the same `createNativeClosedUpdateWindow` and exact approved target.
2. `MacClosedWindowCommit` as the existing native handoff's commit owner, with the real
   target authorization and pause hook; the packaged native tree port and whole-image
   signature/publisher/manifest/daemon verification; read-only existing Keychain,
   intent-journal and TCC continuity inspection.
3. The native supervisor's owned `startClosed`, including actual child image identity,
   bounded credential handshake and one-use launch capability. On unknown startup,
   retain closure and obtain all slots before inspecting/resuming preserved-pair recovery.
   Never retry installation from persisted metadata or start ordinary serve as fallback.

These are explicit owner/native acceptance ports, not permissive production defaults.
There is no automatic install, recovery fallback, permission reset or credential migration.
The older ledger-based recovery class remains conservative and unchanged; the new
handoff must use this fixed-path owner rather than pretending its old ledger is present.

## Focused evidence and limits

The reproducible focused command uses the installed Node 24.19.0, Vitest 5.0.2 and
TypeScript 7.0.2. Native conformance uses official Node 24.19.0 headers whose archive
SHA-256 is `54f14a297d47ea0794fe272363703d9dc419c96ac68f20d890f98b63754a3e4c`.
Set `ORCA_REPLACEMENT_NATIVE_TEST_HEADERS` to its `include/node` directory and run:

The final run passed **100 tests in 10 files, zero skips**, in 19.22 seconds on Linux.
Root typecheck, scoped ESLint and formatting checks also passed. The applied main patch
has its separate 18-test evidence above; those tests are not counted twice here.

```sh
node_modules/.bin/vitest run \
  packages/protocol/test/update-window.test.ts \
  packages/cli/test/update-bootstrap.test.ts \
  packages/app/test/mac-app-writer-barrier.test.ts \
  packages/app/test/mac-update-application.test.ts \
  packages/app/test/mac-fixed-path-recovery.test.ts \
  packages/app/test/mac-fixed-path-native.test.ts \
  packages/app/test/mac-replacement-native-storage.test.ts \
  packages/app/test/mac-replacement-recovery.test.ts \
  packages/app/test/mac-replacement-commit.test.ts \
  packages/app/test/diagnostics-native-storage.test.ts --maxWorkers=1
```

Evidence includes real participating child survival after supervisor loss, authenticated
CLI startup under a same-boot first-run claim, native descriptor copy/restore, inode and
xattr preservation, substitution refusal, lost-response fencing, and an actual test
child killed after native restore cleared live contents. A fresh same-boot owner restores
the full preserved pair. `ORCA_PAIR_FAULTS` exists only in the disposable test build.
Ordinary packaged native compilation does not enable that fault gate.

Fixture signature/continuity callbacks are explicitly synthetic. Linux syscall evidence
does not prove Darwin compilation, native loading, signed application identity, OS
continuity or power-loss durability. Reuse valid #584/#581 constituent checks without
calling them physical acceptance for this new path. Scoped typecheck, lint, formatting,
author diff review and the separately applied IPC patch checks accompany the focused run.

Author review specifically corrected approval/defer versus shutdown ordering, immediate
diagnostics opt-out semantics, tracking of control receipts as dispatched work, retaining
slots until actual settlement, exact failed-candidate identity, and preservation of broken
candidate bytes without inventing signature acceptance. Fixed-path restore and native
fault tests were rerun after those changes.

## Remaining real-Mac gates

- Rebuild/load/stage the revised Darwin native addon under the actual signed package;
  verify internal APFS traversal, ACL/xattrs, symlink metadata, `F_FULLFSYNC`, directory
  flushes, power-loss/lost-ack recovery and whole application/bundled-daemon matching.
- Verify existing Keychain/safeStorage, encrypted intent-journal and TCC continuity
  without reset, migration or fresh permission prompts. Exercise legacy-namespace
  refusal and initial enrollment on the actual supported launch/root set.
- Exercise the real native candidate supervisor: natural drain, main producer pause,
  failed migration/startup, independently surviving child, clean-exit recapture and
  same-boot matched binary/state restore, retaining both pairs and the closed window.
- Existing M10/M21 signed-package, OS integration and physical smoke gates retained
  from #584 are still unrun here. Actual signing, deployment, merge and manual CI
  dispatch are outside this authorized task.

This source/test handoff does not claim milestone release completion or production
acceptance. The authority decision and integration/native gates must be resolved before
activation; no independent ledger or new live-directory topology is asserted as required.
