# Packaged Apple Silicon acceptance matrix

Preparation for [#403](https://github.com/cschadewitz/Project_Orca/issues/403),
child of [#388](https://github.com/cschadewitz/Project_Orca/issues/388).
Source audited: `7abc2342aa672ee9d2f10d565ca4f8eb546184df` (both HEAD and fetched
`origin/main` on 2026-10-02). **No packaged or physical-Mac checks were executed.**
This directory specifies future tests; it does not implement or accept the parent.

**9 October binding addendum:** the [acceptance runbook](../native-mac-beta-readiness/acceptance-runbook.md)
pins #567's mounted Config setup/Launch work and agent-free
`orca-beta-local-check` v1. That start/set/end sample records a run-variable marker
and terminal success only. It creates no output artifact, gate or permission request;
the MAC-06 report oracle and MAC-07/08 gate/cancel/failure variants still require the
packaged-test owner's fixtures. A prepared `first-run/result.json` is not a run output.
#569 protection does not implement #570 orphan recovery. All native/physical rows
remain not run or blocked. Baseline statements below are historical source observations.

Start with this matrix, then read [harness design](harness-design.md),
[fixture contracts](fixture-contracts.md), [manual checklist](manual-checklist.md),
[evidence template](evidence-template.md) and [implementation handoff](implementation-handoff.md).

## Baseline and ownership

At the audited commit:

- `packages/app/electron-builder.yml` builds arm64 DMG/ZIP, uses bundle identifier
  `dev.orca.desktop`, and sets `mac.identity: null` and `notarize: false`.
- `packages/app/scripts/build-daemon.js` bundles the compiled CLI and stamps the root
  release version. `extraResources` puts `daemon/orca-daemon.mjs` beside `app.asar`.
- `packages/app/src/main/daemon-process.ts` starts that bundle under Electron's own
  executable with `ELECTRON_RUN_AS_NODE=1`, authenticates its probe, and owns shutdown.
- `.github/workflows/desktop.yml` packages Mac artifacts; its packaged-app launch is
  Linux-only. Its standalone daemon probe sends an unauthenticated hello, a discrepancy
  to reconcile with the current token default before reusing that step.
- `packages/app/test/smoke/daemon.ts` and `app-shell.spec.ts` create a demo using the
  compiled checkout and pass an external daemon to the app. Reuse assertions, not setup.
- `packages/app/test/smoke/type-proof.spec.ts` uses a development renderer for `#type`.
  [#213](https://github.com/cschadewitz/Project_Orca/issues/213) and
  [#168](https://github.com/cschadewitz/Project_Orca/issues/168) are shipped foundations,
  not packaged Mac acceptance.
- `packages/app/src/main/index.ts` defaults workspace to `ORCA_WORKSPACE` or home;
  `workspace.ts` opens a chosen store read-only. Dedicated writable onboarding is
  [#386](https://github.com/cschadewitz/Project_Orca/issues/386)'s responsibility.
- [#397](https://github.com/cschadewitz/Project_Orca/pull/397) was OPEN/DRAFT at
  `27411de95ad31f014097f31e8c8ff44f65769549` when inspected on 2026-10-02.
  Its authority/admission/identity changes are pending, not imported or assumed shipped.

Owners used below: [#385 delivery](https://github.com/cschadewitz/Project_Orca/issues/385),
[#386 onboarding](https://github.com/cschadewitz/Project_Orca/issues/386),
[#387 upgrade/recovery](https://github.com/cschadewitz/Project_Orca/issues/387),
[#388 packaged tests](https://github.com/cschadewitz/Project_Orca/issues/388),
[#390 physical acceptance](https://github.com/cschadewitz/Project_Orca/issues/390).

## Scenarios

`A` means a proposed automated check on an executor proven to run arm64 macOS.
`M` means a separate physical M-series check. An A pass never implies an M pass.
All rows currently have status **not run**; missing candidate or product interfaces
make execution **blocked**, not skipped-success. Every required row needs evidence.

| ID | Scenario and measurable expected result | Automated boundary | Physical boundary | Owners |
| --- | --- | --- | --- | --- |
| MAC-01 | Select exact source/build/asset; checksum, Developer ID/team, notarization and staple validation succeed; reject unsigned, wrong-arch, mismatched or corrupt input before launch | A: both arm64 DMG and ZIP, actual extracted app | M: same identity through invited download, no repository access needed | #385, #388, #390 |
| MAC-02 | Clean install/first open works without checkout, shell setup, external daemon or bypass | A: fresh profile, minimal PATH, production bundle | M: fresh browser download with quarantine, normal Gatekeeper and Finder installation | #385, #386, #388, #390 |
| MAC-03 | Workspace choice, cancel/back/retry and repeat setup retain the intended workspace only; spaces/non-ASCII supported | A: fresh and reused profiles, two disposable workspaces with distinct markers | M: real folder chooser and Finder launch | #386, #388, #390 |
| MAC-04 | One app-owned daemon starts; authenticated hello matches artifact version/protocol, owned PID and store; required capabilities present | A: verify bundle/resource path, arm64 process, loopback endpoint and token bootstrap | M: understandable connection/workspace identity, no shell daemon required | #386, #388, #390 |
| MAC-05 | Missing and wrong credentials denied on HTTP and WebSocket; valid bootstrap works; no secret crosses evidence boundary | A: separate probe using only disposable token, no auth-mode fallback | M: sanitized failure/retry guidance, no credential requested for sample | #386, #388, #390 |
| MAC-06 | First harmless sample reaches success and produces exact fixture report through bundled execution | A: approved sample, zero paid/provider dependencies, content and provenance assertions | M: participant follows guide, finds output without coaching | #386, #388, #390 |
| MAC-07 | Gate parks, displays consequences, accepts one answer and continues once; permission denial grants nothing, allow-once does not persist | A: gate and scripted permission variants, reopen while parked | M: explain/deny/retry in real controls | #386, #388, #390 |
| MAC-08 | Cancel stops fixture work without success output; deliberate failure displays useful reason; rerun has new provenance | A: held gate and deterministic failure variant | M: cancel and locate failure safely | #386, #388, #390 |
| MAC-09 | Closing the last window and explicit Quit have distinct Mac behavior; reopen retains history, pending gate and preferences without duplicate runs/daemons | A: close/reopen window, then Quit/relaunch; owned PID exits within budget | M: menu/Dock/Finder lifecycle | #386, #388, #390 |
| MAC-10 | Lost connection becomes visible, writes are unavailable, recovery converges without duplicate answers/events | A: terminate only the idle owned fixture daemon; use documented restart/reconnect, no assumed automatic respawn | M: sleep/wake and disconnected recovery separately | #386, #388, #390 |
| MAC-11 | Unwritable/denied workspace and daemon startup failure remain isolated; actionable retry succeeds in fresh valid workspace | A: chmod on fixture child only; repeatable startup refusal without editing signed bundle | M: OS denial/cancel prompts; no broad access grant | #386, #388, #390 |
| MAC-12 | Missing executable, incompatible tool architecture/version and expired sign-in produce preflight guidance, no silent install | A: synthetic preflight fixtures once #386 defines them | M: separately authorized real local-agent run, version recorded; credentials stay local | #386, #388, #390 |
| MAC-13 | Native TCC requests are explained and limited; denial/cancel/retry preserve isolation | A: app error handling only, cannot prove TCC | M only for real OS prompts; absence of a prompt recorded with conditions | #386, #390 |
| MAC-14 | Keyboard, VoiceOver, focus, both themes and small-window scrolling expose all required actions/statuses | A: renderer checks on production pages, not dev-only type route | M: VoiceOver/native dialogs/real window; no synthesized accessibility pass | #388, #390 |
| MAC-15 | Sleep/wake and OS restart recover selected workspace, readable history and parked gate without duplicate execution | A: quit/reopen is partial evidence only | M only for actual sleep and restart | #386, #390 |
| MAC-16 | N-to-N+1 replacement retains protected state; busy/draft refusal, bad download/signature/startup, incompatible epoch, complete restore and uninstall retention follow approved recovery plan | A: consume #387's scenario IDs, paired candidates and oracles | M: execute #387 procedure on disposable data; link its evidence | #387, #388, #390 |

The supported minimum macOS version and chip/OS coverage are decisions for delivery
and physical acceptance owners. Record exact OS build, chip, runner image and process
architecture; leave untested combinations explicit. A runner label alone is not proof.

## Completion boundaries

#403 finishes when these six documents are reviewed and their contracts/unknowns are
usable by a receiving agent. #388 remains blocked for final execution by #385 and #386.
#390 additionally requires #387 and the
[#389 user guide](https://github.com/cschadewitz/Project_Orca/issues/389), plus consent
and physical hardware. Preparation creates no reverse dependency from #385 to #388.
