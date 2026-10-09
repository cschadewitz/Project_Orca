# Local integration candidate self-review - 9 October 2026

The four requested maximal tips are assembled in a separate desktop task worktree
on branch `calcifer/integration-candidate-20261009`. The tested source head is
`d78033e07bdc62fb5cf69bb6746e6807129f4040`. This is source composition and focused
local verification while M21 finishes. M21's final delta is not yet included.
The candidate remains local. Publication and CI require the parent's prerequisite
checkpoint; the parent retains the final merge decision.

The [sanitized receipt](integration-candidate-2026-10-09.json) records exact heads,
ancestry, source hashes, per-file test counts, skips and validation scope. Full
local command logs and Vitest JSON remain in this desktop task's `evidence/`
directory beside the checkout. Evidence has not been uploaded or published.

## Instructions and exact inputs

Read `AGENTS.md`, the toolchain/validation guidance in
[Development](../DEVELOPMENT.md) and the relevant runtime boundaries in
[Architecture](../ARCHITECTURE.md). No `.agents/skills` directory exists in this
checkout or in the tracked main/maximal-tip trees. All candidate-authored commits
use Calcifer Schadewitz `<schadewitzcalcifer@gmail.com>` as author and committer.
Other desktop checkouts, including M21, were not edited.

Read-only GitHub ref checks at the start and before recording this review agreed:

| Input | Exact SHA |
| --- | --- |
| main | `db579fb7ac9cfce2e4e6901713088a80602311da` |
| #599 | `79da801d2d9eb1bb9fac5163aa34a5c3fc76803f` |
| #592 | `f0841c4534034e72c2fdaa9d095592a9dac9f4a2` |
| #565 | `00d464fc4fd9c8d3c6557d35d0e80ffda8a5c1c5` |
| #575 | `a6908d039f829da298d35f162accf5103c22e693` |

`git merge-base --is-ancestor` verifies #584
`6fcd543a368246c2156f86a225072a871c754435` in #599, and #558
`a56692c51eb7b99ca9941772dc71dde847004fd3` and #562
`ec915f4f47ffec87270879c74e9bce1c4cd1bca9` in #565. These contained tips were not
merged separately. All four maximal tips are ancestors of the tested source head.
#577 head `3deeeed4b4a8f3a069263668d76065675425c307` and both commits divergent
from the authorized inputs remain excluded.

The merge sequence is #599, #592, #565, #575. Merge heads are respectively
`65586ab3312292a21e3d90785fc375460ea594ae`,
`9bab3c9f035e49ebb893b53ab21817c9115e840c`,
`285e91f71a18170c5b3d8cd171578e5d453672f1` and
`7d593b06ca2e3c5cf6f78273bd36cda440d7105b`. The early checkpoint was after
#592 at `9bab3c9f...`, with the #565 conflict still open. The parent-thread
message tool could not locate the source thread; the delegated task's final
handoff is the delivery path for this checkpoint and review.

## Conflict resolution and source findings

There was one textual conflict, in
[CLI command composition](../../packages/cli/src/commands/index.ts). #565
extracts the older inline daemon startup into `serveDaemon` to expose the trusted
installed-plugin entrypoint. Taking its older body would drop the composed
closed-update and first-run safeguards. The resolution extracts the complete
current body, then adds only the trusted `installedPluginRelease` bootstrap
option. A read-only comparison proves byte-for-byte source-body equality with
the pre-#565 candidate after accounting for indentation and that one insertion.
It preserves the closed command check, admission/existing-work callbacks,
closed receipt, first-run continuation recovery policy, configuration binding,
revision runtime, continuation services, and shutdown/drain ordering.

[Bootstrap](../../packages/cli/src/bootstrap.ts) merged automatically and was
reviewed semantically. Update and first-run writer ownership are entered before
plugin initialization. Closed replacement still refuses uncertified plugins.
Installed release evidence and an explicit restoration verifier cannot both be
supplied. The same verified identity callback feeds capture and restoration;
the installed entry receives a frozen independently pinned identity, with a
digest-qualified import URL. Saved configuration bytes are checked before the
generation is labelled active. The passing bootstrap/restoration tests include
fresh Node processes, changed-byte module-cache refusal and historical inputs.

#592 contributes its stale-continuation fix and exact-command evidence
disposition beyond the shared ancestry. Its run-ownership-before-fresh-reservation
logic remains in the composed daemon and engine; the focused engine continuation
suite passes. Daemon transport/runtime acceptance has not been rerun here.
#575 merged cleanly. Fixed observer routes and read-only operations remain
bounded; deployment identity and service bindings remain unverified preparation.
No agent-01 or service operation was performed.

[Shipping diagnostics](../../packages/app/src/diagnostics-contract.ts) still sets
`DIAGNOSTICS_PRODUCTION_ENABLED = false`. The
[initializer](../../packages/app/src/main/diagnostics/initialize.ts) has no
production-enablement input. The default controller rejects capture/checkpoint
and export preparation despite persisted consent On; stale handles cannot gain
picker or Save authority. Opt-out revokes before awaits, and shutdown revokes and
settles owned work before writer release. Cleanup grants no collection/export
authority. The new
[IPC regression](../../packages/app/test/diagnostics-shipping-ipc.test.ts)
executes the actual main-process registration block against this default
controller for persisted Off and On, with positive clock and capable storage
ports. It checks that no capture, maintenance, export, publication, picker or
timer dispatch occurs, while opt-out cleanup and clean exit remain available.
These ports and window/event objects are synthetic; this is not Electron or
compiled-native acceptance. The existing actual Windows refusal test also ran.

[Managed Mac updater composition](../../packages/app/src/main/index.ts) still
sets `activationAllowed: () => false`, and supplies no approved catalog/native
authority. App-writer barrier tests verify synchronous sealing and settlement
before lifetime ownership release, including failed background drain. App
product/native source is unchanged from #599. No activation gate or C15 policy
was modified.

The new [trusted serve guard test](../../packages/cli/test/installed-plugin-serve-guards.test.ts)
refuses incomplete closed launch, ordinary writable closed launch and
unauthenticated trusted composition before configuration/protected writes or
server startup. No additional bounded product defect was found in these reviewed
integration boundaries. This is self-review, not independent security approval.

## Executed focused checks

Node 24.19.0 / pnpm 12.4.2, Windows x64. Dependencies were installed with the
frozen lockfile and scripts disabled; no Electron binary or native build ran.
The first offline setup lacked a cached tarball. The successful setup fetched
the missing pinned packages without changing the lockfile. Sandbox Vitest startup
was blocked by `spawn EPERM` before tests; the approved one-worker invocation
completed.

- **158 passed, 0 failed, 2 skipped across 14 files** on the tested source head.
  The receipt lists every file and skipped case. Both skips are the Linux-only
  startup/controller integration cases in `diagnostics-startup-producer.test.ts`.
  The initial pre-regression source run at `7d593b06...` was 151 passed/2 skipped;
  it is superseded by this final focused run.
- Root and renderer `tsc --noEmit` passed on the tested source head.
- Scoped ESLint and Prettier passed for both merge-overlap files and the two new
  test files. A local line-ending formatting warning was corrected without any
  tracked change.
- `git diff --check` and the source/ancestry/gate comparison passed.
- main and all four maximal PR refs were rechecked and remain the SHAs above.

The focused suite covers diagnostics consent/refusal/preload/source producers,
direct shipping IPC, writer-barrier sealing, trusted serve guard refusal,
installed plugin release verification/bootstrap/restoration, engine continuation
admission, and maintenance observer acquisition/projection. It uses one worker
at a time. Test subprocesses exercise disposable source/bootstrap fixtures;
no Electron, live provider, live daemon/service, credential/access mutation or
agent-01 operation was invoked.

## Remaining gates and next validation plan

1. Receive M21's final exact delta through the parent. Verify its #584 ancestry,
   compose only its missing commits, review actual config/template/first-run IPC
   overlaps and rerun the affected focused checks on the resulting head.
2. Coordinate with the parent before heavy builds or Electron. A full combined
   suite, coverage, mandatory no-skip retry cases, compiled daemon/bundle checks,
   and platform/native/UI acceptance remain unrun for this candidate. Existing
   constituent receipts retain their original source pins and limitations; none
   establishes combined validation.
3. C15 remains held on the measured aggregate On managed-memory failures in the
   [corrected C15 record](../preparation/crash-recovery/windows-c15-corrected-followup.md).
   The unchanged limit is 33,554,432 bytes. No tuning, comparison rerun, waiver,
   forced GC, activation or reinterpretation occurred here.
4. Managed Mac updater activation remains held pending approved authority and
   independent/native acceptance. Source composition does not close that gate.
5. The installed-provider exact-command profile remains unsupported/blocked per
   [M10 disposition](../implementation/m10-live-command-evidence-disposition.md).
   Its positive handoff remains stopped when native/bridge/callback/scope evidence
   is absent. Generic ACP callback support is unchanged and does not constitute
   a fail-closed runtime exact-command verifier or positive exact-command proof.
6. Await the parent's prerequisite checkpoint before CI or a consolidated
   main-target PR. No publication, Actions run, merge/auto-merge, deployment,
   force push, destructive cleanup or daemon/service operation occurred.
