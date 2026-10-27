# Windows/Linux private-beta release guidance (review draft)

Prepared on 27 October 2026 from `main` at
`a4e0fd44e2a112129034e2f4c9b33a7c95c6db99`. **No candidate is accepted or frozen.**
Observer is the final planned feature, with acceptance still pending. Apple
Silicon/macOS acceptance is excluded. This draft chooses no version, release date,
download audience, feed setting or migration procedure. It performs no publication,
access change, deployment or installed-host operation.

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

- [ ] Record Observer's acceptance result and exact head separately. Do not infer it
  from a merged implementation, a green unrelated suite or this agent-free sample.
  Reconcile the final scope with #773 before candidate freeze.
- [ ] Resolve the version, exact build identity, supported Windows/Linux combinations
  and tested OS versions. A rebuild is a new artifact candidate even on the same SHA.
  Exclude macOS files from tester instructions even if workflows produce them.
- [ ] Complete the candidate-bound readiness matrix R1–R11 and applicable C-rows,
  preserving the distinction between source, offline tests, installed validation and
  supported claims. Record any owner disposition of a conditional gap explicitly.
  Reference CI and historical receipts are not candidate acceptance.
- [ ] Obtain #772's artifact manifest and inspection reports, then its applicable
  packaged/native evidence. Reconcile the unsigned notes with onboarding G5/G6:
  testers stop at security warnings; a coordinator's disposable-VM trust decision
  does not authorize testers to bypass them.
- [ ] Complete onboarding [G1–G9](private-candidate-windows-linux/coordinator-checklist.md#2-gates-before-anyone-receives-the-guide)
  and walk every offered platform/architecture's P-steps and F1–F10 as written.
  Record unassisted comprehension, reopen and leftover-process findings. Windows
  and Linux arm64 execution is not established by the existing preparation.
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

This checks installation and a first local sample only. It does not accept Observer,
providers, ReviewJudge, tool guards, MCP sharing, upgrade/rollback or privacy guarantees.

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
superseded by the Windows/Linux guide. An unsigned Windows warning is a launch blocker,
not a tester mistake. Unexpected sensitive content stays out of issues: stop sharing,
handle deletion under the reviewed policy and arrange secret rotation where needed.
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
| Windows v0.6.0 update | v0.6.0's updater drives the transition, performs no store compatibility check and may resume admission/restart its daemon after installer timeout/error while installation may still be running. #660's unknown-outcome/closed-admission behavior applies only when the driving build contains it; it does not retrofit v0.6.0 |
| Feed and Linux delivery | Packaged Windows x64/arm64 NSIS uses `latest-ARCH`, rejects prereleases and feed downgrades, and disables automatic download/install-on-quit. A private beta label does not change that selection. Linux AppImage/tar.gz has no in-app updater; replacing the binary does not migrate or restore the store safely |
| Old reader appears successful | v0.6.0 schemas can parse upgraded records while silently dropping protected payload references/provenance; they reject new `revision.recorded`/`continuation.recorded` events. A successful read or startup is not downgrade compatibility. Equal epochs alone also do not prove semantic rollback safety |
| Rollback | Direct in-place downgrade and reinstalling v0.6.0 over upgraded state are unsupported. Stop all writers, retain upgraded state separately, restore the entire verified pre-upgrade state set to its original paths, and only then use the matching retained binary/toolchain. Post-backup work needs separate reconciliation; never mix individual files |

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

> This private Windows/Linux round covers the named platforms and artifacts on its
> candidate card. Desktop builds are unsigned. Stop and contact the coordinator if a
> browser, OS or antivirus warns; do not bypass protections. Apple Silicon/macOS is
> outside this round. Observer acceptance is pending and is not established by the
> first-run sample. Diagnostics capture stays disabled; feedback is optional text
> through the stated private route, under the stated consent and retention notice.

> This is a store and protocol boundary from v0.6.0: protocol 1.8 /
> `ownership-fences-v1` to protocol 2.0 / `operator-journals-v4`. Clients and daemons
> must move together. Existing installs require separately reviewed migration and
> whole-state backup/restore; installed upgrade/rollback is unverified. Even a
> read-only first open can write new state. Managed epoch refusal does not protect
> direct or desktop opens, and the installed v0.6.0 adapter may fail earlier during
> authenticated staging. Reinstalling an old binary over upgraded state is unsupported.

> Sensitive-input protections are integrated, with bounded regression evidence.
> #363 remains open for launch secret references and complete supported-surface
> acceptance. Agent output and transformed or fragmented secrets are not covered by
> a universal redaction guarantee. Use only synthetic, non-secret data in this round.

Revise these paragraphs against the final evidence before use. If Observer is later
accepted, replace its pending statement with the exact bounded claim and receipt;
do not leave a stale pending statement or invent a passing result.

## Decisions still required

- Observer acceptance result/head and final feature scope before candidate freeze.
- Candidate version/build, offered Windows/Linux artifacts/architectures and OS matrix;
  the unsigned Windows participation decision; treatment of any attached Mac artifacts.
- Every onboarding fill-in, consent records, private support/escalation ownership and
  report retention/deletion policy.
- #773 dispositions for candidate verification, C3 installed evidence, feed activation
  and existing audience, MCP claim boundaries, advisory residuals and release notes.
- A reviewed cross-epoch migration/restore procedure with installed evidence before
  claiming that existing installs can safely upgrade or roll back.

No checkbox or placeholder has been completed by preparing this draft.

## Validation of this draft

Local environment: Linux x64, Node 24.19.0. The available pnpm is 11.19.0;
`package.json` pins 12.4.2. No dependency install or lockfile change was completed.

- `git diff --check`: passed for the tracked Markdown edits; repeated after staging
  all four files to include this new page.
- A Python 3 static check of all four changed Markdown files passed: strict UTF-8,
  LF, final newline, no tabs/trailing whitespace, balanced fences, one title,
  53 relative file links and 9 heading fragments. All placeholders resolve to the
  coordinator's 10 declarations.
- Source review: current and v0.6.0 `release-compatibility.json`, Windows
  `update-driver.ts`/`updates.ts`, the existing store rehearsal and the four GitHub
  sources above. Fetching the v0.6.0 tag supplied read-only historical source; no
  tag or release was published.
- `pnpm exec vitest run tools/test/private-candidate-onboarding.test.js`: did not
  start tests. pnpm attempted an install and failed creating
  `/home/agent/.local/share/pnpm` (ENOENT).
- `node node_modules/vitest/vitest.mjs run tools/test/private-candidate-onboarding.test.js`:
  suite collection failed on missing `yaml` imported by first-run `setup.ts`;
  zero tests ran. This is an incomplete dependency environment, not a passing suite.

Not run: full runtime tests, typecheck/build/lint, Electron or packaged-app launch,
Windows/Linux installed acceptance, update/restore rehearsal, Observer acceptance,
diagnostics activation or provider/actual-host use. No workflow was dispatched.
This prose-only change requires no new runtime test; the existing onboarding suite
must be rerun in the supported complete toolchain before claiming it passes here.
