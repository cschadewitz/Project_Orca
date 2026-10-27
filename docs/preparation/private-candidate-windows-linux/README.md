# Windows/Linux private-candidate onboarding (preparation)

Preparation for [#786](https://github.com/cschadewitz/Project_Orca/issues/786). It
supports the next private release after `v0.6.0`, whose readiness is tracked in
[#773](https://github.com/cschadewitz/Project_Orca/issues/773). Prepared from `main` at
`7f42c3a7699a8da24cfbf4a1ab1f796947bfff14` on 27 October 2026.

**This does not choose a candidate, version, architectures, support destination or
retention policy, and it approves nothing.** Every candidate-specific fact is an explicit
double-brace fill-in, such as `{{CANDIDATE_VERSION}}`, declared in the
[coordinator checklist](coordinator-checklist.md#1-fill-in-decisions).
Testers are **not unblocked**: the checklist's gates G1–G9 all start unchecked.

macOS/Apple Silicon is out of scope. The existing Mac drafts (`native-mac-*`, #389,
#390) are unchanged. The Mac/Windows drafts in [`beta-feedback/`](../beta-feedback/README.md)
are unchanged apart from a superseding note on their diagnostics wording. That note
points Windows/Linux readers here.

## Pages

| Page | Reader | Purpose |
| --- | --- | --- |
| [tester-guide.md](tester-guide.md) | Tester | Start here: the candidate card (fill-ins), what the tester agrees to, what the candidate is not, and stop rules |
| [windows.md](windows.md) | Windows tester | Prerequisites, SHA-256 and signature-status check, NSIS install, first launch, and the no-bypass rule for SmartScreen and browser warnings (P1–P9) |
| [linux.md](linux.md) | Linux tester | Prerequisites, SHA-256 check, tar.gz/AppImage extraction, terminal launch, and the sandbox/FUSE stop rules (P1–P6) |
| [first-success-sample.md](first-success-sample.md) | Tester | The built-in agent-free `orca-beta-local-check` sample over a throwaway Git project, with expected results, resource bounds and how to stop (F1–F10) |
| [when-something-goes-wrong.md](when-something-goes-wrong.md) | Tester | Stopping ORCA and its bundled daemon, interruptions, failed startup, setup refusals, and collecting details safely |
| [feedback-template.md](feedback-template.md) | Tester | Copyable text report: candidate, platform, runtime, steps, expected vs. actual, minimal sanitized evidence |
| [coordinator-checklist.md](coordinator-checklist.md) | Coordinator | Fill-in decisions, gates G1–G9, the approved tester list, consent, support route, retention, triage and hand-off |

Owned by this preparation: this directory and
[`tools/test/private-candidate-onboarding.test.js`](../../../tools/test/private-candidate-onboarding.test.js).
It does **not** change, and only coordinates with, the following:

- packaging helpers ([#772](https://github.com/cschadewitz/Project_Orca/issues/772)/[#779](https://github.com/cschadewitz/Project_Orca/pull/779))
- `electron-builder.yml`, `desktop.yml` and release workflows
- versions, `release-compatibility.json` and release notes (#773)
- the updater, lockfiles and `tools/owned-read-proof`
- application code

## Sources audited

- [Readiness audit](../../reviews/2026-10-27-release-readiness.md) (#775): the evidence
  vocabulary, R5/R7/R10, C1–C3, C7 and decision D1.
- [#772](https://github.com/cschadewitz/Project_Orca/issues/772) and its draft
  [#779](https://github.com/cschadewitz/Project_Orca/pull/779) plan at `554d3ee`
  (`docs/preparation/windows-linux-release-artifacts/README.md` on that branch): the
  candidate manifest, static inspection, L1–L4, W1–W5, U1–U6 and the source findings
  they record.
- Windows first-run receipts:
  - [m21-windows-first-run.md](../../implementation/m21-windows-first-run.md) (#605 delta)
  - [m21-windows-acceptance.md](../../implementation/m21-windows-acceptance.md)
  - `packages/app/test/milestone21/windows-first-run.mjs`, which is the click sequence
    the F-steps follow
- [`beta-feedback/`](../beta-feedback/README.md) (#422) and the
  [`beta-first-job`](../beta-first-job/acceptance.md) fixture (#420).
- Diagnostics: the save-only decision banner in
  [ui-boundaries.md](../crash-recovery/ui-boundaries.md#current-save-only-export-authority),
  `packages/app/src/diagnostics-contract.ts` and
  `packages/app/renderer/src/diagnostics/diagnostics-section.tsx`.
- [RELEASING.md](../../RELEASING.md) (artifacts, bundled daemon, signing) and
  [UPDATING.md](../../UPDATING.md) (Windows bootstrap, verification boundary).
- Product source: first-run `setup.ts`, `directories.ts`, the Windows native checks,
  `index.ts` (target order, pickers, shutdown), `daemon-process.ts`,
  `electron-builder.yml`, the launch route, guided launch, the status bar, the app menu
  and `semantics.json`.

## Reconciled findings

How the current instructions compare with the implemented behaviour at the baseline
above, and what these pages do about each:

1. **Diagnostics promised an in-app exact-content preview that no longer exists.**
   - The `beta-feedback` tester guide says the #416 route "must show the exact contents,
     omissions and local destination before you choose to export". Its report template,
     checklist and triage pages also mention preview.
   - The owner's 9 October decision removed the in-app preview. The current flow is
     Save/export only: the UI shows source, byte count, remaining lifetime and tail-loss
     disclosure, then **Choose destination** and a separate **Save report**.
   - Production capture is hard-disabled (`DIAGNOSTICS_PRODUCTION_ENABLED = false`). The
     Config section says so.
   - Linux packages ship no `resources/native` (#779).
   - **Here:** reports are text only. Testers leave diagnostics off and send no exports.
     Coordinator gate G8 re-checks the flag at the candidate commit, and the test pins
     it. The `beta-feedback` pages carry a superseding note; their Mac content is
     unchanged.
   - Not changed here: the save dialog title in `index.ts` still reads "Save diagnostic
     preview". That is for the diagnostics owner.
2. **Source-built receipts are not packaged acceptance.**
   - The Windows first-run receipt passed on source-built Electron 44.4.5 x64 with a
     test-substituted folder picker. The lockfile now has Electron 44.9.1 and
     electron-builder 26.18.0, neither of which has been packaged for Windows (readiness
     R5/C1).
   - #779's Linux tar.gz/AppImage were local, static-only and never launched.
   - **Here:** every expected result is labelled "from source; not yet observed on a
     packaged candidate", and each platform page ends with a proven/not-proven table.
     Packaged acceptance stays with #772 L1–L3/W1–W5 (gate G3).
3. **The first-launch behaviour is described inconsistently.**
   - `index.ts` opens the app disconnected for setup when there is no explicit target or
     verified selection, and the first-run handoff removed the home-directory default.
   - [RELEASING.md](../../RELEASING.md#the-daemon-inside-the-desktop-artifact) still says
     the bundled daemon serves `ORCA_WORKSPACE` "or the user's home directory".
   - #779 notes that `desktop.yml`'s launch step expects a listening daemon.
   - **Here:** expect **◷ disconnected**, and record anything else. Gate G4 confirms it on
     the candidate. RELEASING.md is the release-doc owner's to correct and is not edited
     here.
4. **"Unsigned and how to open them" (readiness R10) conflicts with not bypassing
   warnings.**
   - RELEASING.md records SmartScreen on the unsigned NSIS installer. Opening it would
     mean "Run anyway", and an unsigned `.exe` may also be flagged by browsers.
   - **Here:** testers stop at P1/P4 and report. Coordinator gate G6 decides whether
     Windows testers join this round at all.
   - Recommendation for the #773 R10 notes wording: for this private round, do not tell
     testers how to get past SmartScreen.
5. **Windows support statements are out of date.**
   - The first-run README (`packages/app/src/main/first-run/README.md`) still says
     "Windows ownership is unavailable here … fails closed".
   - The `beta-feedback` README says no Windows installation flow exists.
   - The #605 delta added native SID/NTFS support (`win32` branches in `directories.ts`,
     `ownership.ts`, `setup.ts`), and the acceptance record's refusal is historical.
   - **Here:** the source-built behaviour is used and labelled as such. The package
     README belongs to its owner and is not edited.
6. **No provider or rule support is advertised.**
   - First-run agent preflight reports `support: "unknown"` and
     `exactCommand: "unsupported"`.
   - Readiness C7 allows only "inactive / offline / proposal" wording for provider
     profiles, ReviewJudge and tool guards.
   - **Here:** testers configure no agent, and the coding fixture is a marked later
     prerequisite.
7. **Updates and earlier installs are out of scope.**
   - Without `ORCA_UPDATE_URL`, the Windows updater points at `https://updates.invalid/`.
   - An earlier install shares the same app name and data paths, and a saved endpoint
     there would take precedence over first-run. Crossing the
     `ownership-fences-v1 → operator-journals-v4` epoch is unverified (C3).
   - **Here:** testers don't use **Check for updates**. Anyone who has run ORCA before is
     excluded or handled separately.
8. **The installer and folder details need hands-on confirmation.**
   - `oneClick: false` with `perMachine: false` is expected to show NSIS's install-mode
     page, so P5 says **Only for me**.
   - Windows first-run requires a drive-letter path on a fixed NTFS volume, an ancestry
     that untrusted principals can't write to, and current-user ownership. The receipt
     used harness-made private folders; the pages use ordinary folders under
     `%USERPROFILE%`.
   - The tar.gz top-level folder name isn't fixed in source.
   - All three go to gate G4 rather than being asserted.

## Candidate-bound hands-on testing still required

None of the following was run. Each needs the candidate and a disposable environment, and
belongs to the coordinator (gates G3–G4) before any tester receives the pages:

- Each offered platform and architecture: install or extract, first launch, the P-steps
  and F1–F10 as written, F10 reopen, and shutdown within about 10 seconds with no leftover
  process. Windows **arm64** and Linux **arm64** have never executed.
- **Windows:**
  - the actual SmartScreen and browser behaviour for the unsigned installer
  - the NSIS pages and default location
  - folder ACL and ownership checks on folders made under `%USERPROFILE%`
  - uninstall leftovers
- **Linux:**
  - whether the Chromium sandbox starts unchanged on each tested distribution
  - FUSE for the AppImage
  - the tar.gz layout
- Whether the packaged first launch is disconnected or starts a daemon.
- The status-bar version string, the location and name of the profile folder, the
  process names used by the [stop check](when-something-goes-wrong.md#stop-orca-and-its-bundled-daemon),
  and the `.orca` store size after one daemon-admitted run.
- Real-user comprehension: a target-like tester with no hints. Record any hint they need
  and correct the pages.

## Validation record

Run on Linux x64 with Node 24.21.0 and pnpm 12.4.2, at the baseline above plus this
change. The dependencies were installed with `pnpm install --frozen-lockfile` and
`ELECTRON_SKIP_BINARY_DOWNLOAD=1`; the lockfile and manifests are unchanged.

### The test (`npx vitest run tools/test/private-candidate-onboarding.test.js`)

**7 passed.** It checks:

- Page set and format: UTF-8, LF, final newline, no trailing whitespace or tabs,
  balanced fences, one title per page.
- Every relative link and heading fragment resolves.
- Every double-brace fill-in is declared in the coordinator table, and every declared
  one is used in the tester pages.
- Every quoted UI string, dialog title, sample identity and status glyph/word appears in
  the source file that renders it.
- Pinned facts: `DIAGNOSTICS_PRODUCTION_ENABLED = false`, the 10-second shutdown
  deadline, the 30-second start and 5-second stop timeouts, `oneClick`/`perMachine`, and
  the artifact name pattern.
- The Windows F1 commands are equivalent to the Linux ones.
- The documented Linux F1 block runs under `bash` in a temporary `HOME` with no user or
  system Git config. Then the production `FirstRunSetup` reviews and prepares it with
  the real filesystem and Git:
  - choose → review gives branch `trial`, the actual `HEAD` and the pinned sample
  - nothing is written before prepare
  - prepare writes exactly `orca.config.yaml` and four `first-run/` files, 5,000–6,000
    bytes in total
  - the project's `HEAD`, status and file list are unchanged
  - no Git config file is created

A mutation check confirmed the test catches drift. Renaming a quoted button in a page,
or dropping `-b trial` from F1, made the test fail. Both changes were reverted.

### Other checks

- **Offline sample run** (scratch directory, not committed). The same workspace files
  were run with `npx tsx packages/cli/src/main.ts --config <workspace>/orca.config.yaml
  run orca-beta-local-check --var task=…`.
  - Result: `completed/success`; steps `start`, `record`, `end`; about 2.2 s wall time,
    including transpilation.
  - Setup files: 5,492 bytes. The `.orca` store: 33 files, 27,825 bytes, including
    `.execution-key` files (hence the never-send rule).
  - The project's status stayed empty, with one commit.
  - This is the in-process engine, not the daemon admission path the app uses.
- **Existing first-run tests** (`packages/app/test/first-run*.test.ts`,
  `packages/cli/test/first-run-sample.test.ts`, `packages/app/test/daemon-process.test.ts`):
  152 passed, 8 skipped (Windows-only) and 1 failed. The failure is `refuses denied
  selection without writing files`, and it comes from the environment: this container
  runs as uid 0, and root can write into the test's mode-0500 directory, which was
  confirmed directly. No product code is changed here.
- **Renderer** `first-run.test.tsx` and `guided-launch-route.test.tsx`: 29 passed. This
  focused run had coverage thresholds disabled.
- **`npx vitest run tools/test`**, after `pnpm exec tsc -b tsconfig.build.json`: 36
  files, 1,194 passed, 1 pre-existing skip. Before the build, 4 `m10-owned-plugin` cases
  failed only because they need compiled `dist/` output.
- **`beta-feedback`'s own documented link/format script:** passes with the superseding
  notes (6 documents, 26 local links).
- **The new test file:** `eslint` and `prettier --check` pass. `git diff --check` is
  clean.

Not run:

- the full `pnpm test`, typecheck and build
- any Electron launch, packaging or installation
- any Windows execution
- real-user walkthroughs
- uploads or invitations

Merging this preparation does not approve a candidate or close #773/#772.
