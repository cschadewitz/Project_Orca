# Disabled native packaging and replacement wiring — 9 October 2026

This bounded dependent slice composes [#574](https://github.com/cschadewitz/Project_Orca/pull/574)
native resource packaging and [#576](https://github.com/cschadewitz/Project_Orca/pull/576)
updater drain/replacement recovery over the accepted [#572](https://github.com/cschadewitz/Project_Orca/pull/572)
baseline. It applies the updater owner's shared-entrypoint patch. It does not enable the
updater, diagnostic capture, protected-state restore or a new first-run recovery route.

## Preserved heads and owned delta

| Constituent | Exact preserved head |
| --- | --- |
| #572 accepted baseline | `db9bdc6c5fe086b905a702dd44fe5dc0ff2313aa` |
| #574 native diagnostics packaging | `455b1e05f3e3a83175678e8a90f181e30244f966` |
| #576 updater/replacement recovery | `4ee92586e6ad94b8473ae5e74bff277632b8651b` |

Branch: `calcifer/m10-m21-m22-app-native-recovery-integration`, dependent on
`calcifer/m10-m21-m22-app-consolidation`. The base branch stays at `db9bdc6c`; no
base push or documentation-only refresh interrupts its CI.

Two clean non-squash merges preserve the supplied commits:

- `bb1fa1adf4c11732a192ae2bfcc20c3663297ef0`: #574 into #572.
- `ee8d437f6efbbfb85a2443b355c8dfdef26c9bb5`: #576 into that result.

All 13 #574 changed blobs and all 20 #576 implementation-commit changed blobs remain exact.
The additional integration delta is main/Workspace wiring, three wiring tests, this handoff
and a changelog fragment. Author and committer are Calcifer Schadewitz
`<schadewitzcalcifer@gmail.com>`. Preload, bridge, dependency lockfile, CI workflow and
coverage thresholds are unchanged. #572's owner-authorized 95% app function threshold
remains resolved; the older #576 handoff's coverage-policy wording does not reopen it.

## Wiring and self-review corrections

The [supplied patch](patches/571-shared-wiring.patch) was pinned to #572 `f4ca6540`.
Accepted `db9bdc6c` differs only in documentation, so the patch applies cleanly after
composition. Workspace exposes captured runtime-drain-v1 `drain`/`defer`, retains the
exact authenticated workspace/instance/PID and token, and passes the same owner through
held proof, final freeze, runtime-v1 preparation and owned stop. Existing completion IPC
remains usable while draining. Main injects capture into `MacUpdateGuards`; no new preload
API or renderer action is introduced. Ordinary quit does not call the ordinary stop path
for an updater-reserved daemon.

Self-review found and corrected two shared-patch issues:

1. A closed `WorkspaceDeps.updateBootstrap` input guarded ordinary/first-run startup but
   omitted `prepareConnection()`, which could stage another bundled child. The same early
   refusal now covers both bundled and external staged connections. The regression asserts
   no child start, activation or ordinary stop on the closed input.
2. Extracted owner `check`/`release`/`freeze` callbacks lacked `this: void` declarations and
   failed the repository's unbound-method lint rule. The return interface now records their
   closure-based contract. No runtime callback or guard was weakened.

No remaining integration-specific source finding was observed in this bounded review.
`new MacUpdateApplication()` still has no session. `DIAGNOSTICS_PRODUCTION_ENABLED` stays
false. Preparation-only candidate sessions still refuse installation. The bootstrap input
is a tested consumption seam, **not a mounted production journal gate**.

## Focused evidence and reuse

- **37 passed, zero skips**, five files, 8.04 seconds, at most two workers: new Workspace
  wiring, existing owned-stop lifecycle, diagnostics resource loading, disabled startup
  observation and actual installed builder hook/resource-copy fixtures. The three new wiring
  cases cover parked-work completion before freeze/release, no forced ordinary-quit stop,
  and closed bootstrap refusal before any Workspace child start.
- **2 additional passed**, two files, 2.64 seconds, with 23 cases excluded by selection:
  actual main IPC keeps Mac installation unavailable; the disposable authenticated compiled
  CLI child still supports exact config/store/PID, rival refusal and positively terminated
  durable first-run reuse. Total **39 distinct selected cases** across seven files.
- Root and renderer no-emit TypeScript, changed main/Workspace/test ESLint and Prettier,
  constituent ancestry/blob comparisons and diff whitespace checks pass. Scoped handoff
  UTF-8/LF/newline/fences/local-link checks accompany publication.
- Reuse #574's author tests/native packaging review for its unchanged 13 blobs, and #576's
  294 author cases plus existing #568 drain evidence for its unchanged 20 implementation
  blobs. This owner did not repeat those suites. #567 CI
  [37872268414](https://github.com/cschadewitz/Project_Orca/actions/runs/37872268414)
  remains baseline-only evidence, as detailed in [#572's handoff](shared-app-consolidation.md).
  Neither reused evidence nor these selected tests is combined-head CI or native acceptance.

Installed Node 24.19.0, Vitest 5.0.2 and TypeScript 7.0.2; no install, dependency update,
coverage rerun, broad suite, manual Actions, signing, live host/credential/access operation,
release or deployment. The parent owns combined CI and PR merges. The new substantive
dependent draft is published once after self-review; #572 is never pushed by this slice.

## Concrete residual implementation tasks

These are missing source producers/compositions, not merely device acceptance gates.
The named consumer files exist; proposed native adapters remain work for the respective
owner. Do not substitute synthetic fixtures, a diagnostics-root lock or runtime inventory
for the missing authority.

| Owner and task | Owned files / consumer boundary | Required source result |
| --- | --- | --- |
| Shared integration: bind durable replacement bootstrap | `packages/app/src/main/index.ts`, `mac-replacement-journal.ts`, `mac-replacement-recovery.ts`, `diagnostics/native-storage.ts`, `diagnostics/native-adapter.ts` | Construct a separate updater-owned native journal and safeStorage key adapter; create `MacReplacementBootstrap` synchronously before preferences/protected-intent/diagnostics producer entry, inject it into Workspace and inspect before normal startup. Missing/corrupt/uncertain journal authority must remain closed. This slice does not mount that journal. |
| Updater/native owner: capture every protected writer | `mac-replacement-commit.ts` (`MacReplacementCommitPorts.acquireWriters`) and `mac-replacement-recovery.ts` (`MacProtectedOwner`); native producer implementation still absent | Obtain exclusive durable ownership of app intents/preferences/diagnostics, daemon, independent CLI/ACP and migration writers across the complete configured root set. Supply actual clean-stop observations, full-pair capture, verification and fresh current observation. Existing runtime drain and one diagnostics-root lease do not cover that set. |
| Updater/native owner: complete write ledger and atomic full-pair restore | `mac-replacement-journal.ts` (`MacProtectedPair.writerEpoch`/`writeRevision`) and `mac-replacement-recovery.ts` (`capture`/`current`/`restorePair`) | Produce the independent ledger for every protected write, including startup/migration and reverted writes; capture full content/topology/access/continuity with its matching signed binary. Implement atomic complete-pair selection while preserving both generations. Digest equality alone cannot authorize rollback. |
| Updater/native supervisor plus daemon owner: durable child bootstrap closure | `mac-replacement-recovery.ts` (`MacReplacementPorts.closeBootstrap`/`verifyClosed`), `mac-update-restart.ts`, `daemon-process.ts`, `packages/cli/src/bootstrap.ts`, `packages/daemon/src/server.ts` | Persist and adopt the exact replacement fence before child bootstrap, migrations, listen or protected producer work. Supply an independently owned closed child to existing restart verification; no ordinary-start fallback, PID adoption, receipt resurrection or automatic relaunch. The app-only optional gate cannot fence independent/native child startup. |
| Delivery owner: stage native resources before packaging | `.github/workflows/desktop.yml`, `packages/app/scripts/diagnostics-native-package.js`, `packages/app/electron-builder.yml` | Provide verified local headers/toolchain and an explicit native build stage for each requested Mac architecture before builder runs; preserve both verification hooks and record signed final candidate identity separately. Current desktop workflow omits staging and intentionally refuses a missing stage. |
| Diagnostics owner: finish producer coverage and responsiveness | `diagnostics/startup-producer.ts`, `recovery-controller.ts`, `pretrigger-buffer.ts`, `snapshot.ts`, `report-validation.ts`, `packages/app/src/main/index.ts` | The enum-only startup producer exists; connection/resource producers and measured complete snapshot/validation responsiveness still require their own implementation/evidence. The active 4 ms correction stays with its existing diagnostics owner and is not merged or duplicated here. Capture stays disabled. |
| Configuration/templates and first-run owners: finish interrupted Save-before-Bind recovery | `packages/app/src/main/first-run/setup.ts`, `first-run/ownership.ts`, `guided-launch-adapter.ts`, shared `index.ts` | Persist/reconcile the reviewed configuration-to-target binding across Save-before-Bind interruption without silently rewriting the pinned receipt or adopting another writer. That interruption remains unbound. #577's reboot/reconcile route is excluded pending Casey's reboot-versus-same-boot decision; no #577 commit/patch is integrated here. |

Actual Darwin compilation/loading, signed downloaded-image identity, Keychain/DPAPI/TCC
continuity, filesystem durability/permissions and physical fault/recovery acceptance follow
those producers. They were not run on this Linux source environment. No M10/M21/M22 or
#386/#388/#390/#416 completion is claimed.
