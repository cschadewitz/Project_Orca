# Windows/Linux private-beta release guidance (review draft)

Prepared on 27 October 2026 from `main` at
`a4e0fd44e2a112129034e2f4c9b33a7c95c6db99`; refreshed on 9 November 2026 against
`main` at `b4f36cabbd26465ad4742dd0581976a95f0f073b`. **No candidate is accepted or
frozen.** Apple Silicon/macOS acceptance is excluded. This draft chooses no version,
release date, download audience, feed setting or migration procedure. It performs no
publication, access change, deployment or installed-host operation.

Use the existing [readiness matrix](../reviews/2026-10-27-release-readiness.md)
for release evidence and [Windows/Linux onboarding](private-candidate-windows-linux/README.md)
for tester instructions. This page joins their handoffs and supplies wording for review;
it does not replace the packaging plan or turn preparation into acceptance.

## Sources and evidence boundary

The following GitHub bodies and available issue comments were read for this draft:

| Source | Use here | Remaining limit |
| --- | --- | --- |
| [#773](https://github.com/cschadewitz/Project_Orca/issues/773), including its C3/D2 comment | Required/conditional checks and unresolved release decisions | Open audit; does not choose or perform a release |
| [#772](https://github.com/cschadewitz/Project_Orca/issues/772), including its v0.6.0 updater comment | Artifact inspection and later disposable native install/update procedures | Static inspection is not packaged launch, signing/trust or installed update proof |
| [#790](https://github.com/cschadewitz/Project_Orca/pull/790) | Merged tester onboarding and corrected offline preparation | Merged docs and tests do not pass G1–G9 or any installed walkthrough |
| [#363](https://github.com/cschadewitz/Project_Orca/issues/363) | Preserve sensitive-input protections and their documented limits | Open for launch secret-reference integration with #336 and complete supported-surface acceptance; no universal redaction assurance |
| [#820](https://github.com/cschadewitz/Project_Orca/pull/820) and the [ACP diagnostic privacy review](../reviews/2026-11-08-acp-diagnostic-privacy.md) | 8 November canary: ACP SDK diagnostics bypassed the execution logger into daemon stderr; patched | Synthetic markers only; no real-world disclosure is established either way |
| [#826](https://github.com/cschadewitz/Project_Orca/pull/826), [#804](https://github.com/cschadewitz/Project_Orca/pull/804), the [Windows signing runbook](../windows-signing-runbook.md) and [release mechanics](../RELEASING.md) | Signing status of candidate files; a signature does not guarantee SmartScreen reputation | `windows-signed.yml` is manual and main-only, and produces short-lived inspection artifacts that are never published. Desktop and release builds stay unsigned |

The [store rehearsal](store-compatibility-rehearsal/README.md) supplies source and
synthetic evidence for the upgrade statements below. Its installed Windows/Linux
rows remain unverified. The [sensitive-input audit](../reviews/2026-10-27-sensitive-input-canary-audit.md)
is bounded regression evidence, with agent echo, transformed/fragmented values and
historical records among its limits. Neither audit certifies real secrets as safe to
share. Diagnostics production capture remains disabled in
[`diagnostics-contract.ts`](../../packages/app/src/diagnostics-contract.ts).

## Coordinator checklist before a tester round

Every box remains unchecked. Keep evidence and participant records in their agreed
private destinations, and use pass/fail/blocked/not-run for each actual observation.

- [ ] Resolve the version, exact build identity and offered combinations. The current
  round targets Windows 11 (Windows 10 excluded); the proposed setup is Windows 11 x64
  NSIS / Ubuntu 24.04 x64 tar.gz (see the coordinator checklist's
  [evidence reconciliation](private-candidate-windows-linux/coordinator-checklist.md#evidence-reconciliation-5-november-2026)). Record the tested OS
  versions and reconcile the final scope with #773 before candidate freeze. A rebuild
  is a new artifact candidate even on the same SHA. Exclude macOS files from tester
  instructions even if workflows produce them.
- [ ] Complete the candidate-bound readiness matrix R1–R11 and applicable C-rows,
  preserving the distinction between source, offline tests, installed validation and
  supported claims. Record any owner disposition of a conditional gap explicitly.
  Reference CI and historical receipts are not candidate acceptance.
- [ ] Obtain #772's artifact manifest and inspection reports, then its applicable
  packaged/native evidence. Reconcile the signing status of the files on the candidate
  card with onboarding G5/G6: testers stop at any security warning, signed or not; a
  coordinator's disposable-VM trust decision does not authorize testers to bypass them.
- [ ] Complete onboarding [G1–G9](private-candidate-windows-linux/coordinator-checklist.md#2-gates-before-anyone-receives-the-guide)
  and walk every offered platform/architecture's P-steps and F1–F10 as written.
  Record unassisted comprehension, reopen and leftover-process findings. A
  5 November exploratory launch of unsigned `b4361b1` on a personal Windows 11 AMD64
  desktop ([#773](https://github.com/cschadewitz/Project_Orca/issues/773#issuecomment-6649853644)) is not candidate or
  clean-install evidence. Native Windows/Linux arm64 execution is not established.
  For a pre-merge packaging receipt, dispatch Desktop with `platform: windows-linux`,
  `linux_runner: tyler` ([#821](https://github.com/cschadewitz/Project_Orca/pull/821); [development guide](../DEVELOPMENT.md));
  packaging alone does not satisfy G3/G4 or fresh-install acceptance.
- [ ] Fill every candidate-card field, including support, consent and retention.
  Record the approved tester list and explicit agreement privately. Use only existing
  authorized access; do not invite users or change visibility to complete this checklist.
- [ ] Exclude prior ORCA installs under the same account from ordinary onboarding, or
  route them to separately reviewed coordinator upgrade testing. Keep update-feed
  activation/audience decisions separate from the tester round.

The [release mechanics](../RELEASING.md) remain the authority for a later release
operation. This checklist authorizes no dispatch, merge, tag, asset upload, feed
activation or actual-host work. A later release review must use the exact release
merge SHA and its matching artifacts, with reruns required by #773 after changes.

## Tester checklist for the private handout

Use the filled [tester guide](private-candidate-windows-linux/tester-guide.md), the
[Windows](private-candidate-windows-linux/windows.md) or
[Linux](private-candidate-windows-linux/linux.md) page, the
[first-success sample](private-candidate-windows-linux/first-success-sample.md), the
[stop/recovery page](private-candidate-windows-linux/when-something-goes-wrong.md) and
the [optional feedback template](private-candidate-windows-linux/feedback-template.md).
The coordinator checks these steps on the candidate before distributing any handout.

- [ ] Read the filled candidate card and consent notice. Stop if a placeholder remains,
  your platform/architecture is absent or you have an earlier ORCA installation.
- [ ] Check the named artifact's SHA-256 and platform trust status by the P-steps.
  Stop at browser, SmartScreen, antivirus, sandbox or FUSE problems. Do not bypass
  protections, elevate privileges or substitute another artifact.
- [ ] Use only the new throwaway project/workspace. Follow F1–F10 for one built-in
  agent-free run, unchanged project and reopen. Do not configure a provider, enter a
  secret, use real work, enable diagnostics or check for updates.
- [ ] Close the app, check for leftover processes and follow only the documented
  throwaway-test stop procedure. Unknown launch outcomes and possible data loss mean
  stop and report; do not submit again to discover whether work ran.
- [ ] Optionally send a text report through the filled private support route. Include
  the candidate, step, expected/actual behavior and safe observations. Omit sensitive
  material; do not attach logs, stores, settings, keys, screenshots or diagnostics.
  Any requested Linux excerpt remains subject to the existing three-line sanitization
  rule. Declining feedback or stopping participation is allowed.

This checks installation and a first local sample only. It does not accept providers,
ReviewJudge, tool guards, MCP sharing, upgrade/rollback or privacy guarantees.

## Support, consent and retention fill-ins

These are unresolved decisions, not assigned policy. The authoritative placeholder
declarations are in the [coordinator table](private-candidate-windows-linux/coordinator-checklist.md#1-fill-in-decisions).

| Fill-in | Required review before a handout |
| --- | --- |
| `{{COORDINATOR}}` | Identify the accountable coordinator; agree escalation ownership for launch, ownership, compatibility or suspected data loss |
| `{{SUPPORT_ROUTE}}` | Name the private reporting route and readers; state how to reach the coordinator when launch fails. No public issue, new account access or remote support permission is implied |
| `{{CONSENT_NOTICE}}` | Supply the reviewed notice with version/date, voluntary participation, optional feedback, report contents/readers, private agreement record and withdrawal route. Installation, diagnostics, remote access and later reproductions do not inherit permission from feedback consent |
| `{{RETENTION_POLICY}}` | Set duration, access, deletion request route, deletion owner and completion record, including accidental sensitive submissions. Do not reuse diagnostic event/lifetime budgets as the feedback retention period |

Support first records the stage, safe observed outcome and what is unknown. Preserve
uncertain state; escalate before any retry or recovery. Follow the existing
[triage rubric](beta-feedback/triage-checklist.md), with its diagnostics wording
superseded by the Windows/Linux guide. A SmartScreen, browser or antivirus warning on
Windows, whether or not the build is signed, is a launch stop to record, not a tester
mistake. Unexpected sensitive content stays out of issues: stop sharing, handle
deletion under the reviewed policy and arrange secret rotation where needed.
No tester identity, consent response, report or private destination is stored here.

## Upgrade and rollback limits for existing installs

**Existing users are outside the ordinary first-run trial.** The following describes
source behavior and synthetic evidence, not an approved installed migration recipe.
No candidate entry point should open an existing store before a complete, consistent
backup and a reviewed migration/restore plan are ready.

| Boundary | Accurate statement for review |
| --- | --- |
| v0.6.0 to current main | `ownership-fences-v1` / protocol 1.8 becomes `operator-journals-v4` / protocol 2.0. Upgrade clients and daemons together; cross-major communication is refused. Intermediate v2/v3 epochs and protocols 1.9/1.10 were never released. Node >=24 is required for the standalone daemon |
| Managed Debian update | The candidate adapter refuses differing epochs at activation/recovery. The installed v0.6.0 adapter instead fails the token-mode candidate's staging health check with HTTP 401, before reaching epoch refusal. These are different outcomes; neither proves an installed migration |
| Migration mechanism | There is no supported cross-epoch Debian migration command. A manual pointer switch bypasses managed checks. The owner must decide and validate a procedure; do not recommend bypassing the epoch check or editing its marker |
| Direct CLI/daemon and desktop | These entry paths do not enforce the release epoch marker. A candidate's first store open can write new state even through `orca runs`, `serve --read-only` or desktop Open a store. Read-only run authority does not mean a write-free first open |
| Windows v0.6.0 update | v0.6.0's updater drives the transition, performs no store compatibility check and may resume admission/restart its daemon after installer timeout/error while installation may still be running. #660's unknown-outcome/closed-admission behavior applies only when the driving build contains it; it does not retrofit v0.6.0. This path applies only if a stable (non-prerelease) version is published to `latest-ARCH` |
| Feed and Linux delivery | Packaged Windows x64/arm64 NSIS uses `latest-ARCH`, rejects prereleases and feed downgrades, and disables automatic download/install-on-quit. A private beta label does not change that selection. Linux AppImage/tar.gz has no in-app updater; replacing the binary does not migrate or restore the store safely. A prerelease version such as `0.7.0-rc.1` is published to `prerelease-ARCH`, which no packaged updater reads: such a candidate is delivered only by direct download, and v0.6.0 installs are not offered it |
| Old reader appears successful | v0.6.0 schemas can parse upgraded records while silently dropping protected payload references/provenance; they reject new `revision.recorded`/`continuation.recorded` events. A successful read or startup is not downgrade compatibility. Equal epochs alone also do not prove semantic rollback safety. Standing-grant rule v2/v3 sidecars and protected approvals written by this build may be refused by older binaries after a downgrade (#805 store fragment); rewriting them as legacy finite grants is not a compatibility mechanism |
| Rollback | Direct in-place downgrade and reinstalling v0.6.0 over upgraded state are unsupported. Stop all writers, retain upgraded state separately, restore the entire verified pre-upgrade state set to its original paths, and only then use the matching retained binary/toolchain. Post-backup work needs separate reconciliation; never mix individual files. Older binaries may refuse standing-grant v2/v3 sidecars and scoped-grant material, so keep the matching protected approvals and key material with the restored set (#805 store fragment) |

Before any separately authorized rehearsal, inventory all configured stores, configs,
permission sidecars, journals, artifacts, workspace/worktree state and platform state
needed for restoration. Windows also needs workspace and app `userData`. Retain
protected material and all existing hidden execution keys with their matching stores;
include keys created by the new build in subsequent backup baselines. Fence/stop all
writers, prove the snapshot consistent, retain matching assets/toolchain and validate
the restore offline. A live copy or public-event-only backup is insufficient.

The detailed [rehearsal procedure and installed evidence rows](store-compatibility-rehearsal/README.md#4-procedure-backup-matched-retention-explicit-migration-offline-restore)
remain preparation. Installed IL/IW rows, Windows older-installer behavior and the
cross-epoch Debian procedure remain unresolved. Decide under #773 whether installed
C3 evidence is required or the limitation must be explicitly stated as unverified;
that decision does not itself create a supported migration path. Do not offer this
transition to an existing feed audience before its separate review.

## Proposed release-note wording (not published)

For owner review after candidate identity, scope and evidence are settled:

> This private Windows/Linux round covers only the files and platform combinations on its
> candidate card, and was validated only on the OS versions listed there; any other
> combination is untested. The Windows and Linux files in this round are unsigned. If a
> browser, SmartScreen, antivirus or OS warning appears, stop and contact the
> coordinator; do not bypass it. Any macOS files attached to the release are
> unvalidated and not part of this round; do not install them. Diagnostics capture stays
> disabled; feedback is optional text through the stated private route, under the stated
> consent and retention notice.

If the candidate card's Windows files are signed instead, replace the unsigned sentence
with: "The Windows files are signed by <publisher>; a signature does not prevent
SmartScreen or enterprise warnings." The warning stop rule stays unchanged.

> This is a store and protocol boundary from v0.6.0: protocol 1.8 /
> `ownership-fences-v1` to protocol 2.0 / `operator-journals-v4`. Clients and daemons
> must move together. Existing installs require separately reviewed migration and
> whole-state backup/restore; installed upgrade/rollback is unverified. Even a
> read-only first open can write new state. Managed epoch refusal does not protect
> direct or desktop opens, and the installed v0.6.0 adapter may fail earlier during
> authenticated staging. Reinstalling an old binary over upgraded state is unsupported.

> Sensitive-input protections are integrated, with bounded regression evidence,
> including the 8 November ACP SDK diagnostic canary and fix (#820). #363 remains open
> for launch secret references and complete supported-surface acceptance. Agent output
> and transformed or fragmented secrets are not covered by a universal redaction guarantee. Use only synthetic, non-secret data in this round.

Revise these paragraphs against the final evidence before use. State the signing
status of the files on the candidate card, not of desktop builds in general; the
[Windows signing runbook](../windows-signing-runbook.md) recommends continuing to call
current builds unsigned. This wording is an R10 input only: R10 closes when the
candidate-bound version renders in the release notes (a `changelog.d` fragment or the
release PR body), checked against G5/G6.

## Decisions still required

- Candidate version/build, offered Windows/Linux artifacts/architectures and OS matrix;
  the Windows participation decision under G6 (stop at P1/P4 vs wait for signing per the
  [Windows signing runbook](../windows-signing-runbook.md)); treatment of any attached
  Mac artifacts.
- Every onboarding fill-in, consent records, private support/escalation ownership and
  report retention/deletion policy.
- #773 dispositions for candidate verification, C3 installed evidence, feed activation
  and existing audience, MCP claim boundaries, advisory residuals and release notes.
- A reviewed cross-epoch migration/restore procedure with installed evidence before
  claiming that existing installs can safely upgrade or roll back.

No checkbox or placeholder has been completed by preparing this draft.

## Validation of this draft

- Main CI `check (node 24)` passed on `02c50de`; a frozen-lockfile local run passed
  `tools/test/private-candidate-onboarding.test.js` (14 tests, no skips). Earlier
  incomplete-environment attempts ran no tests.
- The 9 November refresh, after merging `main` at `b4f36ca`, reran the same suite
  on local Node 22.23.4 (14 tests passed) and checked this page's relative links,
  heading fragments and `git diff --check`.
- Source review: current and v0.6.0 `release-compatibility.json`, Windows
  `update-driver.ts`/`updates.ts`, the existing store rehearsal, the signing runbook,
  the #805 store fragment, the #820 privacy review and the GitHub sources above.
  No tag or release was published.

Not run: full runtime tests, typecheck/build/lint, Electron or packaged-app launch,
Windows/Linux installed acceptance, update/restore rehearsal, diagnostics activation
or provider/actual-host use. No workflow was dispatched. This prose-only change
requires no new runtime test.
