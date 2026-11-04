# Readiness for the next private release after v0.6.0

**Status: not ready. Scope, version and candidate are not frozen.** Reconciled on
30 October 2026 against
`main` at `267be3e50fe3839f50aeff425e3af3ef6e2999c7`, tracked by
[#773](https://github.com/cschadewitz/Project_Orca/issues/773). It records what a candidate
has to pass, what depends on which artifacts and features are selected, and what stays
deferred. It chooses no version, date or candidate. Nothing here was tagged, published,
uploaded, deployed or dispatched. Apple Silicon/macOS acceptance (M25) is out of scope.

The release mechanics are [RELEASING.md](../RELEASING.md). Update and store-compatibility
operation is [UPDATING.md](../UPDATING.md). This document does not restate either. It
records the gates for a future candidate. The 27 October inventory and changelog counts
below retain their original `4d5176c` baseline; they are not a new whole-history audit.
Unrechecked issue dispositions remain dated observations, not current acceptance.

## Reconciled work and remaining acceptance

The verified main reference is **not a selected candidate**.
[CI run 41007719795](https://github.com/cschadewitz/Project_Orca/actions/runs/41007719795),
[job 123906378269](https://github.com/cschadewitz/Project_Orca/actions/runs/41007719795/job/123906378269),
checked out `267be3e50fe3839f50aeff425e3af3ef6e2999c7` and passed typecheck, token freshness,
format, lint, build, full coverage tests and compiled CLI smoke. The log selected full
testing and required `ORCA_MCP_REQUIRE_PRODUCTION=1`: 572 test files passed, 5 skipped;
9,829 tests passed, 36 skipped and 1 todo. The separate CLI/ACP retry step passed both
named files and both tests with **none skipped**. Full-suite skips do not establish the
acceptance they skip. This same job records 14 onboarding tests, 24 store-rehearsal
tests and 13 context-recovery tests passing. CI does not launch or package Electron.

| Existing work | Verified merged evidence | What remains separate |
| --- | --- | --- |
| [#786](https://github.com/cschadewitz/Project_Orca/issues/786), onboarding preparation | [#790](https://github.com/cschadewitz/Project_Orca/pull/790), merge `a4e0fd44e2a112129034e2f4c9b33a7c95c6db99`, reviewed head `e41484e33ac2b4046333ff71d292cbf8ae1f77db`; 14 focused offline tests reported after #792 correction | All candidate fill-ins and [coordinator gates G1–G9](../preparation/private-candidate-windows-linux/coordinator-checklist.md#2-gates-before-anyone-receives-the-guide); no packaged Windows/Linux walkthrough, tester consent or distribution acceptance |
| [#787](https://github.com/cschadewitz/Project_Orca/issues/787), store-rehearsal preparation | [#789](https://github.com/cschadewitz/Project_Orca/pull/789), merge `d791451f8de5c59cfd862f679651376abbed99cf`, reviewed head `f5801acd3921205917dedaa0b34d819f9a9cab41`; 20 focused tests reported after #791 correction; source/offline/synthetic evidence | [Installed rows IL1–IL3 and IW1–IW3](../preparation/store-compatibility-rehearsal/README.md#5-installed-windowslinux-rehearsal-prerequisites-and-expected-evidence), all desktop W rows, cross-epoch procedure and notes decisions; no installed upgrade/restore acceptance |
| [#357](https://github.com/cschadewitz/Project_Orca/issues/357), required context load | [#801](https://github.com/cschadewitz/Project_Orca/pull/801), merge `267be3e50fe3839f50aeff425e3af3ef6e2999c7`, reviewed head `ab3bd2d816f37913a37047b9de175c7dc8f87658`; 33 focused and 1,042 broader tests reported with declared dependencies | Opt-in protocol-load refusal boundary only. Native checkpoint identity/completeness, restart/compaction fidelity, durable Continue, fresh authorization and uncertain effects remain unaccepted; no provider-support or retention promise |
| [#772](https://github.com/cschadewitz/Project_Orca/issues/772), artifact preparation | Issue remains open; [#779](https://github.com/cschadewitz/Project_Orca/pull/779) is the existing preparation PR, not a merged or candidate-bound receipt | Static inspection against exact artifact bytes and all selected native/runtime rows remain required. No review retry is performed here |

The #786/#787 acceptance lists ask for preparation documents, focused offline checks and
a draft PR reporting limits. Their merged preparation can be marked complete on that
basis alone; issue closure must not close C1–C3 or G1–G9. #773 remains the audit owner.
Existing [#794](https://github.com/cschadewitz/Project_Orca/pull/794) already proposes
private-beta release guidance; it is unmerged in the inspected inventory. This update
adds no competing guidance issue and performs no review/approval of that PR.

The connected GitHub jobs/logs verify the CI receipt above. A read-only CLI attempt to
list Desktop runs returned `Forbidden`; App smoke enumeration was not reached. No retry
or alternate route was used for that listing. Accordingly R5/R6 record missing reviewed
receipts and historical references, not an assertion that no newer run exists.

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

Pre-merge testing needs an explicitly selected build identity, including its producing
run/attempt and artifact hashes. Final release verification runs on the release merge
commit (`release: vX.Y.Z` merged into `main`). No such candidate is selected here.
`release-publish.yml` runs the first group against that exact SHA. The rows marked
*before merge* exist because a failure there leaves the version bump on `main` with no tag
(see RELEASING.md "fix forward").

| # | Check | Owner / dependency | Exact evidence source | State reconciled on `267be3e` | Rerun when |
| --- | --- | --- | --- | --- | --- |
| R1 | Typecheck, design-token freshness, format, lint, build on the release merge SHA | Release owner; `release-publish.yml` job `check` | That job's log for the merge SHA | Main CI [run 41007719795](https://github.com/cschadewitz/Project_Orca/actions/runs/41007719795) passed on `267be3e`; reference evidence only, not release-merge acceptance | Any commit change |
| R2 | No-skip CLI/ACP retry acceptance: both named files run, every test passes, zero skips | same; parity enforced by `tools/test/release-workflow.test.js` | Step "Retry admission acceptance (CLI and ACP)" printing `none skipped` | As R1; both named files and 2 tests passed, none skipped | Any commit change |
| R3 | Full suite with production MCP acceptance required (`ORCA_MCP_REQUIRE_PRODUCTION=1`), after build | same | Step "Test with coverage" in current main CI; corresponding production-MCP release check | As R1; full mode with production MCP required, with suite skips stated above | Any commit change |
| R4 | Compiled CLI smoke: `node packages/cli/dist/main.js demo` | same | Step "Smoke test the compiled build" | As R1; compiled demo step passed | Any commit change |
| R5 | Desktop artifacts on Linux (self-hosted x64), macOS and Windows runners, including "The bundled daemon answers authenticated hello" | Release owner; `desktop.yml` (reusable) | `desktop` job of the release run; *before merge*: a `workflow_dispatch` of **Desktop** on the candidate head | **Open.** No selected-build Desktop receipt in this reconciliation. The original audit reported a failed 30 Sep run; current workflow enumeration is unavailable. Main CI is not packaging proof | Any change under `packages/`, the lockfile, `electron-builder.yml` or `desktop.yml` |
| R6 | Linux Electron smoke plus the Linux/macOS/Windows type-proof matrix | Release owner; `app-smoke.yml` with `ref` | `app-verification` job of the release run; *before merge*: dispatch **App smoke** with `ref` set to the candidate, so the classifier runs the full matrix | **Open.** Original audit references successful `408a21d` (25 Oct); no selected-build smoke/type-proof receipt reviewed here | Any renderer, design, font or app change; never update baselines inside the release run |
| R7 | Artifact identity: one version read once and stamped into every artifact; tag `vX.Y.Z` absent; Windows architecture assets collision-checked (`tools/deploy/release-assets.py`); `appId` `com.schadewitz.orca` with Windows `dev.orca.desktop` retained; `orca-daemon-X.Y.Z.mjs` present | Release owner | Release run steps "The version being released" and "Tag and release"; #772 helpers for per-file SHA-256 manifests once they exist | Unbound: no selected producing run/attempt, file list or SHA-256 manifest | Any rebuild. A rebuilt artifact is a new candidate even on the same SHA |
| R8 | Store and compatibility statement matches `release-compatibility.json` | Release owner; fragment authors | `### Store format` in the rendered notes against `release-compatibility.json` at the merge SHA | Drafted by the original audit; #789 source/synthetic findings qualify downgrade, first-open writes and updater paths. Owner wording review and candidate recheck remain | Any change to `release-compatibility.json`, store writers or protocol |
| R9 | Notes render and are reviewed as the release PR body | Release owner; all fragment authors | `node tools/release.js notes --unreleased`; later, the release PR body | 30 Oct render on `267be3e` plus this prose update: exit 0, no stderr, 888 lines. Rendering is not wording acceptance; original area-prefix findings remain historical; no release PR body accepted | Any fragment change |
| R10 | Release notes state unsigned/unvalidated scope and warning stop rules; no tester bypass instructions | Release owner | Rendered notes | **Open.** Candidate-specific wording depends on D1 and coordinator G5/G6; #790 tells testers to stop at warnings; #794 is unmerged guidance, not accepted release notes | Artifact scope change |
| R11 | A milestone with every issue closed and a bump label, or a manual **Release (prepare)** dispatch | Repository owner | `release-prepare.yml` | Not established in this reconciliation; no release milestone, bump or prepare dispatch selected | Scope change |

## Conditional on what is included

| # | Included if… | Required check | Owner / dependency | Evidence source | State |
| --- | --- | --- | --- | --- | --- |
| C1 | Windows NSIS/zip artifacts ship | Static inspection of artifacts (PE/manifest, NSIS, `latest-ARCH.yml`, SHA-512, blockmap; Authenticode reported "present, unverified"), then a clean install and launch, and the UPDATING.md Windows N→N+1 upgrade/failure/rollback on a native host | calciferschadewitz; [#772](https://github.com/cschadewitz/Project_Orca/issues/772) owns the plan and helpers | #772/#779 preparation and the candidate ledger below | Installed/static acceptance unverified for any selected candidate; #790 is onboarding preparation only |
| C2 | Linux AppImage/`tar.gz` ship | #772 static checks (ASAR entries, dev-package leaks, CSP/fonts, daemon version stamp), then a packaged launch | calciferschadewitz; #772 | #772 outputs; [2026-10-26-builder-vite.md](2026-10-26-builder-vite.md) for the local `tar.gz` baseline | Historical local `tar.gz` static baseline only; no selected-build packaged launch/onboarding receipt |
| C3 | The managed Debian updater or Windows feed serves this release to existing installs | Record the actual v0.6.0 updater path and any managed epoch refusal separately; exercise only an owner-decided migration and complete offline restore, or keep installed acceptance explicitly unverified | Release owner; UPDATING.md "Recovery and store compatibility" | [#789 rehearsal](../preparation/store-compatibility-rehearsal/README.md), then candidate-bound installed receipts IL1–IL3 / IW1–IW3 | Preparation merged; installed-unverified. Old Debian adapter stages to a 401 before epoch refusal; candidate adapter refuses cross-epoch activation. Direct/desktop opens do not enforce the marker, read-only first opens write, and no migration command exists. Windows v0.6.0 drives its own pre-#660 failure semantics. Restore requires the complete matching pre-upgrade state and binary/toolchain |
| C4 | Repository variable `ORCA_FEED_HOST` is set when the release PR merges | Decide before merge. `release-publish.yml` activates the private feed automatically after publishing, which reaches the existing feed audience. A new audience is out of scope | Repository owner | Release run step "Activate the private desktop feed" | Decision pending |
| C5 | macOS `.dmg`/`.zip` stay attached (`desktop.yml` builds them unconditionally) | Notes must say they are unsigned and unvalidated. The bundle ID changed from `dev.orca.desktop`, so an existing Mac install is not a validated upgrade path (RELEASING.md "Approved application identity"). All Mac acceptance stays in M25 | Repository owner | Rendered notes | Decision pending (D1) |
| C6 | Notes describe the MCP operator beyond single-owner use | #392 live missing/invalid-credential checks. Anything offering scoped access to other users or agents needs [#598](https://github.com/cschadewitz/Project_Orca/issues/598) actually passed | calciferschadewitz / repository owner; #327, #392, #598 | Issue receipts | Not passed. #598 is **closed "completed" with no passing evidence**, while #327/#392 (25 Oct) still call it deferred and not passed. Treat it as unpassed until its owner reconciles it |
| C7 | Notes mention providers, ReviewJudge or tool guards | Inactive profile/ReviewJudge/tool-guard wording stays "inactive / offline / proposal". #801 may be described only as an opt-in, provider-free-tested adapter boundary; no supported-provider or native-context-recovery claim | Fragment authors | Fragments for 70x | Checked by this audit. See below |
| C8 | Supply-chain claims, or #521 residuals are to be closed before release | Rerun `pnpm audit` on the candidate. Disposition for the residuals: Magicast's bundled `source-map-js` 1.2.1, `@electron/get` 3.1.0 in packaging, SLSA provenance unverified (trusted-root 403), packaged contents not yet inspected (overlaps #772) | calciferschadewitz; [#521](https://github.com/cschadewitz/Project_Orca/issues/521) | #521 comments (26 Oct): full audit 1 high → 0, prod 0 → 0 | Open, `status:review`, not labelled a blocker. Accept-and-state or fix is the owner's choice |

## Candidate evidence ledger (unbound preparation)

**4 November Windows desktop preparation:** the next personal desktop test targets
Windows 11 in a fresh workspace. Windows 10 compatibility testing is excluded;
Apple Silicon remains outside this release. This selects an OS/test scope, not an
artifact, architecture, version or final candidate. Existing-install update/restore
acceptance remains separate. The archive-format/review hold in #779 remains open;
its stopped investigation is not resumed by packaging preparation. Durable pending
approval and **Approved — Continue** recovery remain implementation/acceptance gaps
tracked in #357. The stopped independent guard controller is not restarted, and
the proposed narrower guard proof remains unapproved.

**No offered platform set or candidate has been selected.** These are conditional slots
from `packages/app/electron-builder.yml` at `267be3e`, not an offer or support claim.
Instantiate one record per actually offered platform/architecture/file type after D1;
record the tested OS version and native architecture separately from the build runner.
All **U** cells mean **unknown / unverified for a selected candidate**, never passed or
not applicable. The step IDs refer to the existing #772/#779 plan as consumed by the
merged coordinator checklist, and #789 section 5; they are pending evidence requirements.

| Possible combination; offering undecided | Artifact identity | Static inspection | Installation/extraction | Launch/shutdown | Onboarding | Update | Offline restore |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Windows x64 NSIS | U: exact installer, metadata/blockmap and hashes | U: #772 PE/native manifests, NSIS, feed hashes; trust unverified | U: W1–W3/W5, native trust observation | U: G3, W rows | U: G4 P1–P9/F1–F10, ACL checks | U: U1–U6 / IW1–IW2 | U: R1 / IW3 |
| Windows arm64 NSIS | U: distinct installer/asset identity | U: architecture-specific inspection and update metadata | U: native arm64 installation | U: native arm64, G3 | U: native arm64, G4 | U: U1–U6 / IW1–IW2 on arm64 | U: R1 / IW3 on arm64 |
| Windows x64 zip | U: exact archive and hashes | U: containment, ASAR, PE/native manifests | U: extraction/path checks; no installer inferred | U: native x64, G3 | U: zip-specific procedure must be reconciled before G4 | U: replacement/feed applicability undecided | U: whole-state restore; IW3 installer step alone does not cover zip |
| Windows arm64 zip | U: exact archive and hashes | U: architecture-specific archive/native checks | U: native arm64 extraction/path checks | U: native arm64, G3 | U: zip-specific procedure and native G4 | U: replacement/feed applicability undecided | U: whole-state restore plus retained matching zip/toolchain |
| Linux x64 tar.gz | U: exact archive and hashes | U: #772 containment/ASAR/CSP/fonts/daemon | U: L1 layout and ownership | U: L1, G3; CSP/fonts/shutdown | U: G4 P1–P6/F1–F10 | U: IL3; managed Debian is a separate path | U: matching whole-state/binary/toolchain restore |
| Linux arm64 tar.gz | U: distinct archive and hashes | U: architecture-specific static checks | U: native arm64 L1 | U: native arm64 L1/G3 | U: native arm64 G4 | U: IL3 on arm64 | U: native arm64 whole-state/binary/toolchain restore |
| Linux x64 AppImage | U: exact image and hashes | U: #772 image/static checks | U: L1/L3, FUSE and sandbox stop rules | U: L1/L3, G3 | U: G4 on each offered distribution | U: IL3; no managed update inferred | U: whole-state and matching image/toolchain restore |
| Standalone daemon / managed Debian, only if offered | U: exact `.mjs`, Node runtime, manifests, producing run/attempt and hashes | U: bundled identity/version and dependency closure | U: separately specified host install; desktop installation proves nothing here | U: exact bundle authenticated hello and shutdown | U: desktop F-steps do not cover daemon-only setup | U: IL1; IL2 depends on owner decision A2 | U: IL2 plus complete backup, matched binary and pinned Node |

Linux arm64 AppImage is not configured. macOS artifacts may still be built by the
workflow, but their inclusion remains D1; native Mac acceptance stays in M25 and is not
assessed by this ledger. An x64 run cannot satisfy arm64 acceptance.

Each future record must contain:

- **Identity:** full source SHA, version, workflow URL, run ID and attempt, build target,
  file names/size/SHA-256, independently recomputed hashes and version-stamp evidence.
  Bind the manifest and static report to the exact bytes; include update metadata,
  SHA-512 and blockmaps when applicable. Rebuilds get new records even on the same SHA.
- **Stage receipts:** a separate result, date, observer, exact OS/architecture, sanitized
  evidence link and unperformed checks for static, install, launch, onboarding, update
  and restore. Record blocked/refused/failed/unknown outcomes distinctly. Only mark a
  stage not applicable after the scope owner records the reason. Embedded Authenticode
  data means present/unverified until native trust evidence exists.
- **Store boundary:** pre-first-open consistent backup of the complete workspace/config,
  store, app `userData` and relevant authentication state, retained matching old binary
  and Node/toolchain, manifest equality before old startup, post-backup writes and
  partial/mixed-restore rejection. Keep private state and raw logs outside the repository;
  commit only sanitized, public-safe receipts. Binary replacement is not store rollback.
- **Handoff:** G1–G9, unsigned Windows participation, support/retention/deletion policy,
  approved testers and consent remain explicit decisions. Keep personal records outside
  the repository. Guidance preparation and source-built receipts do not check these boxes.

The existing issues own the gaps: #773 owns scope and this ledger; #772/#779 owns artifact
preparation and candidate inspection; #786/#790 provides onboarding preparation;
#787/#789 provides store-rehearsal preparation. No duplicate issue or installed-acceptance
closure is created. #801 supplies neither installed platform acceptance nor native context
recovery acceptance. No candidate, platform, retention period, upgrade promise or date is
chosen here.

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

## Changelog audit (27 October baseline)

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

**Rechecked against current source**

- `331-admission-retry.added.md`: rechecked against `main` at
  `d89cf92b4154483c07fdef25d5c6f87290e32eef`; replaced the separate-integration-patch
  wording with the current conditional availability. The
  [CLI wiring](https://github.com/cschadewitz/Project_Orca/blob/d89cf92b4154483c07fdef25d5c6f87290e32eef/packages/cli/src/commands/index.ts#L1104-L1119)
  requires writable token mode, retry claims, direct admissions and Request submissions;
  [daemon authority binding](https://github.com/cschadewitz/Project_Orca/blob/d89cf92b4154483c07fdef25d5c6f87290e32eef/packages/daemon/src/server.ts#L607-L632)
  also requires the workspace binding. The
  [method table](https://github.com/cschadewitz/Project_Orca/blob/d89cf92b4154483c07fdef25d5c6f87290e32eef/packages/daemon/src/methods.ts#L907-L927)
  and [`hello` capabilities](https://github.com/cschadewitz/Project_Orca/blob/d89cf92b4154483c07fdef25d5c6f87290e32eef/packages/daemon/src/methods.ts#L392-L400)
  require control, retry and authority services;
  [`runs.start`](https://github.com/cschadewitz/Project_Orca/blob/d89cf92b4154483c07fdef25d5c6f87290e32eef/packages/daemon/src/methods.ts#L638-L652)
  shares that admission path when wired. This agrees with the
  [protocol prerequisites and grants](https://github.com/cschadewitz/Project_Orca/blob/d89cf92b4154483c07fdef25d5c6f87290e32eef/packages/protocol/README.md#L301-L302).
  Source reconciliation only; no native/platform or candidate acceptance is established.

**Flagged for fragment authors, not changed**

- 49 `added`/`changed`/`fixed` fragments have no `**area:**` prefix. Examples are 331-*,
  387-*, 394-*, 483-*, 49x-*, 571-*, most 702-*/703-* and `operator-windows-sync`.
- `703-candidate-owned-read-verifier.added.md` covers `tools/` and docs only and renders a
  `#### tests` heading. The author should decide whether it belongs in user notes.
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

1. No selected-build Desktop receipt reviewed here (R5); latest workflow enumeration
   is unavailable. Packaging and native acceptance remain open.
2. No selected-build App smoke/type-proof receipt reviewed here (R6).
3. Candidate-bound unsigned/unvalidated wording and tester stop rules need review (R10).
4. Release milestone/bump or prepare-path decision remains unestablished (R11).
5. The new store and compatibility statement needs review by its owners (R8).

**Decisions that depend on scope (repository owner)**

- D1: which artifacts ship (Windows, Linux, and whether the unvalidated Mac files stay
  attached) and the wording for unsigned and unvalidated builds.
- D2: feed disposition (C4), installed C3 required or stated unverified, the cross-epoch
  Debian procedure (#789 A2), and accurate first-open/downgrade/Windows updater wording.
  No working automatic cross-epoch upgrade or rollback promise follows from preparation.
- D3: how the notes describe the MCP operator (single-owner only, with #392 open rows
  stated). How to reconcile #598's closed state.
- D4: the #521 residual disposition, and the bump label/version.
- D5: coordinator support route, retention/deletion policy, approved tester consent, tested
  OS/architecture scope and unsigned Windows participation (G6). No values are chosen.

**Recommended sequence** (each step is the owner's to take, and none is done here)

1. Settle D1–D5 on #773 and the coordinator checklist. Have the fragment authors resolve
   the flagged items.
2. Freeze a candidate head on `main`. Dispatch **Desktop** and **App smoke** (`ref` =
   head). Bind the ledger to those exact build bytes. Run #772 static inspection and, for each
   offered combination, install/launch/onboarding and applicable C1–C3 update/restore
   checks. Installed C3 and the manual cross-epoch path remain owner decisions.
3. Add the unsigned/unvalidated note (R10) and close or create the release milestone with
   bump labels.
4. Review the `release: vX.Y.Z` PR body as the notes. Confirm the feed variable choice.
5. Merge only when steps 1–4 hold. `release-publish.yml` then reruns R1–R7 on the merge SHA
   and publishes. If it fails, fix forward as RELEASING.md describes.

This document does not declare the release ready.
