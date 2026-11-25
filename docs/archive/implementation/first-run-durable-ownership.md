# First-run durable startup protection — 8 October

This bounded protective slice stacks on exact #567
`40f2ae8a05491884ce1ac8ac5c5d54721c3b6a20`. It preserves all constituent commits
and branches. It closes loss of the first-run startup/cleanup reservation on app
restart. **It does not implement complete first-run recovery.**

## Executable ownership boundary

`packages/app/src/main/first-run/ownership.ts` owns one store-local journal,
`.orca-first-run-ownership/`, and an immutable sibling anchor,
`.orca-first-run-ownership.json`. Store-local placement also fences different
app profiles selecting the same canonical workspace. Workspace reserves before
calling the existing startup API. Exclusive numbered attempt-directory creation
arbitrates competing app processes; no stale-PID lock breaking is used.

The anchor binds the workspace and journal's canonical path, device, inode and
current OS owner. Every immutable claim binds that workspace, exact prepared
config digest, random reservation ID and previous claim digest. Subsequent records
retain the returned direct-child PID and authenticated workspace/instance identity.
No credentials, request text or provider configuration enter this journal.
Files use exclusive no-follow creation, file fsync and parent-directory fsync;
directories are synced after creation. Unsupported or uncertain filesystem
observations refuse startup. Existing setup directory/receipt validation,
captured authentication, hello/discovery and synchronous final activation remain
authoritative. The app imports no store/engine implementation (ADR 0008).

A matching `terminal.json` is written only while this app still holds the exact
returned BundledDaemon object and its `exited` contract positively observes
direct-child terminal fields. It binds the exact reservation, child-record digest
and optional authenticated-identity digest. Ordinary stop return, timeout, error,
callback arguments, hello identity or PID existence/absence cannot settle ownership.
Terminal means only that this direct child ended; it is not proof of code-zero
clean close, drained work, updater safety, protected-state rollback or installation.

A subsequent reservation verifies the retained chain and all terminal bindings.
Missing/altered/torn/unknown files, mismatched roots/config/identity/digests,
symlinks, hardlinks, special files, wrong owner/device and unknown prior ownership
refuse. An absent journal with a retained anchor also refuses; an absent anchor with
a retained journal refuses. A pre-ledger `.orca` or `auth` tree cannot be silently
migrated or adopted. Each file read is limited to 4096 bytes and startup inspection
to 512 journal entries.

### Compaction of settled history

Every launch, reconnect and failed start adds an attempt, so the journal is compacted
rather than capped (the former 256-attempt limit stopped the workspace after about
255 launches). Once more than 64 attempts follow the last checkpoint, the reservation
that has just written its claim folds every settled attempt except the 16 newest into
`checkpoint-NNNNNN.json`. The checkpoint binds the workspace and anchor digest, the last
folded attempt number, that attempt's claim digest (the head of the `previous` chain),
the effective config digest after its rebinds, whether any folded attempt was settled
by explicit recovery, and the reservation that wrote it. The next retained claim must
chain to that head and config, and the writing reservation's attempt must still follow
it, so a rewritten or removed checkpoint, or a removed retained tail, refuses.

Compaction runs only while that reservation holds the journal's append position: its
exclusively created attempt directory, the same arbitration every claim uses. Strict
inspection has just shown every earlier attempt settled, and its own unsettled attempt
is never folded; a journal with any other unsettled attempt refuses before reaching
compaction. The kernel lifetime fence is not taken: the daemon this reservation is about
to start must acquire it, and no writer can re-enter a settled attempt. The checkpoint
is written as `.pending`, fsynced and renamed into place whole. Folded attempts are then
renamed to `discarded-NNNNNN` oldest first and removed, and superseded checkpoints are
unlinked. Every intermediate state verifies: folded attempts still present are checked
record by record and must end exactly on the checkpoint head, and the next reservation
finishes an interrupted compaction. A compaction failure never blocks startup. The CLI
continuation fence and the bootstrap/closed-inspection admissions read checkpoints too,
so folding a reconciled attempt still keeps retained continuations parked. On Windows the
native writer admits only the `checkpoint-NNNNNN.pending` name for this.

Repeated Connect and parked-child reuse validate their retained reservation.
Ordinary owned cleanup and spontaneous observed exit record terminal evidence.
First-run reservation failures leave the previous target/stream intact. Legacy
environment/default and read-only starts cannot bypass first-run evidence; their
ownership refusal cannot fall back to a default endpoint. No selection, no bundle
or an explicit remote target creates no first-run reservation or child.

## Ordinary crash/relaunch and the actual recovery route

If an app crashes before persisting terminal evidence, relaunch remains blocked,
**even if its child subsequently exits cleanly**. Likewise, interruption after
claim creation but before a startup result leaves ownership uncertain. The
inherited startup API does not return its child object on failure, so that failure
cannot currently be settled by this adapter. A lost owner's surviving daemon is
never adopted, probed by guessed endpoint or signalled by PID.

The route currently exposed through first-run IPC is an explicit ownership
reconciliation refusal. Preserve the selected workspace, config/auth/store and
both ownership evidence locations. Retrying/restarting cannot clear it. No
supported app/CLI command currently reconciles an orphan first-run reservation;
deleting evidence or resetting credentials/state is not a recovery recipe.
Existing protected-intent inspect/reconcile/abandon routes reconcile intents, not
daemon ownership. Run leases fence individual interpreters and their existing
expiry/reattach semantics do not establish daemon exit or complete store quiescence.
Authenticated workspace/instance/PID observations identify a live endpoint but
cannot prove an old endpoint stopped. No lease, daemon or runtime contract is changed.

The supported same-store startup route is verification of the intact anchor,
claims, child/identity records and matching terminal records written by a surviving
direct-child owner. Without that evidence, an operator/product recovery decision
is required. For independent new work, native selection may explicitly prepare a
different empty app workspace; the old store and parked work remain preserved.
That is a new workspace, not recovery or continuation of the old one.

The smallest concrete future authority choices for root/product review are:

1. **Supervised terminal evidence:** a trusted lifetime owner that survives app
   loss records exact reservation, process-birth/daemon-boot and store identity
   plus an observed terminal result. Replacement startup verifies that evidence
   and store exclusivity before reserving. This can make ordinary crash/relaunch
   recoverable without an operator, but requires a native supervision/attestation
   producer and physical tests; no such first-run producer is supplied here.
2. **Explicit operator reconciliation:** preserve the uncertain generation and
   append an authorized resolution only after an independent trusted authority
   establishes the old writer cannot write and the exact store remains fenced.
   Existing daemon/store identities should bind that resolution. This avoids
   daemon adoption and resets but requires a reviewed authority, quiescence proof
   and an operator surface. PID disappearance, a timeout, a stale lease or a
   successful hello alone are insufficient. If that proof is unavailable, the
   existing store remains unavailable for startup.

Neither choice authorizes binary rollback, discarding newer state, replaying
parked work or reopening updater admissions. The decision is about who can
attest/authorize ownership settlement after losing the app, not a generic
recovery framework. No recovery policy or product approval is inferred here.

## Portable evidence and remaining gates

Available Node is **24.19.0**, matching #567's author environment and differing
from requested **24.21.0**. Available pnpm is **11.19.0**, differing from manifest
**12.4.2**. Pinned binaries were not found. Installed direct test/static binaries
are used without pnpm invocation, dependency installation or manifest/lockfile
changes. No applicable repository `.agents/skills` entry was present.

Focused checks cover real temporary evidence files, interrupted startup/cleanup,
app recreation/lost exit observation, repeated actions, stale/tampered/missing
records, transplanted/wrong identity, competing/parked owners and safe no-work
paths. The existing real compiled CLI-child test now also proves a competing app
cannot start while the child lives, then recreates Workspace and authenticates a
new owned child after observed ordinary termination. Its version marker and
subscriptions remain fixture boundaries; it is not a packaged/native crash test.
IPC tests verify the safe reconciliation refusal is returned without raw errors.

- Eight-file selection before final legacy-path hardening: **125 passed, 1 inherited Windows-only ownership
  assertion skipped**, `vitest run --maxWorkers=2`, 15.21 seconds. Files: app
  `first-run-ownership`, `first-run-workspace`, `first-run`, `workspace`,
  `daemon-connection-integration`, `daemon-connection-preload`,
  `native-lifecycle-integration` and `daemon-process` tests. A later narrow
  ownership/Workspace regression selection passes **47 tests in 2 files** and
  verifies the lint-driven Error normalization on the promise rejection path.
  Final legacy nested-cwd/store-alias hardening then passes **58 tests in 3 files**
  (`first-run-ownership`, `first-run-workspace`, `workspace`) in 3.41 seconds;
  the real CLI-child recreation case runs again in that final selection.
- Changed-code ESLint and Prettier, root `tsc -p tsconfig.json --noEmit`,
  documentation text/local follow-up link checks and `git diff --check` pass.
  No broad suite or coverage is implied.
- Self-review closed the legacy ownership-refusal fallback, retained the existing
  Promise rejection API and ensured a corrupted reused reservation never stops
  the already active/parked child during connection preparation.

Native Mac/Windows filesystem ownership, permissions and crash/power-loss durability
remain physical gates. POSIX fsync return and bounded path observations are portable
evidence, not native full-flush or immutable handle-relative protection against
concurrent mutation by the same OS principal. Hash bindings detect inconsistent
evidence; they are not authenticity against that principal rewriting a coherent
chain. Deliberately removing every evidence copy before any runtime tree exists
is outside this path-based observation boundary. Windows ownership remains blocked
under the inherited current-user observation contract. No native storage addon
or production activation is added.

Picker/Finder PATH/Git/tool/architecture, Keychain/DPAPI/secure-storage restart,
packaged/signed/downloaded images, native privacy and #386/#390 physical acceptance,
real-agent config persistence/rebind, #420 coding evidence, #416 diagnostics,
complete protected-state rollback and replacement admission remain separate gates.
Production updater/native capture stay disabled. #568 drain/runtime work at
`a9412a00101a0ec6a3951c373c20df959687c694` is not merged or modified; app approval/token
wiring has a separate owner. No full suite/coverage, workflow dispatch, installation,
merge, release, host deployment, new access/credentials or provider operation occurs.
Root owns independent review and exact-head CI.

## Same-boot successor

New fenced generations have an explicit same-boot route in
[first-run-same-boot-recovery.md](first-run-same-boot-recovery.md). Legacy uncertain
claims described above remain preserved/refused without independent lifetime authority.
The reboot prerequisite in #577 was rejected and is not part of that successor.

An attempt left unsettled by an earlier boot of the same host is the second authority
choice above, made explicit. By the owner's 14 October 2026 decision, a person confirms
that the previous session ended. A free kernel fence and the same store evidence must
back the confirmation, and it is never automatic or a restart prerequisite. See
[After a restart](first-run-same-boot-recovery.md#after-a-restart-person-confirmed-end).
