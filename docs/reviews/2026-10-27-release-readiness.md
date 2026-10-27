# Readiness for the next private release after v0.6.0

**Status: not ready. Scope, version and candidate are not frozen.** This is an audit of
`main` at `4d5176c8d57c37f974517900935e6e28ea234082` (27 October 2026), tracked by
[#773](https://github.com/cschadewitz/Project_Orca/issues/773). It records what a candidate
has to pass, what depends on which artifacts and features are selected, and what stays
deferred. It chooses no version, date or candidate. Nothing here was tagged, published,
uploaded, deployed or dispatched. Apple Silicon/macOS acceptance (M25) is out of scope.

The release mechanics are [RELEASING.md](../RELEASING.md). Update and store-compatibility
operation is [UPDATING.md](../UPDATING.md). This document does not restate either. It
records how they apply to this candidate.

## What has changed since v0.6.0

| Fact | v0.6.0 (`c5c7cd3`, 29 Sep) | `main` (`4d5176c`) | Source |
| --- | --- | --- | --- |
| Root version | 0.6.0 | 0.6.0 (unbumped) | `package.json` |
| Store epoch | `ownership-fences-v1` | `operator-journals-v4` | `release-compatibility.json` at each ref |
| Protocol | 1.8 | 2.0 | same |
| Capabilities | 5 | 7 (adds `workflows.validateInputs`, `inputs.live`) | same |
| Node engine | `>=22` | `>=24` | `package.json`; `0-node24-minimum.changed.md` |
| Electron (locked) | 44.4.3 | 44.9.1 | `pnpm-lock.yaml` |
| electron-builder / electron-updater | 26.15.3 / 6.8.9 | 26.18.0 / 6.8.11 | `pnpm-lock.yaml` |
| ACP SDK | 1.4.0 | 1.8.0 | `pnpm-lock.yaml` |
| Pending fragments | none | 168 (3 added by this audit) | `changelog.d/` |
| First-parent commits | n/a | 201 | `git log --first-parent v0.6.0..4d5176c` |

The intermediate epochs `protected-execution-v2` and `config-generations-v3`, and protocols
1.9 and 1.10, appeared only on `main`, never in a release. Under the pre-1.0 rule a store
epoch change plus a protocol major is at least a `release:minor`/`release:major` label. The
version the labels compute is a release-planning decision and is not recorded here.

## Words used for evidence

Each row below uses one of these, and only claims the strongest one it has:

- **Source**: the code is merged on `main`.
- **Offline test**: unit, fixture or synthetic tests pass in CI or locally. No installed
  build or real provider was involved.
- **Installed validation**: a built or packaged artifact was executed on the named
  platform, with a recorded receipt.
- **Enabled default**: the behaviour is active for a user without opting in.
- **Supported claim**: release notes may tell users they can rely on it.

| Area | Strongest evidence on `4d5176c` | Enabled default? | Supported claim allowed in notes |
| --- | --- | --- | --- |
| ORCA-owned tool-guard rules, typed sidecar, owned-read, scoped review (#702/#703/#706) | Source + offline tests; disposable Linux reads (#729/#739) | **No**. Default-off, no production registration. Only the `.orca-typed-workspace` refusal in CLI config loading and update bootstrap is active | Only "prepared, inactive". Acceptance work remains |
| Provider preparation: Claude (#704), Gemini/Pi (#705), Copilot CLI (#709), OpenCode (#710), ReviewJudge (#701) | Offline fixtures and proposals | No. Profiles are inactive | **None**. Provider preparation is not live support |
| MCP operator / private tunnel (#327/#392) | Source; production MCP acceptance in CI (`ORCA_MCP_REQUIRE_PRODUCTION=1`); actual-Cal rows C2/C5a/C6a/C7a/C7c/C8 passed on `0c75d01` for the dedicated single-owner setup (#393, closed) | Feature-gated by provider and authority | Single-owner operator use only, with the open rows below stated. Missing/invalid-credential checks are source-only, not live-passed (#392) |
| Windows first run, config/template, update recovery (#605/#606/#660) | Installed validation on source-built Windows/Electron ([m21-windows-acceptance.md](../implementation/m21-windows-acceptance.md), [m21-windows-first-run.md](../implementation/m21-windows-first-run.md)) | Yes, for the paths described | As described in those receipts. Not packaged/signed install or upgrade from a release artifact |
| electron-builder 26.18.0 / Vite 8.3.5 (#720) | Local Linux x64 `tar.gz` packaging and ASAR closure; UI not launched ([2026-10-26-builder-vite.md](2026-10-26-builder-vite.md)) | Yes (build tooling) | Build tooling only. No Windows/macOS packaging on these versions yet |
| electron-updater 6.8.11 (#714) | Offline tests ([2026-10-26-electron-updater-6.8.11.md](2026-10-26-electron-updater-6.8.11.md)) | Yes | Dependency update only. No packaged-update evidence |
| Electron 44.9.1 | Main CI only (Electron binary download is skipped there) | Yes | Dependency update only |

## Required for every candidate

The candidate is the release merge commit (`release: vX.Y.Z` merged into `main`).
`release-publish.yml` runs the first group against that exact SHA. The rows marked
*before merge* exist because a failure there leaves the version bump on `main` with no tag
(see RELEASING.md "fix forward").

| # | Check | Owner / dependency | Exact evidence source | State on `4d5176c` | Rerun when |
| --- | --- | --- | --- | --- | --- |
| R1 | Typecheck, design-token freshness, format, lint, build on the release merge SHA | Release owner; `release-publish.yml` job `check` | That job's log for the merge SHA | Main CI [run 40414180640](https://github.com/cschadewitz/Project_Orca/actions/runs/40414180640) is green on `4d5176c`. That is reference evidence only, not the merge SHA | Any commit change |
| R2 | No-skip CLI/ACP retry acceptance: both named files run, every test passes, zero skips | same; parity enforced by `tools/test/release-workflow.test.js` | Step "Retry admission acceptance (CLI and ACP)" printing `none skipped` | As R1 (CI runs the same step) | Any commit change |
| R3 | Full suite with production MCP acceptance required (`ORCA_MCP_REQUIRE_PRODUCTION=1`), after build | same | Step "Test" | As R1 | Any commit change |
| R4 | Compiled CLI smoke: `node packages/cli/dist/main.js demo` | same | Step "Smoke test the compiled build" | As R1 | Any commit change |
| R5 | Desktop artifacts on Linux (self-hosted x64), macOS and Windows runners, including "The bundled daemon answers authenticated hello" | Release owner; `desktop.yml` (reusable) | `desktop` job of the release run; *before merge*: a `workflow_dispatch` of **Desktop** on the candidate head | **Gap.** The last Desktop run was 30 Sep (a Dependabot PR, failed). No run covers builder 26.18.0, updater 6.8.11 or Electron 44.9.1 | Any change under `packages/`, the lockfile, `electron-builder.yml` or `desktop.yml` |
| R6 | Linux Electron smoke plus the Linux/macOS/Windows type-proof matrix | Release owner; `app-smoke.yml` with `ref` | `app-verification` job of the release run; *before merge*: dispatch **App smoke** with `ref` set to the candidate, so the classifier runs the full matrix | Last main dispatch: `408a21d` (25 Oct), success. Not current | Any renderer, design, font or app change; never update baselines inside the release run |
| R7 | Artifact identity: one version read once and stamped into every artifact; tag `vX.Y.Z` absent; Windows architecture assets collision-checked (`tools/deploy/release-assets.py`); `appId` `com.schadewitz.orca` with Windows `dev.orca.desktop` retained; `orca-daemon-X.Y.Z.mjs` present | Release owner | Release run steps "The version being released" and "Tag and release"; #772 helpers for per-file SHA-256 manifests once they exist | Not run | Any rebuild. A rebuilt artifact is a new candidate even on the same SHA |
| R8 | Store and compatibility statement matches `release-compatibility.json` | Release owner; fragment authors | `### Store format` in the rendered notes against `release-compatibility.json` at the merge SHA | Drafted by this audit (`0-v060-upgrade-boundary.store.md`). Needs review | Any change to `release-compatibility.json`, store writers or protocol |
| R9 | Notes render and are reviewed as the release PR body | Release owner; all fragment authors | `node tools/release.js notes --unreleased` (exit 0, no warnings on this branch); later, the release PR body | Renders. 49 fragments lack an area prefix and render as one ungrouped block above the target headings | Any fragment change |
| R10 | Release notes say the desktop builds are unsigned and how to open them | Release owner | Rendered notes | **Missing.** No fragment says it. Wording depends on which artifacts ship (D1) | Artifact scope change |
| R11 | A milestone with every issue closed and a bump label, or a manual **Release (prepare)** dispatch | Repository owner | `release-prepare.yml` | **None exists**. No milestone is a release milestone | Scope change |

## Conditional on what is included

| # | Included if… | Required check | Owner / dependency | Evidence source | State |
| --- | --- | --- | --- | --- | --- |
| C1 | Windows NSIS/zip artifacts ship | Static inspection of artifacts (PE/manifest, NSIS, `latest-ARCH.yml`, SHA-512, blockmap; Authenticode reported "present, unverified"), then a clean install and launch, and the UPDATING.md Windows N→N+1 upgrade/failure/rollback on a native host | calciferschadewitz; [#772](https://github.com/cschadewitz/Project_Orca/issues/772) owns the plan and helpers | #772 outputs, once published | Not run. Builder and updater versions have never been packaged for Windows |
| C2 | Linux AppImage/`tar.gz` ship | #772 static checks (ASAR entries, dev-package leaks, CSP/fonts, daemon version stamp), then a packaged launch | calciferschadewitz; #772 | #772 outputs; [2026-10-26-builder-vite.md](2026-10-26-builder-vite.md) for the local `tar.gz` baseline | Local `tar.gz` only; UI not launched |
| C3 | The managed Debian updater or Windows feed serves this release to existing installs | Observe, on an installed 0.6.0 host, that activation across `ownership-fences-v1` → `operator-journals-v4` is refused and the documented manual migration works; otherwise say it is unverified | Release owner; UPDATING.md "Recovery and store compatibility" | Installed-host receipt | Unverified. Source and docs only |
| C4 | Repository variable `ORCA_FEED_HOST` is set when the release PR merges | Decide before merge. `release-publish.yml` activates the private feed automatically after publishing, which reaches the existing feed audience. A new audience is out of scope | Repository owner | Release run step "Activate the private desktop feed" | Decision pending |
| C5 | macOS `.dmg`/`.zip` stay attached (`desktop.yml` builds them unconditionally) | Notes must say they are unsigned and unvalidated. The bundle ID changed from `dev.orca.desktop`, so an existing Mac install is not a validated upgrade path (RELEASING.md "Approved application identity"). All Mac acceptance stays in M25 | Repository owner | Rendered notes | Decision pending (D1) |
| C6 | Notes describe the MCP operator beyond single-owner use | #392 live missing/invalid-credential checks. Anything offering scoped access to other users or agents needs [#598](https://github.com/cschadewitz/Project_Orca/issues/598) actually passed | calciferschadewitz / repository owner; #327, #392, #598 | Issue receipts | Not passed. #598 is **closed "completed" with no passing evidence**, while #327/#392 (25 Oct) still call it deferred and not passed. Treat it as unpassed until its owner reconciles it |
| C7 | Notes mention providers, ReviewJudge or tool guards | Wording stays "inactive / offline / proposal". No supported-provider claim | Fragment authors | Fragments for 70x | Checked by this audit. See below |
| C8 | Supply-chain claims, or #521 residuals are to be closed before release | Rerun `pnpm audit` on the candidate. Disposition for the residuals: Magicast's bundled `source-map-js` 1.2.1, `@electron/get` 3.1.0 in packaging, SLSA provenance unverified (trusted-root 403), packaged contents not yet inspected (overlaps #772) | calciferschadewitz; [#521](https://github.com/cschadewitz/Project_Orca/issues/521) | #521 comments (26 Oct): full audit 1 high → 0, prod 0 → 0 | Open, `status:review`, not labelled a blocker. Accept-and-state or fix is the owner's choice |

## Explicitly deferred (not blockers for this release)

| Item | Status preserved | Why it is not a blocker here |
| --- | --- | --- |
| Live Apple Silicon: #390, #602, #603, #604 (M25) | Open | Out of scope by instruction. No Mac acceptance is claimed |
| #594 exact-command approval | Open, mandatory before the Mac beta | Gates the Mac beta, not this private release, provided notes make no exact-command approval claim |
| #598 scoped reads and live revocation | Treated as unpassed (see C6) | Conditional on broader sharing only |
| #600 tunnel lifecycle rehearsals; #601 lost continuation replay | Backlog, deferred, not passed | `release:none`; required only before advertising that coverage |
| #509 risk-based testing; #510 fixture speedups | Usage/implementation hold (25 Oct) | `release:none`. The release-workflow parity test keeps the current gate |
| #597 C15 managed-memory acceptance (64 MB vs 32 MiB) | Fails; activation/acceptance blocker | Applies to the native diagnostics activation it gates, which stays hard-disabled |
| Signing and notarisation; Windows `appId` migration | Not done; separate decision | Stated in RELEASING.md; notes must say so (R10) |
| JEV / #395; #566 research | Deferred by owner (8 Oct) | Excluded from supported configuration |
| Roadmap milestones 11–24 and performance work | Open roadmap | Not every open issue is a blocker; none is labelled as gating this release |
| #701–#706, #709, #710 | In progress, inactive | Ship only as inactive preparation (C7) |

## Changelog audit

All 201 first-parent merges since `v0.6.0` were checked against `changelog.d/` and
`no-changelog` labels. Most test-only and inactive merges carry the label or have a fragment
added later (#686, #674 and #646 by #691). This audit changed only the following:

**Added**

- `0-v060-upgrade-boundary.store.md`: the one upgrade statement a 0.6.0 user needs. It
  covers the epoch, protocol and capabilities from 0.6.0 to now, and says that the
  intermediate epochs and protocols named in older fragments were never released. It uses
  issue `0` so that it renders first in `### Store format`. Existing store fragments are
  left unchanged.
- `0-runtime-dependencies.changed.md`: Electron 44.4.3 → 44.9.1 and ACP SDK 1.4.0 → 1.8.0
  ship to users and had no note (`3b726d74`, `c826c464`, authored by Calcifer Schadewitz).
- `433-artifact-version-keys.fixed.md`: the `[`/`]` artifact version keys fix (`3e895c7e`,
  authored by cschadewitz) changed a v0.6.0 code path and had no note.

**Qualified** (the authors' wording is kept and the qualification is added)

- `0-updater-6.8.11.fixed.md`: the fixes are electron-updater's own. ORCA's update
  behaviour is unchanged.
- `0-builder-vite.changed.md`: the compatibility checks were review evidence, not
  something that ships. Runtime source is unchanged.
- `703-owned-read-live-capture.added.md`: the second bullet now says it is inside the
  default-off bridge. Nothing in production imports that owner.
- `702-protected-review.added.md`: the redaction applies to approval events from the
  inactive path.
- `702-linux-managed-owner.added.md`: it now states the one active effect, that CLI
  configuration loading and update bootstrap refuse a workspace beneath a
  `.orca-typed-workspace` marker.

**Flagged for fragment authors, not changed**

- 49 `added`/`changed`/`fixed` fragments have no `**area:**` prefix. Examples are 331-*,
  387-*, 394-*, 483-*, 49x-*, 571-*, most 702-*/703-* and `operator-windows-sync`.
- `703-candidate-owned-read-verifier.added.md` covers `tools/` and docs only and renders a
  `#### tests` heading. The author should decide whether it belongs in user notes.
- `331-admission-retry.added.md` says the capabilities "are not enabled by the feature
  modules alone". Re-check this against the protocol reference, which documents
  `runs.admit`/`admissions.*` as part of 2.0.
- `329-332-318-237-runtime-integration.added.md` and `operator-integration.store.md` name
  protocol 1.10. The new store fragment explains this, so the text is left as it is.
- PRs touching `packages/` with inactive or type-only changes and neither a fragment nor
  the label: #733, #742, #746, #716, #489, and #551 (a `RETRY_CONFLICT` code inside
  unreleased admission retry). Label them or extend the matching fragment.
- RELEASING.md says Electron 44.4.5. The lockfile has 44.9.1. Correct this through the
  owner of that doc.

## What a candidate change invalidates

- **Any new commit**: R1–R7 and R9 rerun on the new merge SHA. Pre-merge Desktop and App
  smoke dispatches rerun on the new head.
- **Lockfile, Electron, builder, updater or packaging config**: R5, R6 and R7, plus C1–C3
  installed evidence.
- **Store writers, event schemas, protocol or `release-compatibility.json`**: R8, C3 and
  the store fragment.
- **Fragments only**: R9 and R10. The verification itself stays valid only if no code
  changes. The release PR still re-verifies on merge.
- **Scope (artifacts or features included)**: re-read the conditional table and the notes'
  supported claims.

## Blocking gaps, decisions and recommended sequence

**Blocking gaps for any candidate**

1. No Desktop packaging run since `v0.6.0`, and none on the current builder, updater or
   Electron (R5).
2. No current App smoke/type-proof dispatch with `ref` on the candidate (R6).
3. Notes do not yet say that desktop artifacts are unsigned (R10).
4. No release milestone or prepare path exists (R11).
5. The new store and compatibility statement needs review by its owners (R8).

**Decisions that depend on scope (repository owner)**

- D1: which artifacts ship (Windows, Linux, and whether the unvalidated Mac files stay
  attached) and the wording for unsigned and unvalidated builds.
- D2: whether `ORCA_FEED_HOST` is set when the release merges (C4), and whether installed
  epoch-refusal evidence (C3) is required or stated as unverified.
- D3: how the notes describe the MCP operator (single-owner only, with #392 open rows
  stated). How to reconcile #598's closed state.
- D4: the #521 residual disposition, and the bump label/version.

**Recommended sequence** (each step is the owner's to take, and none is done here)

1. Settle D1–D4 on #773. Have the fragment authors resolve the flagged items.
2. Freeze a candidate head on `main`. Dispatch **Desktop** and **App smoke** (`ref` =
   head). Run #772 static inspection on those artifacts and, for the shipping platforms,
   C1–C3 installed checks.
3. Add the unsigned/unvalidated note (R10) and close or create the release milestone with
   bump labels.
4. Review the `release: vX.Y.Z` PR body as the notes. Confirm the feed variable choice.
5. Merge only when steps 1–4 hold. `release-publish.yml` then reruns R1–R7 on the merge SHA
   and publishes. If it fails, fix forward as RELEASING.md describes.

This document does not declare the release ready.
