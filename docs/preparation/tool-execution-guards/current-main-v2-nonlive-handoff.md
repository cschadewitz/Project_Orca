# Current-main v2 offline preparation — launch disabled

The offline grammar now models current main's standing-review v2 records while
preserving the existing authority, effect, scope and timing checks. This is still
**preparation with unresolved designation failures**, not end-to-end current-main
proof, an observation-ready image, or a merge recommendation. `observe()` refuses
unconditionally before image checks, probing or process creation.

## Source and change boundary

- Branch: `prep/706-current-main-nonlive` in `cschadewitz/Project_Orca`.
- Main pin: `f9e7225e59cfe6e83c539f2ce9922ad0677719f4`, confirmed unchanged during
  this continuation. The [original inventory](current-main-nonlive-handoff.md)
  retains all ten draft-stack pins and selective-integration decisions.
- First implementation/image source: `4ebf382fe6738bb11268b47b048a3d7c7a6f2586`.
- Prior evidence: `76019753e056461fd3a1b60ba7f459446f068a00`.
- Reviewed continuation implementation: `d2c1626c1b01f9dcac48753048fbdaf2c15c166c`;
  tree `04d0bf59062be15b74109710d35677ebc6bf168d`.
- This handoff is a subsequent documentation-only commit. Its commit identifies
  publication; the implementation and build remain pinned above.

The continuation changes nine Python preparation/test files. Production code,
producer/child TypeScript, builder, dependency lock, workflows and limits are
unchanged. The explicit boolean `standing_v2=True` selector is used only by
synthetic tests; default legacy semantics and connected-image source selectors
retain their original pins. It is not wired into the disabled launcher.

The v2 model requires exactly one standing-review record, binds it to the original
action, command, distinct designated reviewer/credential, binding, actor, lease,
and the first prior proof's reference and complete value. Closed record shapes,
source-order rule digest, exact v2 approval, Until-revoked disclosure and null
standing-rule expiry are checked. Publication causality and millisecond timestamp
boundaries follow the pinned producer. A distinct fresh action may receive the
source's fresh finite expiry; this does not extend the original action/human-action
expiry or owner/run bound. Save still has zero reads/answers, Allow Once remains
separate, and later execution requires fresh valid authority. Aggregate results
still carry no authority, accepting token or production eligibility.

## Build and independent evidence

The exact implementation was checked out at `/tmp/orca-current-v2-validation`.
An offline frozen install failed with `ERR_PNPM_NO_OFFLINE_META` for `@babel/types`;
the ordinary online frozen install then passed in 10.6 seconds with the same
dependency policy and lifecycle checks intact. No security denial was bypassed.
Node 24.21.0 and pnpm 12.4.2 were used. The installed workspace lock equals the
committed workspace lock document; the repository additionally has a pnpm tool
lock document, so their complete-file hashes appropriately differ.

A new test image was built at `/tmp/orca-current-main-evidence/v2-image`. All three
outputs are byte-identical to the prior frozen image:

| Output | Bytes | SHA-256 |
| --- | ---: | --- |
| `controlled-build.json` | 48027 | `889bd46eeec3bf3133bea022591d23ad4a627b2e7bfc73d71fd8c4ecc971d977` |
| `controlled-producer.mjs` | 2248652 | `1c0bffce70e7bb70245962590f2f291b68b6afdd35078caa5fd25fbd573e5ff7` |
| `controlled-child.mjs` | 5713 | `17fdd509f6702c70229c95df53d669754118379e09ab4d26912466859f102f13` |

Independent agent `/root/independent_review` reviewed all nine changed Python
files, ran all 13 v2 test methods, and found no blocking issue within this bounded
offline scope. It separately recomputed the three output hashes and verified all
387 declared inputs: 195 against exact committed repository blobs and 192 against
installed dependencies. It verified lock correspondence and prior-image equality.
It did not independently rebuild the image or perform a whole-stack audit or
formal security approval. Records: [source review](current-main-v2-nonlive-review.json),
[build verification](current-main-v2-nonlive-build-review.json), and
[checks with log hashes](current-main-v2-nonlive-checks.json).

The original three-member archive remains byte-identical evidence at
`/tmp/orca-current-main-evidence/current-main-test-image.tar`, SHA-256
`1680ef3d948299209a79e47b59afc686d7e6a6df7ee47475ab7712e31710b978`.
Artifacts and raw check logs are local to this saved environment; the repository
contains manifests and evidence summaries, not an uploaded release or live trace.

## Bounded checks and failure diagnosis

- Exact-commit frozen Python non-live selection: **354 run, 350 passed, one failure
  and three errors**, 31.158 seconds. The four real tracer cases remain excluded.
- Exact-commit optimized v2/refusal/timestamp selection: **33 passed**, 1.897 seconds.
- Independent v2 suite: **13 passed**, 0.944 seconds (overlaps the totals above).
- Producer tests: **51 distinct passed across two disjoint groups**, 26 previously
  in 50.98 seconds and the remaining 25 in 107.84 seconds. Seven protected Save
  regressions and 19 fdinfo tests passed previously: **77 distinct Vitest tests**
  across all selected groups. Their source bytes are unchanged at the new commit.
- Root/renderer typechecks and changed JS/TS lint/format passed in the prior frozen
  checkout; their inputs are unchanged. They were not rerun for Python-only changes.

The four failures are in `test_controlled_image_pins.ReviewedImagePinControls`:

1. `test_source_pins_and_rebuilt_input_correspondence_are_coherent` compares current
   producer input `9d96cddcbbc4ebe5c67657a94b7d219d534196db76cb440476f90c9d69ca0d4d`
   to legacy input `61d62d01d32057036ea3cd638fa6a04abcf3f0b04be9973ae3c1c24ee44295a8`.
2. `test_connected_original_source_build_bytes_and_plan_bindings_refuse_mixtures`.
3. `test_new_image_retains_physical_inventory_and_proof_associations`.
4. `test_retained_image_proof_and_same_bytes_replacement_refuse`.

The last three fail in their positive `ConnectedDesignation` setup: current
repository bytes differ from legacy source `3fce8bcc9afd381cd07c0e06051921307d6322b3`,
so `assert_image_sources` refuses before their later assertions. These are real,
unresolved compatibility failures; no assertion, source selector, skip or expected
failure was added to conceal them. The separate v2 synthetic model does not resolve
connected image designation or supply an observed kernel history.

Two earlier broad test attempts hit their unchanged 180-second outer timeout
without a complete report. The four successful subgroup durations sum to 203.38
seconds, supporting cumulative execution cost as the explanation. No individual
hang was reproduced; the exact historical timeout cause is not proven. Splitting
the remaining 25 tests completed coverage without raising a timeout, worker cap or
execution budget. The broad attempts remain timeouts, not passes.

Reproduce the new non-live checks from the frozen checkout with Node 24 on PATH:

```sh
timeout --kill-after=5s 180s python3 -B tools/owned-read-proof/check_nonlive.py
cd tools/owned-read-proof
timeout --kill-after=5s 60s python3 -O -B -m unittest test_controlled_v2_semantics test_current_main_preparation test_controlled_timestamps
cd ../..
timeout --kill-after=5s 180s node node_modules/vitest/vitest.mjs run packages/cli/test/controlled-owned-read.test.ts --maxWorkers=1 --reporter=verbose -t '^(?!.*(?:composition|composed|Save, separately|standing grant qualifies)).*$'
```

The first command still exits nonzero for the four documented failures. Do not use
full Python discovery: it includes real-tracer tests outside this authorization.

## Publication and remaining blockers

The parent/user clarified that Tyler availability addresses the automatic PR CI
concern. Inspection confirms `ci.yml` selects `[self-hosted,linux,x64,tyler]` after
a positive health result, otherwise `ubuntu-24.04`. DEVELOPMENT's resource-check
passage occurs in the manual desktop/homelab workflow context and does not name
Tyler; its earlier general hosted-only statement is stale relative to the workflow.
The earlier handoff's broader preflight assumption is therefore superseded. Draft
publication is authorized without dispatching a manual desktop/homelab workflow.
No runner policy, workflow, resource budget or repository variable was changed.
Actual automatic CI selection/status must be reported from the resulting run.

The branch was published non-force through evidence commit
`bc46cab321f015a89b74a8318f43a4b1a6c6e631`. The subsequent GitHub connector request
to create a draft PR against `main` was **denied by automatic approval review**:
it judged draft creation an external commitment and said the trusted user
messages did not explicitly authorize opening this PR or publishing its payload.
No retry or alternate route was attempted. A read-only follow-up search confirmed
no open PR for this branch. Draft creation remains blocked pending new explicit
authorization evidence; automatic PR CI was consequently not observed and no
actual selected runner can be reported. The prepared description is retained at
`/tmp/orca-current-main-evidence/draft-pr-body.md` in the saved environment.

Connected current-source designation and full current-source kernel replay remain
unproven. Callback/registry/review-handle/permit/dispatch identities retain their
exact-source assumptions. There is no full repository or monolithic suite pass,
native desktop proof, observation, activation or end-to-end acceptance claim.
No live observer/tracer/provider/device/daemon was launched by this preparation.
The prior denials for #779 security review, #793 merge and #794 formal approval
remain binding; none was retried. The draft-creation denial above is the only
automatic-approval denial in this continuation; earlier review/build records
pre-date that publication attempt.
