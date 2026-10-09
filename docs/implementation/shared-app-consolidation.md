# Shared app consolidation — 9 October 2026

This draft baseline preserves the reviewed first-run, native lifecycle and serving-runtime
drain stack for the M10/M21/M22 integration owner. It is a consolidation slice, not milestone
completion or native acceptance. The parent owns merges and Actions. Independent owners
retain configuration/templates, first-run recovery, updater, diagnostics, delivery and
maintenance work; their shared-entrypoint patches are still pending.

## Pinned constituents and ancestry

| Constituent | Exact head | Reused scope |
| --- | --- | --- |
| [#567](https://github.com/cschadewitz/Project_Orca/pull/567) | `9ac19ead4347180e44be6162a41d2d5726b3f929` | First-run main/preload/Workspace composition, guided launch, disabled native diagnostics/updater lifecycle, inherited CI fixes |
| [#569](https://github.com/cschadewitz/Project_Orca/pull/569) | `1a2e003e04beaa2e13cd35115faa6c4234145264` | Durable startup reservation and corrected ownership-refusal propagation |
| [#568](https://github.com/cschadewitz/Project_Orca/pull/568) | `a9412a00101a0ec6a3951c373c20df959687c694` | Serving-runtime drain/defer, admission guards and protocol schemas |

Base main is `db579fb7ac9cfce2e4e6901713088a80602311da`. The branch is
`calcifer/m10-m21-m22-app-consolidation`. Clean, non-squash merges preserve each head:

- `809afc2d25f577ab1cd4efb415fd36b5c0f038cd` merges corrected #569 into final #567.
- `dc0397d19c1452ef103cf17e281a9457e500c8c2` merges reviewed #568 into that result.

Both merges use Calcifer Schadewitz `<schadewitzcalcifer@gmail.com>` as author and
committer. No conflict resolution or synthesized source change was needed. Against #567,
the source/test/historical-handoff delta is exactly #569's 10 changed paths and #568's 13
changed paths; every resulting blob matches its pinned constituent. This document is the
only additional file. Original constituent branches and changelog fragments are retained.
Main, preload and bridge blobs still match final #567; Workspace matches corrected #569.
Dependencies, lockfile, CI workflow and coverage configuration match final #567.

## Narrow shared interfaces for later patches

- First-run: `FirstRunSetup` remains the receipt/directory/authenticated selection owner.
  Main wraps `Workspace.prepareFirstRunConnection(path)` and its synchronous
  `validateActivation(hello)`/`activate(hello)` boundary; `dispose()` settles only the
  owned candidate. `currentFirstRun(path)` validates the retained reservation. Preserve
  `FirstRunOwnershipRefusal` through setup and IPC. `FirstRunOwnership` exposes only
  `check`, `attach`, `verify` and `complete`; it supplies no orphan-recovery authority.
- Updater: the existing `MacUpdateGuards.prepareAdmission(target, token)` and captured
  Workspace adapter currently speak runtime-v1 `prepare`/`resume`. The daemon now also
  accepts strict `drain`/`defer` with `RuntimeDrainResultSchema` and `runtime-drain-v1`.
  Later integration must carry one main-owned token and the exact workspace/instance/PID
  from approved candidate through drain and idle preparation. Existing-work answers and
  continuations must remain available before the full Workspace/draft freeze. An older
  prepare-only API must not substitute for drain proof. See [drain handoff](mac-update-drain.md).
- Diagnostics: retain the existing `createDiagnosticsInitializer` composition, startup
  observer, frame/document/epoch/consent boundaries and bounded quit cleanup. Production
  native capture and Mac updater routing remain disabled.
- Configuration/templates: use the existing guarded guided-launch/configuration routes
  and cross-window draft guard. The current first-run receipt pins prepared asset/config
  bytes; persistence/rebind changes need the independent owner's patch rather than an
  implicit receipt rewrite here. Preload remains `.cts`/CommonJS with type-only workspace
  imports; app workspace imports remain limited to protocol/design.

## Delta review and self-review

1. **Resolved owner-authorized coverage override:** #567 commit
   `9ac19ead4347180e44be6162a41d2d5726b3f929` lowers app Node function coverage from 99 to
   95 at `vitest.config.ts:101`. [Development](../DEVELOPMENT.md#coverage) describes coverage
   as a ratchet. The parent subsequently supplied transcript evidence that Casey explicitly
   authorized lowering only the failing app function threshold to 95 and approved committing
   and pushing that exact change. This explicit owner instruction overrides the repository's
   default policy; the finding is resolved and is not a merge blocker. Other thresholds stay
   unchanged. Green coverage proves the authorized 95 threshold, not the previous 99 threshold.
   This consolidation retains the exact constituent and makes no threshold change.
2. **#569 correction verified:** the outer `FirstRunSetup.exclusive()` wrapper now preserves
   `FirstRunOwnershipRefusal`, including errors from current ownership, preparation,
   handshake and disposal. IPC retains the concrete reconciliation refusal and sanitizes
   ordinary errors. The previously unrun POSIX Connect cases all executed and passed.
3. **Consolidation-specific review:** all three ancestry checks pass; constituent blob
   comparisons, unchanged main/preload/bridge checks, root/renderer typechecks, changed-file
   ESLint/Prettier and whitespace checks pass. No new consolidation-specific source defect
   or merge resolution was found.
   The delegation supplied focused reviews for #569 and #568, with no changes for #568;
   this slice does not represent a second broad review or rerun of those suites.

## Evidence reuse map

| Evidence | Exact scope and result | Limit |
| --- | --- | --- |
| [CI 37872268414](https://github.com/cschadewitz/Project_Orca/actions/runs/37872268414) | #567 head `9ac19ea`; tested synthetic merge `7bf26cb8098b8549731b42f0b9add287b4242427`. Both trees are `b62ba6e2da5abbf374bf24f3f28caee8e09603c6`. Node 22 job `113632858520` and Node 24 job `113632858560` succeeded; each reports 421 test files passed, 3 skipped, 6,306 tests passed, 4 skipped and 1 todo. Both built, ran two mandatory retry cases and compiled smoke; Node 24 also passed statics and coverage. | Baseline evidence only; excludes #568/#569. Coverage used the explicitly authorized 95 app function threshold. No packaged/native acceptance. |
| #569 author evidence and supplied focused review | Pinned corrected `1a2e003`; durable-ownership/Workspace review reused. Correction adds four POSIX Connect cases plus the corrected IPC tests. | The historical PR body pins earlier heads; use the exact head above. No combined-head CI claim. |
| #568 author evidence and supplied focused review | Pinned `a9412a0`; author reports 80 passing tests in 10 files; delegation says focused review required no changes. Exact blobs retained. | Not rerun here. App approval-to-drain wiring is still pending. |
| This owner, merged baseline `dc0397d` | Seven selected cases passed in three files, 1.86 seconds, at most two workers. Four POSIX Connect stages, two IPC cases and one disposable authenticated compiled CLI-child case. Root and renderer no-emit TypeScript passed. | 64 cases excluded by name selection; no full-suite or coverage run. Synthetic subscriptions/Electron boundaries remain. |

The local test command was:

```sh
node node_modules/vitest/vitest.mjs run packages/app/test/first-run.test.ts packages/app/test/first-run-ownership.test.ts packages/app/test/first-run-workspace.test.ts -t 'preserves ownership reconciliation refusal|IPC exposes the safe reconciliation route through the setup wrapper|prepares, authenticates and reopens a real CLI child' --maxWorkers=2 --reporter=verbose --reporter=json --outputFile=/tmp/orca-app-consolidation-focused.json
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p packages/app/renderer/tsconfig.json
```

Node is 24.19.0, installed Vitest is 5.0.2 and TypeScript is 7.0.2. Available pnpm is
11.19.0 rather than pinned 12.4.2; pnpm was not invoked. No dependency installation,
manifest/lockfile update, broad redundant suite, coverage rerun, workflow dispatch,
live activation, release, access change or deployment occurred. Repository AGENTS,
development, architecture and design rules were read; local `.agents`/`.codex` locations
contain no applicable skill beyond environment configuration.

The fixed sample remains JEV-free and agent-free launch smoke. Durable orphan reconciliation,
real-agent configuration persistence/rebind and #420 evidence remain incomplete. Full
protected-state/matching-binary recovery, replacement-admission identity, Keychain/DPAPI
restart, native ownership/durability/privacy, signed packaged delivery and physical
#386/#390/#416 acceptance remain independent gates. Later shared patches and exact combined
CI are parent-coordinated follow-up work, not implied by this draft baseline.
