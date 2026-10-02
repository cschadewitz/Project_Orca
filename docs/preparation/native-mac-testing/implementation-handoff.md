# Implementation handoff: packaged Mac testing

## Scope and source record

This is the documentation-only deliverable for
[#403](https://github.com/cschadewitz/Project_Orca/issues/403), under
[#388](https://github.com/cschadewitz/Project_Orca/issues/388).
Audited/fetched `origin/main`: `7abc2342aa672ee9d2f10d565ca4f8eb546184df`, 2026-10-02.
All changes belong only to `docs/preparation/native-mac-testing/`:

| Artifact | Receiving agent uses it for |
| --- | --- |
| [test-matrix.md](test-matrix.md) | Source-grounded gaps, MAC-01–16, automated/physical boundaries and story ownership |
| [harness-design.md](harness-design.md) | Artifact verification, isolated launch, runtime oracles, deadlines, evidence and cleanup |
| [fixture-contracts.md](fixture-contracts.md) | Proposed manifest, synthetic sample/gate/negative fixtures, reconciliation register |
| [manual-checklist.md](manual-checklist.md) | Consented non-contributor walkthrough and stop conditions |
| [evidence-template.md](evidence-template.md) | Exact identity, actual outcomes, safe retained diagnostics and unresolved failures |
| This file | Ownership, order, proposed commands and measurable exit criteria |

Read `AGENTS.md`, `CONTRIBUTING.md`, `docs/DEVELOPMENT.md` and `docs/ARCHITECTURE.md`
before implementation. Read `docs/design/RULES.md` before any later UI change.
No executable test, CI, runtime, manifest, signing, publishing or installation change
is authorized by this preparation. Do not operate on Macie's Mac without later approval.

## Inputs and blockers for implementation

1. #385/#402: freeze the v1 artifact contract proposed in
   [#405](https://github.com/cschadewitz/Project_Orca/pull/405) at
   `6de26739aea2a376a394c39448916f666f309da7` (read 2026-10-02), then provide immutable
   signed/notarized/stapled arm64
   DMG and ZIP with trusted checksums/build identity, approved access path, expected
   publisher and final security settings. Provisioning/account ownership is unknown;
   do not create credentials or substitute unsigned output.
2. #386: supported workspace/profile isolation, normal first-run selection and launch
   path, bundled credential-free sample, permission/preflight fixtures and documented
   daemon recovery. Current home default/read-only store chooser is not this contract.
3. #388: approved arm64 macOS GUI executor, automation compatible with unchanged signed
   artifacts, budget/retention decisions and safe identity/endpoint observations.
4. #387: paired signed versions, protected-state backup set and canonical upgrade/restore
   scenarios for MAC-16. Keep their implementation and recovery policy in that issue.
5. #390/#389: approved physical session, supported OS/chip matrix, user guide, support
   contact and separately approved real-agent prerequisites. Unknowns stay blocked.

Inspect [draft #397](https://github.com/cschadewitz/Project_Orca/pull/397) again before
implementation; observed head was `27411de95ad31f014097f31e8c8ff44f65769549`, OPEN/DRAFT
on 2026-10-02. Do not take its production identity/admission/authority wiring as shipped
or import peer branches into this handoff. Reconcile against the eventual merged source.

The hard-dependency direction remains #385 + #386 → #388; #385 → #387;
#385 + #386 + #387 + #388 + #389 → #390. #386 also depends on #318/#333/#334.
#402 and #403 exchange proposed contracts independently; neither preparation child
requires completion of the other. Missing production outputs do not block this draft.

## Proposed ownership, to freeze after review

Paths below are proposed future changes, not files created by #403. No shared file
has multiple implementation owners without an explicit integration review.

| Owner | Proposed files/surfaces | Boundary |
| --- | --- | --- |
| #388 | `packages/app/test/packaged-mac/{playwright.config,artifact-input,fixture,evidence,packaged-app.spec}.ts` | New artifact consumer, isolated lifecycle and assertions; no runtime import from engine |
| #388 | `packages/app/test/packaged-mac/fixtures/` and focused contract/cleanup tests beside harness | Synthetic inputs only; derive runnable sample adapters from #386's approved contract |
| #388 | `tools/test-packaged-mac.mjs` | Proposed verify/run/evidence command wrapper, explicit candidate and output roots |
| #388 | `.github/workflows/packaged-mac.yml` | Proposed artifact-consuming arm64 job; no build substitute, signing or publication |
| #385 integration owner | `.github/workflows/desktop.yml`, release workflows, `packages/app/electron-builder.yml`, packaging scripts | Delivery output/identity/auth-probe correction; #388 supplies consumer requirements, not a parallel writer |
| #386 integration owner | App main/workspace/onboarding, protocol observations and shipped sample resources | Coordinate with #397 and configuration/launch owners; avoid test-only runtime shortcuts |
| #387 | Upgrade/recovery implementation and canonical fixtures/docs | #388 invokes its verified procedure; does not promise a Mac automatic updater |
| #388 documentation | `docs/DEVELOPMENT.md` testing section, links from delivery docs after agreement | Add actual commands once implemented; this preparation keeps edits inside its own directory |
| #390/#389 | Physical acceptance records and user-facing Hub guide | Follow reviewed checklist; no personal evidence committed to source |

Reuse #213's visual assertions and #168's artifact production. Keep existing source
smoke/type-proof jobs distinct. No need to change root package scripts unless the final
command interface needs it; coordinate any shared manifest edit with delivery/onboarding.

## Ordered implementation and verification

1. Re-read shared task context, issue/PR states and merged code; record new audited SHA.
   Reconcile each [contract decision](fixture-contracts.md#reconciliation-register),
   assign its owner and freeze the manifest and sample schema with #385/#386.
2. Implement the manifest validator and cleanup/evidence boundary first. Test digest/
   identity mismatch, unsigned metadata, wrong architecture, placeholder/missing fields,
   path traversal, symlink escape, marker absence, PID reuse and secret-canary rejection.
   These are harness tests; passing synthetic data is not candidate acceptance.
3. Prove the actual signed app can be driven without security changes. Verify both
   packaged formats and actual arm64 processes. If automation fails, retain the failure
   and resolve native executor support before claiming automated launch coverage.
4. Implement MAC-02–12 runtime flows on the accepted #386 interfaces. Use UI writes and
   protocol observations, fresh/reused isolated profiles, and distinct workspaces. Add
   positive and negative authentication coverage without modifying the daemon's policy.
5. Run clean candidate verification and full packaged tests on the exact same artifact
   digests. Collect failure evidence on every exit, check cleanup and review redactions.
6. Hand the candidate, identity sheet, guide and evidence to #390 for separately approved
   physical checks; import #387's upgrade/recovery results by reference. Resolve blocking
   defects before cohort expansion. Never label manual checks executed by hosted CI.

Proposed commands below **do not exist yet**. The receiving agent implements this CLI
with absolute paths and fail-closed argument validation. `HARNESS_NODE` is an absolute
tooling runtime outside the product PATH, and `HARNESS_DIR` is the reviewed harness:

```sh
"$HARNESS_NODE" "$HARNESS_DIR/tools/test-packaged-mac.mjs" verify \
  --manifest "$CANDIDATE_MANIFEST" --artifact "$CANDIDATE_ARTIFACT" \
  --source "$CANDIDATE_SHA" --format dmg --arch arm64 --evidence "$EVIDENCE_DIR"
"$HARNESS_NODE" "$HARNESS_DIR/tools/test-packaged-mac.mjs" run \
  --manifest "$CANDIDATE_MANIFEST" --artifact "$CANDIDATE_ARTIFACT" \
  --source "$CANDIDATE_SHA" --format dmg --arch arm64 --root "$DISPOSABLE_ROOT" \
  --evidence "$EVIDENCE_DIR"
"$HARNESS_NODE" "$HARNESS_DIR/tools/test-packaged-mac.mjs" check-evidence \
  --evidence "$EVIDENCE_DIR"
```

Repeat with explicit ZIP artifact/format and new disposable root. Proposed exits: 0 only
when all required checks for that command pass; 1 for assertion/verification failure;
2 for invalid input or unavailable prerequisite. JSON results distinguish blocked
from fail. Never return 0 on skipped launch, missing signature or unavailable hardware.
The verify command must not launch; run must verify again and then execute required
automated rows; check-evidence validates completeness, size/redaction and cleanup fields.
None of these commands supplies a physical acceptance pass.

Existing implementation checks remain `pnpm run typecheck`, `pnpm run lint`, relevant
`pnpm test -- <test paths>`, `pnpm run build`, and separately dispatched smoke/type-proof
when affected. They do not replace the proposed packaged suite. For this documentation
PR, validate six files, local links, examples, issue mappings and `git diff --check`;
the repository intentionally excludes Markdown from Prettier.

## Exit criteria and next slice

#403: six complete linked documents, source/date recorded, all issue acceptance topics
mapped, examples explicitly proposed, unresolved inputs assigned, no out-of-directory
changes or execution claims; draft PR targets main and links child/parent.

#388 later: exact signed candidate for both formats; proven native arm64 execution;
MAC-01–12 automated oracles pass with authenticated owned daemon and credential-free
sample; applicable production keyboard/layout checks pass; failure diagnostics and
cleanup are demonstrated; no skipped launch/unsigned fallback; all manual-only limits
explicitly handed to #390. Manual native/TCC/sleep/restart results stay separate.

#390 later: real invited download, consented physical rows, one uncoached target-like
walkthrough, approved real-agent sample and #387 recovery evidence; supported matrix
recorded, launch/data-loss/security blockers resolved and remaining defects assigned.

The next implementation slice is #388's manifest validator plus isolated harness and
evidence/cleanup tests, followed by a signed-candidate automation feasibility check.
Final execution waits for #385/#386 outputs. Existing #385–390/#402 already own the
identified follow-up work; no duplicate issue is proposed by this preparation.
