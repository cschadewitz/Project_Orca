# Invited native Mac beta readiness ledger

**Current preparation audit, 2026-10-08:** main independently confirmed/fetched as
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
combinations, with **no verified coverage here**. The release requires the relevant
M10 actual-Cal and M21 configuration/launch outcomes. Independent preparation can
run early. Canvas, fleet, Docker and #486 are not blanket dependencies.

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

## Concrete source increment

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

## Acceptance ledger and smallest next slices

| Gate | Current evidence | Exact remaining owner step / ordering |
| --- | --- | --- |
| #385 signed/notarized/stapled private candidate | Source foundations only; no actual signed artifact | Apple/release owner verifies existing certificate/private-key authority and approved Team `Q2FP9UY5T4` / bundle `com.schadewitz.orca`, signing environment/trusted source/runner and notary method. Resolve D3 private catalog/access, D4 OS floor/executor and D5 candidate channel/plist mapping. Only a separately authorized native run may create the candidate; validate both final container copies, signatures/entitlements, notary/staple and trusted hashes before authorized private delivery and exact invited browser download. |
| #386 identity/onboarding/preflight | Authenticated target substrate and offline sample available; #333/#334 UI incomplete | Freeze #440 packet/runtime with config/launch owners, including FieldShape and node-preserving comment rules. Independently implement dedicated workspace selection/local tool error modeling, but do not add a rival config/launcher or silently choose agent/version policy. Native first run must observe actual owned daemon/store identity before sample writes, Finder PATH, spaces/non-ASCII, denied workspace, cancel/back/retry and real-agent ACP/tool/auth preflight. Preserve old protected keys/intents and test bundle-ID migration; no reset shortcut. |
| #388 packaged arm64 coverage | Source/fixture checks only; this slice prepares executor/environment input | Once #385/#386 produce agreed outputs, prove automation against unchanged signed app/fuses and an approved arm64 GUI executor. Run both exact DMG and ZIP with fresh/reused isolated state, packaged app and owned bundled daemon arm64 observations, authenticated/negative auth, sample/artifacts/gate/cancel, quit/reopen and failures. Hosted arm64 does not pass physical Gatekeeper/TCC/VoiceOver/sleep rows. |
| #389 matching guide | Repository draft added; Hub unchanged | Bind tested candidate/download/version, actual UI labels/sample/local-agent support, updater result and safe diagnostics controls. Existing Hub owner publishes matching prose under its existing audience only after authorization. Verify invited-user access without implicit repo membership, then revise from an unassisted walkthrough. |
| #416 manual diagnostics/privacy | Approved #469 product bounds; #470 disabled source; no native acceptance here | Diagnostics owner finishes current-base CI/review, native protected storage/save authority, clock/producers and resource/privacy acceptance. Test default-off/declined consent, exact immutable preview/local export/cancel, startup before handshake, no network, bounded recovery/retention/cleanup and unknown outcomes on exact packaged Mac/Windows. First-run/guide consume these results; do not duplicate collector or activate it here. |
| #390 physical signed N→N+1 + unassisted tester | #422/#426 feedback packet and #420 fixture only | After #385/#386/#387/#388/#389/#416 and relevant M10/M21 outcomes, separately consented physical session records actual model/chip/OS/build and exact downloaded signed N and N+1. Link updater owner's complete-state/protected-key recovery acceptance rather than copying twelve rows. Test install/Finder/TCC/sleep/restart/accessibility and approved real agent, plus unassisted guide and diagnostics preview/export/cancel. Resolve launch/security/data-loss blockers before wider invitation. |

No final gate is marked pass. Missing candidate, unresolved interface or absent executor
is **blocked**, rather than an attempted native failure or skipped success. The next
unowned source increment can be archive-containment and owned-root/evidence helpers,
reusing delivery v1 and leaving candidate-mode refusal intact until native provenance
and execution are implemented. GUI-context extensions require a concrete reviewed
need; never inherit the parent environment to make launch work.

## Decisions to return to owners

Bundle/Team identifiers are settled. Publisher/certificate authority, private binary
delivery provider/invite/revocation/retention, minimum macOS/runner image and candidate
version/plist policy remain unknown under [D1–D6](../native-mac-delivery/prerequisites.md#decision-register).
Do not replace them with test values. #386's supported agent/version/auth-error policy,
dedicated writable first-run route and exact configuration/launch contract require
their owners; the helper deliberately chooses none. #388's signed-app automation and
evidence retention are still acceptance decisions. #389's support destination and
candidate wording require confirmation before publication.

#469's nine product decisions are reused: configurable 1–15 minutes, default 5,
1 MiB complete report, 8,192 events, default-off persistent opt-in, one prior crash
session within the same boot/up to 24 hours, approximately 5-second checkpoints,
separate protected key and approved bounded private local staging/save. These are
decisions, not native privacy proof, tester consent or permission to upload. Later
#417/#418 remain outside the beta gate. Avoid raw log tails/screenshots in tester
support despite historical #403 evidence proposals; use #416's stricter allowlist.

## Verification and evidence limits

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
