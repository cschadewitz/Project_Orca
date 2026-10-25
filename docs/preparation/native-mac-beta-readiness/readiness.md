# Invited native Mac beta readiness ledger

**Current reconciliation, 2026-10-25:** audited main
`0f45181c52dfc4bf1edd0e4469ff688dedef9189`, including merged
[#607](https://github.com/cschadewitz/Project_Orca/pull/607). The
[acceptance runbook](acceptance-runbook.md#current-reconciliation--25-october-2026)
and its [shared physical-Mac receipt](acceptance-runbook.md#shared-candidate-bound-physical-mac-receipt)
are the current owner/evidence handoff, used by the
[operator checklist](operator-checklist.md) and [guide](getting-started-draft.md).
Core #333/#334 config/launch and generic actual-Cal #393 are closed; mounted setup,
reviewed config binding, #570 ownership recovery, production delivery adapters and
closed diagnostics producers are implemented. Source/fixture/Windows evidence is not
signed Darwin or unassisted acceptance. Production capture and updater activation
remain held; diagnostics are Save/export-only, with no in-app report viewer.

#389 prepares versioned source and existing-Hub content/access-valid links; #390
owns final candidate-matched guide and unassisted physical proof. #602 owns signed
private delivery/installed bundled execution, #603 exact N/N+1 and coherent restore,
and #604 native diagnostics. #594 remains mandatory before beta, including the
[13 October live permission-callback lifetime transfer](https://github.com/cschadewitz/Project_Orca/issues/594#issuecomment-6150016812).
Closed #393 does not clear that row. #597/#598/#600/#601 remain separately deferred.
No device, provider, signing, publication or acceptance operation ran here.

**Historical preparation slice, 2026-10-09:** the original #555/#567/#569 packet
emitted unrun vectors and awaited #570 composition. Its separate-head and missing-code
observations are superseded by the current reconciliation above, not physical proof.

**Historical preparation audit, 2026-10-08:** main independently confirmed/fetched as
`db579fb7ac9cfce2e4e6901713088a80602311da`. #529 and #541 are merged. Their executor/
environment and fixture ZIP containment helpers are reused unchanged. Today's
[candidate execution packet](candidate-execution.md) records the current source/UI
audit, non-secret prerequisite findings, explicit unsigned staging plan and Casey's
timed action list. Current main has the guided controller/component but no shell
registration; #334/#386 integration is separately owned. Diagnostics and Mac updater
source are present but native activation/acceptance is separately owned and unproven.
The source/ownership tables below retain the **2026-10-07 historical snapshot**, rather
than pretending their old open-PR/merge-pending entries describe today's state.

Source audited on 2026-10-07: main
`c1eba301702fef0466b2d3481c36d62331ee7d48`, independently confirmed with
`git ls-remote origin refs/heads/main`. AGENTS.md, CONTRIBUTING.md,
docs/DEVELOPMENT.md and docs/ARCHITECTURE.md were read. No repository `.agents`
directory or local SKILL.md was present; `/workspace/.agents` was empty.
GitHub issues and open PRs were read through the authorized connector; the shell
GitHub API route returned Forbidden and was not used for writes.

After this initial audit, the parent reported main advancing to
`fff65ed1ff59e06b012369ec6e2ca3c8f07426fc` through approved #514 merge. This slice
retains its original exact base; no dependency branch or lock update is imported,
and no redundant tests are run solely for that main movement.

This is source/preparation progress for M22, **invited native Apple Silicon Mac
beta**, not acceptance or issue completion. M3–M5 with current macOS are target
combinations, with **no verified coverage here**. The release consumes the completed
relevant M10 actual-Cal and M21 configuration/launch outcomes, with #594 still
required. Independent preparation can run early. Canvas, fleet, Docker and #486 are not blanket dependencies.

## Historical work and ownership snapshot

| Work | Reused evidence and boundaries |
| --- | --- |
| #385 delivery | #402/#405 preparation, approved identity #456, merged #464/#467 producer and locked-builder/validator integration. [Signing foundation](../native-mac-delivery/signing-foundation.md) and the single fixture-only `tools/deploy/native-mac-verify.py` are already present. DMG/ZIP fixture files and signing declarations are synthetic. |
| #386 first run | #318 authenticated target/config foundations and #420/#427 [first-job fixture](../beta-first-job/acceptance.md) exist. Offline patch success is not packaged sample or provider acceptance. #333/#334/#355 remain open. |
| #388 packaged tests | #403/#406 [MAC-01–16 matrix](../native-mac-testing/test-matrix.md), #445/#457 authenticated standalone bundle probe, merged #442 fixture validator and #467 integration exist. No downloaded archive containment or packaged app launch follows from them. |
| #389 guide | This slice adds [versioned guide prose](getting-started-draft.md) alongside the existing #422/#426 feedback packet. Existing Hub is the destination; no new Site, publication or audience change is performed. |
| #387 updater | Active owner thread `01a11890-dc4c-730c-b73c-b4d62e99c014`; lifecycle/recovery source and its twelve acceptance rows remain exclusively there. MAC-16 consumes that owner's results by reference. |
| #439 recovery/support docs | Open draft, head `39d4cf75b9e46dd267ccf0ae044f29f220fe667d`, reviewed clear/merge pending per parent. Reuse its automatic-install-after-specific-approval and complete-state recovery direction; do not rewrite its four files. |
| #440 config/launch docs | Open draft, head `4aa142e870c9cedcd4d26108d975c0f7c7f4619a`, reviewed clear/merge pending per parent. Rich FieldShape/absence/null/default and comment-preserving structural lowering still need an accepted contract/runtime freeze. No interface freeze is invented here. |
| #416/#469/#470 diagnostics | #470 current reported head `a174e33c307ef9348412eaad69bc0df9399ad684`; source clear per parent, CI/native/privacy gates open. Native adapter, clock/producers and capture remain disabled/unconnected. No diagnostics implementation changes here. |
| #514 → #517 → #513 | Sole dependency owner `01a11874-b294-74d2-92a3-c3cdf785300f`. #513 reported head `fc718aefe88d64c6e9ffeeaa668fcc961ebd3342`, Electron 44.5.1 source clear; real binary/native/packaging smoke unrun. Manifests/lock are not edited or imported. |
| #526/#527/#528 | Timeout owner `01a11871-31ad-7745-8241-0d7ced84c018`; no fixture/runtime shutdown overlap. |

The open-PR inventory contained no implementation PR owning the new
`tools/packaged-mac/` helpers. This branch owns only those helpers, their focused
test and this new documentation directory. Parent retains review, central CI and
workboard ownership. No new issue, assignee, milestone or acceptance checkbox is
changed. No homelab job, workflow edit/dispatch, merge or release is performed.

## Historical concrete source increment — 7 October preparation

[Executor preflight and environment helper](../../../tools/packaged-mac/README.md)
prepare #388's MAC-02/04/12 environment boundary without choosing #386's UI/API.
The read-only preflight refuses this Linux host with exit 2/HOST_PLATFORM. It can
observe an arm64 macOS executor later, but leaves GUI, app/daemon architecture and
candidate execution explicitly unchecked. The app environment is built from explicit
account/scratch/locale inputs and cannot inherit source-smoke daemon/renderer
overrides, developer PATH, signing/provider credentials or sandbox flags.

This is an independent source slice, not a duplicate app-smoke run or new delivery
validator. Tests inject synthetic system observations; no Apple tool or product
process is launched. The existing desktop/app-smoke workflows still need parent
resolution of dispatch and runner routing. Do not mutate or dispatch them here.

## Current acceptance ledger

The [runbook owner handoffs](acceptance-runbook.md#current-owner-handoffs) and
[shared receipt](acceptance-runbook.md#shared-candidate-bound-physical-mac-receipt)
consolidate the existing gates; use their exact source links and ownership rather
than the historical open-PR table above. No final gate is marked pass. Missing
candidate, consent or executor is **blocked**; attempted failed oracles are **fail**;
unexecuted cases are **not run**. Skipped launch and unsigned fallback never pass.

| Gate | Implemented preparation | Remaining owner evidence |
| --- | --- | --- |
| #385 → #602 delivery / packaged execution | Native pre-sign identity, trusted candidate validator and bounded DMG/ZIP containment; bundle `com.schadewitz.orca`, Team `Q2FP9UY5T4` settled | Existing Apple custodian confirms usable signing/notary authority and trusted boundary. Release/private-delivery owners confirm version/channel/OS/workflow/publisher policy, catalog/invitation/freshness/revocation and independently accepted installed manifest. #602 executor supplies signed downloaded candidate, normal Gatekeeper and actual arm64 app/bundled-daemon receipt. Forbidden metadata means unknown, not absent credentials. |
| #386/#333/#334 first run and launch → #602/#390 | Mounted JEV-free setup/launch, config review/Save/Apply and saved-config binding, same-boot recovery and explicit previous-boot settlement | App/provider and physical owners bind supported versions/native paths, Finder preflight, real-agent configuration persistence and exact installed lifecycle/permissions/sample/gate/artifact/cancel evidence. Legacy uncertain and surviving/foreign writer limits remain explicit. No new config/launcher is needed. |
| #387/#571 update → #603 | Exact approval, natural drain/closed admission, native provider and fixed-pair coherent recovery composition | Updater/physical owners prove exact signed N/N+1 automatic install after positive quiescence, continuity and complete protected-state plus matching-binary recovery. Activation remains held; manual replacement is insufficient. |
| #416/#469 diagnostics → #604 | Save/export-only source and closed producers composed; default-off capture held | Diagnostics owner supplies native consent/isolation/storage/expiry/crash/no-network/accessibility and 8 MiB binary / 32 MiB combined-memory evidence. Corrected C15 managed memory still fails; non-Mac obligations remain #416/#469. Viewer/text selection is removed scope; only 4 ms is deferred in #597. |
| #594 exact command and live callback lifetime | Generic actual-Cal #393 closed; exact-command support remains unsupported | Cal coordinates supported provider contract/version, bounded authority/projection, installed correspondence and separately authorized actual-Cal one-command and live-callback lifetime proof. Casey retains additional product choices. Synthetic evidence cannot clear beta. |
| #389 → #390 guide / unassisted first run | Versioned guide aligned to implemented controls and Save/export-only diagnostics; Hub unchanged | Documentation/Hub owner supplies candidate version/download/support/update facts and access-valid matching source/Hub revision. Physical coordinator and target-like participant supply consented unassisted evidence, record hints and correct guide defects. Pre-Mac preparation need not await #390 closure. |

Existing #469 bounds remain: 1–15 minutes (default 5), 1 MiB complete report,
8,192 events, persistent default-off opt-in, one prior crash session within the same
boot/up to 24 hours, approximately 5-second checkpoints and separate protected key.
Decisions are not privacy proof, tester consent or upload authority. #417/#418 remain
outside the beta gate. Shared evidence uses the stricter #416 allowlist; raw logs,
screenshots, personal paths, credentials and prompt/code/output are excluded.

## Historical verification and evidence limits — 7 October preparation

At the source change: Node 24.21.0 / pnpm 12.4.2; pnpm verified all 534 existing
supply-chain policies without exclusions and retained the frozen lock. Final focused
Vitest: **36/36, one file, no skips**, including a real tooling subprocess receiving
only the constructed environment, synthetic native observations and closed CLI usage
failure. Owned JavaScript ESLint/Prettier and three Markdown files/twelve local
links/fragments/UTF-8/LF/whitespace/fences pass. The separately invoked real Linux
preflight exits 2 with HOST_PLATFORM as expected. Git whitespace/scope and exact
published-head evidence are recorded on the draft PR.

No broad suite, Electron binary download, source app smoke, native app/daemon,
signing/notarization/stapling, invited download, provider/actual-Cal, update/recovery,
diagnostic capture/export, device installation, Hub publication or tester walkthrough
is claimed. Current CPU/RAM/load on homelab has not been obtained; no homelab work is
scheduled. No host provisioning, credential/access/audience changes, security weakening
or platform switch was used. Sandbox, Keychain, journals and TCC remain untouched.
