# Coordinator checklist

For the person running a private Windows/Linux candidate round, not for testers. The
round is a small, trusted group. **Nothing here has been decided or done by this
preparation.** Every box starts unchecked, and testers are **not unblocked** until all
of them are checked for the specific candidate.

## Evidence reconciliation (5 November 2026)

[#790](https://github.com/cschadewitz/Project_Orca/pull/790) merged this preparation;
[#789](https://github.com/cschadewitz/Project_Orca/pull/789) merged the source/offline/synthetic
store rehearsal. Neither supplies installed candidate acceptance. The
[readiness matrix and unbound candidate ledger](../../reviews/2026-10-27-release-readiness.md#candidate-evidence-ledger-unbound-preparation)
record the verified main reference and the remaining evidence per possible combination.
The current personal desktop round targets Windows 11; Windows 10 testing is excluded.
No offered platform set, final candidate identity, support route, retention policy or date
has been selected. All gates and candidate fill-ins below remain open.

[#814](https://github.com/cschadewitz/Project_Orca/pull/814) and
[#815](https://github.com/cschadewitz/Project_Orca/pull/815) merged Windows packaging
preparation. The [#773 exploratory receipt](https://github.com/cschadewitz/Project_Orca/issues/773#issuecomment-6649853644)
records Casey's personal Windows 11 AMD64 launch, bundled-daemon connection and successful
agent-free sample on the unsigned `b4361b1` artifact. This is not a selected-candidate,
clean-install or complete G3/G4 receipt, and does not prove a later build. It changes no
tester warning/consent rules, enables no guard or real agent, and does not resume #779.

When a combination is offered, link its own immutable manifest and separate static,
installation, launch, onboarding, update and offline-restore receipts into that ledger.
A rebuild creates a new identity. Source-built Windows receipts and a green main CI do
not satisfy G2–G4. The preparation issue may be complete while these gates stay unchecked.
For existing installs, use the
[store-rehearsal installed prerequisites](../store-compatibility-rehearsal/README.md#5-installed-windowslinux-rehearsal-prerequisites-and-expected-evidence):
backup must precede the first candidate open, including read-only opens that can write;
rollback requires complete matching pre-upgrade state plus binary/toolchain. Installed
upgrade and restore remain unverified. No manual migration procedure is chosen here.

For Casey's proposed Windows 11 x64 NSIS / Ubuntu 24.04 Desktop x64 `.deb` test setup,
use the [disposable Proxmox VM runbook](../release-test-vms/README.md). It adds capacity
preflight, reusable baselines, independent backup/restore and effort estimates without
changing the candidate decisions or gates below. Its earlier Windows 10 best-effort
proposal is historical and does not apply to this round: Windows 10 testing is excluded.

## Proposed Linux offer for 0.7.0-rc.2 (draft, 20 November 2026)

This is preparation, not a decision that any combination passed. The proposed Linux offer
is **Ubuntu 24.04 Desktop x64 (`amd64`) `.deb`**, package and command `orca-desktop`
([#853](https://github.com/cschadewitz/Project_Orca/issues/853),
[#854](https://github.com/cschadewitz/Project_Orca/pull/854),
[INSTALL-LINUX.md](../../INSTALL-LINUX.md)). The tar.gz and AppImage don't start on stock
Ubuntu 24.04 or later with the sandbox on, and the arm64 `.deb` has never been installed
by any check, so none of them is offered. A rehearsal or pull-request build (for example a
recut posted on #854 or #859) is not the candidate, even from the same commit: fill
`{{ARTIFACT_TABLE}}` only from the versioned candidate's own manifest, and leave
`{{SUPPORTED_PLATFORMS}}` and `{{TESTED_OS_VERSIONS}}` unfilled until that candidate clears
G2–G4 below. Keep the update feed off.

Deliberate keyring cancellation and exact run counting
([#857](https://github.com/cschadewitz/Project_Orca/issues/857)) belong to internal testing,
not to the tester path. Testers only get F7's Linux keyring note.

## 1. Fill-in decisions

Each placeholder below appears in the tester pages. Replace each one in the private copies
you hand out. Never invent a value: if a decision isn't made, the round isn't ready. The
offline test in this preparation fails if a page uses a placeholder this table doesn't
declare.

| Placeholder | Decision | Source of truth / owner |
| --- | --- | --- |
| `{{CANDIDATE_VERSION}}` | The version stamped into the artifacts. Testers compare it with the status bar's `orca-daemon …` | Release owner; the release or Desktop run's version step ([readiness audit](../../reviews/2026-10-27-release-readiness.md) R7) |
| `{{CANDIDATE_COMMIT}}` | The full 40-character source commit | The producing workflow run's record. No commit is embedded in the artifacts ([#772 plan](https://github.com/cschadewitz/Project_Orca/issues/772), "Inputs") |
| `{{DOWNLOAD_LOCATION}}` | Where approved testers download the files. It must be reachable with the private GitHub access they **already** have | Repository owner. Don't change visibility or collaborators, or send invitations, to make it reachable |
| `{{SUPPORTED_PLATFORMS}}` | Exactly which platform, architecture and file type combinations this round offers. Examples: Windows x64 NSIS; Ubuntu 24.04 Desktop x64 (`amd64`) `.deb` | Repository owner, as readiness decision D1. List only combinations that pass gates G2–G4 |
| `{{TESTED_OS_VERSIONS}}` | The OS versions on which **you** ran gates G3–G4 for this candidate. Anything else is "untested" | Coordinator's own runs |
| `{{ARTIFACT_TABLE}}` | Each file name and its SHA-256, from the candidate manifest (computed twice, independently) | Candidate manifest and the #772 static report |
| `{{SUPPORT_ROUTE}}` | The private place testers send reports, and who can read it. Not public GitHub | Coordinator / repository owner |
| `{{CONSENT_NOTICE}}` | The reviewed participation and feedback notice, with its version/date and how to withdraw. Say what optional reports contain, who handles them and how consent is recorded privately; include no participant details in the guide | Coordinator / repository owner; record each tester's agreement outside this repository |
| `{{RETENTION_POLICY}}` | How long reports are kept, who can see them, and how a tester asks for deletion. The diagnostics retention budgets in #416 are **not** a feedback retention policy | Coordinator / repository owner |
| `{{COORDINATOR}}` | The name or handle testers know you by | Coordinator |

## 2. Gates before anyone receives the guide

- [ ] **G1 Candidate frozen.** One commit, built by the Desktop workflow (readiness R5),
  with the run recorded. A rebuild is a new candidate, even on the same commit.
- [ ] **G2 Static inspection.** The #772/#779 inspector reports `consistent` for every
  file in `{{ARTIFACT_TABLE}}` against the manifest and a clean checkout at
  `{{CANDIDATE_COMMIT}}`.
  - **Linux `.deb`: G2 is not enough on its own.** Also record, for the exact file in
    `{{ARTIFACT_TABLE}}`:
    - **Identity.** The file name, its SHA-256 computed twice independently and equal to
      the producing run's artifact digest and the manifest, and the control fields from
      `dpkg-deb -f`: `Package: orca-desktop`, `Architecture: amd64`, the candidate's
      version, and no `Conflicts`, `Breaks`, `Replaces` or `Provides`.
    - **Payload.** `dpkg-deb -c`: every member owned by root, no setuid, setgid or sticky
      bit, nothing group- or other-writable, the app only under `/opt/ORCA`, and nothing
      named plain `orca`.
    - **Scripts.** `dpkg-deb -e`: postinst is the repository's
      `packages/app/build/linux/after-install.tpl` as built. It sets `chrome-sandbox` to
      `0755` and never setuid, loads only the `orca-desktop` AppArmor profile (granting
      `userns` to `/opt/ORCA/orca-desktop` alone), refuses rather than falling back where
      the restriction is on and the profile can't load, and refreshes no shared caches.
      postrm unloads and deletes that profile. No script touches the screen reader package
      `orca`.
    - That the Desktop run's hosted `.deb` install check passed for this build. It is not a
      substitute for G3–G4: a hosted runner is not a desktop session.
- [ ] **G3 Coordinator's own runtime checks**, in a disposable VM or container, for each
  offered combination:
  - Linux: #772 L1, applied to the installed `.deb` on a fresh Ubuntu 24.04 Desktop
    amd64 with a standard account, the default
    `kernel.apparmor_restrict_unprivileged_userns=1`, and the screen reader `orca`
    installed. Record:
    - APT's plan for P3 and the install, and that it matched
    - a **normal sandboxed launch** as the normal user, with no `sudo`, no `--no-sandbox`
      and no setting changed: the `orca-desktop` profile is loaded, `chrome-sandbox` is
      not setuid, and a renderer runs in its own user namespace
    - the bundled daemon connects, and closing stops the app and its daemon
    - `apt remove orca-desktop` removes the profile, and the screen reader's package,
      `/usr/bin/orca` and version are unchanged
  - Windows: #772 W1–W3 and W5. W1's trust prompt is **your own** recorded bootstrap
    decision inside that disposable VM. It is never passed on to testers.
  - keep their evidence
- [ ] **G4 Walk this guide yourself.** Do every P-step and F1–F10 once per offered
  combination, in a disposable environment, exactly as written. Correct the pages
  wherever the candidate differs.
  - On Windows, P4 continues past SmartScreen only under windows.md's named-publisher
    rule; record the exact SmartScreen text a tester would see on a fresh machine. Do P5–P9 and F1–F10 only in the G3 VM,
    under your own recorded W1 trust decision. Still record what a tester would see at
    P1/P4.
  - Known points to confirm:
    - **First launch.** Does it open **disconnected** for setup
      (`packages/app/src/main/index.ts`) or start a daemon (`desktop.yml`'s launch
      expectation, noted in #779)?
    - **Linux APT plan.** The exact plan P3 shows on the offered OS, and whether APT's
      "unsandboxed as root" download note appears as linux.md P4 describes.
    - **Linux sandbox.** That the sandbox starts on the offered OS without changing
      settings, and what a refused install looks like.
    - **Linux keyring.** What the desktop's keyring prompt looks like at F7, and that F7's
      Linux keyring note matches the candidate's messages.
    - **Windows installer.** The NSIS install-mode page and the default location.
    - **Windows folders.** Whether folders made in a normal PowerShell window under
      `%USERPROFILE%` pass first-run's ACL and ownership checks. The source-built
      receipt used a harness-made private project and a plain parent under Documents.
    - **Launch and shutdown.** Connection time, the run result, F10's automatic
      reconnect (source-only so far), and shutdown within about 10 seconds with nothing
      left running.
  - On Linux, **F10 must succeed on the offered OS**, not only be observed: after F9 the
    reopened window appears and is usable, it reconnects to the same workspace, and
    **Runs** shows the same single run with no new one. A failure here blocks the offer.
- [ ] **G5 Unsigned statement.** The release notes say the attached desktop files are
  unsigned and that Windows testers get the separate signed installer (readiness R10, with
  the D1 wording), and the tester pages' warnings agree with it.
- [ ] **G6 Windows warning decision.** Decided for 0.7.0-rc.1: Windows testers receive
  only the **signed** installer, and the unsigned release-page files are never handed
  out. A new certificate may still trigger SmartScreen. [windows.md](windows.md) P4
  allows **More info ▸ Run anyway** only when the publisher reads exactly
  **Casey Schadewitz** and P2's hash and P3's `Valid` signature both matched; every other
  SmartScreen screen, and every browser or antivirus warning, is still a stop. Don't
  extend that exception to any other warning, publisher or file. Don't tell testers to
  choose **Keep** or **Unblock**, don't pick a download route because it avoids a
  warning, and don't pre-unblock files.
- [ ] **G7 No unsupported claims.** The guide and notes claim no supported provider,
  ReviewJudge, tool-guard rule or MCP-operator use (readiness C6/C7). Provider profiles
  and ORCA-owned rules stay "inactive preparation".
- [ ] **G8 Diagnostics still off.** At `{{CANDIDATE_COMMIT}}`,
  `packages/app/src/diagnostics-contract.ts` still has
  `DIAGNOSTICS_PRODUCTION_ENABLED = false`. If a candidate ever enables capture, stop.
  These pages must be rewritten first, and the #416/#469 acceptance must exist. Never ask
  testers to enable diagnostics or send exports.
- [ ] **G9 Copies complete.** Every placeholder is replaced in each tester's copy, and
  nothing else was changed after G4.

## 3. People and consent

- [ ] **Approved tester list**, kept outside this repository: who, the contact, the
  platform and architecture they will use, and when they agreed.
  - Include only people who already have private GitHub access to
    `{{DOWNLOAD_LOCATION}}`.
  - Don't send invitations, add collaborators, change repository visibility, or share
    files or links outside the list.
- [ ] **Consent from each tester, recorded outside the repository.** They agree to:
  - install on their own computer, under their own account
  - use throwaway folders only
  - send text reports only if they want to: no diagnostics, logs or screenshots, and no
    remote access
  - stop at any time
  - have their reports kept as set out in `{{RETENTION_POLICY}}`

  Supply the reviewed `{{CONSENT_NOTICE}}` before agreement. Record its version/date
  and the tester's explicit response privately; an invitation, download or silence is
  not consent. Explain withdrawal and how it relates to report deletion under the
  retention policy. No consent record is created by filling these draft pages.

  A tester on a managed or work computer confirms they are allowed to install software
  there; that permission is not yours to give. Agreeing to test is not permission for
  anything else.
- [ ] **Earlier installs.** Testers who have run ORCA before under the same account are
  either excluded or handled separately. Upgrading an existing install is unverified for
  this candidate (readiness C3).

## 4. Support route and retention

- [ ] The route in `{{SUPPORT_ROUTE}}` is private, and only named people can read it.
- [ ] `{{RETENTION_POLICY}}` says the duration, who has access and how deletion works.
  Reports are deleted on that schedule.
- [ ] Unexpected sensitive material (paths, logs, screenshots, credentials, store files):
  1. stop further sharing
  2. delete it under the policy
  3. record only that material was omitted
  4. ask the tester to rotate anything secret they sent

  Never copy it into an issue.
- [ ] Public issues contain only reviewed synthetic reproductions or content-free summaries.

## 5. During and after the round

- [ ] **Triage** with the existing [triage rubric](../beta-feedback/triage-checklist.md).
  Its diagnostics lines are superseded; see the [README](README.md#reconciled-findings).
  On Windows, "stopped at a security warning" is an expected launch
  blocker (B0 for the journey), not a tester error.
- [ ] Report stage-level observations, not success rates. Record offered and actually
  tested combinations separately.
- [ ] Tell testers when they may uninstall and delete their throwaway folders.
- [ ] Delete reports as the retention policy says, and record that you did.

## 6. What to hand each tester

A filled, private copy of these pages. Don't give them this checklist or the README.

- [tester guide](tester-guide.md)
- their platform's page: [Windows](windows.md) or [Linux](linux.md)
- the [first-success sample](first-success-sample.md)
- [when something goes wrong](when-something-goes-wrong.md)
- the [feedback template](feedback-template.md)
