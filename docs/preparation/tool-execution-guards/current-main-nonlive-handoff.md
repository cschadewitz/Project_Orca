# Current-main guard/observer preparation — no live proof

> Historical first-stage record at `7601975`. The
> [v2 continuation handoff](current-main-v2-nonlive-handoff.md) supersedes its
> compatibility status, test totals, launch behavior and draft-PR hold below.
> The earlier assumption that the manual desktop/homelab resource preflight
> blocked automatic Tyler/hosted PR CI was too broad; draft publication is authorized.
> Original records and hashes below remain historical evidence.

This is a **blocked preparation candidate**, not an observation-ready image or
merge recommendation. It preserves current main's standing-grant behavior and
imports the draft observer/test work without granting that older observer
authority over the new source. A fresh frozen-dependency image was built and
independently hashed. Current-source observer designation still refuses.

## Exact source and selection

- Repository: `cschadewitz/Project_Orca`.
- Branch: `prep/706-current-main-nonlive`.
- Main: `f9e7225e59cfe6e83c539f2ce9922ad0677719f4`, rechecked at publication preparation.
- Reviewed implementation/build source: `4ebf382fe6738bb11268b47b048a3d7c7a6f2586`.
- Implementation tree: `e6c8fcc5263506ef406dec163da244248a070eaa`.
- Later evidence commits contain documentation/JSON only; the image identifies
  the implementation commit above, not an unbuilt later source revision.

[Inventory](current-main-nonlive-inventory.json) retains every fetched draft head
and base. All ten fetched heads were compared to GitHub metadata:

| Draft | Head SHA |
| --- | --- |
| [#748](https://github.com/cschadewitz/Project_Orca/pull/748) | `834ddf38be7ca2674a1e439e1fdfd711160531ff` |
| [#756](https://github.com/cschadewitz/Project_Orca/pull/756) | `d95a426131ae8072c1c0db3edcececc643ddb01a` |
| [#757](https://github.com/cschadewitz/Project_Orca/pull/757) | `4c4c52cb693bff2689debab062f3c83fa9640e1b` |
| [#762](https://github.com/cschadewitz/Project_Orca/pull/762) | `d5005fcb05e9a5c5b9e8bd5a50fd1008275d3e57` |
| [#765](https://github.com/cschadewitz/Project_Orca/pull/765) | `ba0002668c59c645b1cdc72df9aba94a8ca64ff5` |
| [#766](https://github.com/cschadewitz/Project_Orca/pull/766) | `2c746f1e5d31c7be14203d53a626166139e3b90a` |
| [#768](https://github.com/cschadewitz/Project_Orca/pull/768) | `3869aef0b3427c1b8ffc6fb0dbc1ef667917caad` |
| [#769](https://github.com/cschadewitz/Project_Orca/pull/769) | `434d29987f41e4b3b3d8ea550c58ea32af8de1b5` |
| [#781](https://github.com/cschadewitz/Project_Orca/pull/781) | `6a4d30dda73be89b90b7684a821d18768dcc2e14` |
| [#785](https://github.com/cschadewitz/Project_Orca/pull/785) | `6936e629e5230102af7d653cf8401f209d971b63` |

The stack was not merged. The final executable/test delta from its shared
`557f62f` ancestor through #785 was applied three-way to current main for only
`packages/cli/test/controlled-owned-read-producer.ts`, its tests, and
`tools/owned-read-proof/`. Those paths supply the finite kernel/semantic/Save
model, aggregate diagnostics, receipt association, fresh metadata checks and
currentness composition. Main's newer producer/test edits were retained.

Historical observation reports were not copied or relabeled. Their exact records
remain at the linked draft heads. The old
[composition manifest](controlled-currentness-composition-frozen-build.json)
was initially copied byte-for-byte solely because the inherited image-pin tests
reference it. The later [formatting repair](current-main-format-handoff.md) changes
only its JSON layout, preserving all values. It describes the historical image,
not this candidate.

No production `packages/*/src` code, package manifest, shared lockfile, workflow,
accepted-build registry, credential grant, diagnostic setting or execution limit
changed. The child never supplies main's existing long-lease unit-test option;
the observer's 55-second owner, 60-second process and 256-MiB trace bounds remain.

## Why current observation is blocked

Main #805 introduced protected `controlled-standing-review-v2` records, v2 Save
approval fields (`grantMode`, `reviewUntil`, `standingReview`), versioned standing
rules with `expiresAt: null`, an `Until revoked` disclosure/projection, and fresh
rule-action expiry. The old finite inventory, Save/delivery/aggregate grammar and
original-expiry comparisons cannot validate that model.

All three observer `SOURCE` constants intentionally remain
`3fce8bcc9afd381cd07c0e06051921307d6322b3`. Replacing them with the current commit
would falsely make historical synthetic v1 positives look like current proof.
The real `assert_image_sources` check rejects the current image before bootstrap
directory creation, tracer probing or producer launch. Five new refusal tests
exercise that boundary and v2 shape rejection. These are negative controls, not
a v2 model or evidence of observed effects.

Save still only persists approval; original Allow Once is separately settled;
later automatic use needs fresh valid action/credential/lease/permit authority.
The main-relative change composes the original physical/bootstrap assertions
without caching success or falling back after a failed assertion. Independent
source review and focused disposable tests cover these preservation claims.

## New test image

The retained image is `/tmp/orca-current-main-evidence/frozen-image`, built from
the exact implementation commit in `/tmp/orca-current-main-frozen`. It was never
launched. [Build identity](current-main-nonlive-identity.json) records the Node
binary, builder, tsconfig, lock and archive hashes; the complete native
[manifest](current-main-nonlive-build.json) was initially retained without
reformatting. The later [CI formatting repair](current-main-format-handoff.md)
formats that repository copy only; the native image manifest and its hash below
remain unchanged. The formatted copy has equal JSON values and a distinct hash.

| Output | Bytes | SHA-256 |
| --- | ---: | --- |
| `controlled-build.json` | 48027 | `889bd46eeec3bf3133bea022591d23ad4a627b2e7bfc73d71fd8c4ecc971d977` |
| `controlled-producer.mjs` | 2248652 | `1c0bffce70e7bb70245962590f2f291b68b6afdd35078caa5fd25fbd573e5ff7` |
| `controlled-child.mjs` | 5713 | `17fdd509f6702c70229c95df53d669754118379e09ab4d26912466859f102f13` |

The three-file archive is
`/tmp/orca-current-main-evidence/current-main-test-image.tar`, SHA-256
`1680ef3d948299209a79e47b59afc686d7e6a6df7ee47475ab7712e31710b978`.
Binary artifacts and full local test logs remain in the selected environment;
repository publication contains their identities/manifests, not a release.

The isolated install used Node 24.21.0 and pnpm 12.4.2 with
`install --frozen-lockfile`, writable temporary store/state directories and the
unchanged build-script policy. `ELECTRON_SKIP_BINARY_DOWNLOAD=1` follows
DEVELOPMENT's non-launch recipe. esbuild is 0.28.2, tsx 4.23.15, SDK 1.8.0,
Zod 4.6.7, Vitest 5.0.5 and TypeScript 7.0.2.

The independent reviewer rehashed all outputs and **387 inputs**: 195 repository
inputs against committed Git blobs and 192 dependencies against installed bytes,
plus the committed child. The installed workspace lock equals the committed
workspace YAML document completely. Whole-file hashes differ because the
repository also has a separate pnpm-tool document. Exact comparison and counts
are in the [independent build review](current-main-nonlive-build-review.json).

An earlier image in `/tmp/orca-current-main-evidence/image` used the saved,
outdated dependency installation. It is preserved as a failed provenance attempt
and is superseded by `frozen-image`; it is not relabeled a frozen build.

## Checks and independent review

[Check results](current-main-nonlive-checks.json) retain commands' local log paths,
SHA-256 digests, results, timeouts and exclusions. On the frozen installation:

- Non-live Python selection: **341 run, 337 passed, one failure and three errors**.
  All four failures are inherited `ReviewedImagePinControls` tests requiring
  successful historical image designation. They remain real failures, with no skip,
  expected-failure annotation, source-pin relaxation or synthetic qualification.
- Optimized Python current-main refusal/timestamp checks: **20 passed**.
- Focused producer composition/authority tests: **26 passed**, 25 unselected.
- Protected Save regression suite: **7 passed**.
- Lifetime fdinfo suite: **19 passed**. These total **52 distinct Vitest tests**.
- Complete root and renderer typechecks, changed JS/TS lint/format and diff
  whitespace checks passed.
- Two broad producer/review attempts (saved and frozen dependencies) exceeded
  their 180-second outer limits with no complete report. They are not passes.
  Their remaining process records were subsequently observed defunct under PID 1;
  no live test work remains in those groups. Focused retries used an explicit
  five-second kill-after cleanup bound in addition to their outer timeout.

The explicit [non-live selector](../../../tools/owned-read-proof/check_nonlive.py)
excludes the two real cleanup-tracer cases and the real interval/batched-transfer
cases. It includes synthetic grammar/crypto tests, real temporary file/FIFO
association tests, read-only self-process diagnostic controls, and real builds.
No fresh observer, tracer, daemon, provider, live device or installed app ran.
No full repository suite, coverage, native/platform smoke or CI pass is claimed.

Non-live reproduction from the frozen checkout, using Node 24.21.0 on `PATH`:

```sh
timeout --kill-after=5s 180s python3 -B tools/owned-read-proof/check_nonlive.py
cd tools/owned-read-proof
timeout --kill-after=5s 60s python3 -O -B -m unittest test_current_main_preparation test_controlled_timestamps
cd ../..
timeout --kill-after=5s 180s node node_modules/vitest/vitest.mjs run packages/cli/test/controlled-owned-read.test.ts --maxWorkers=1 --reporter=verbose -t 'composition|composed|Save, separately|standing grant qualifies'
timeout --kill-after=5s 180s node node_modules/vitest/vitest.mjs run packages/cli/test/controlled-owned-read-review.test.ts --maxWorkers=1 --reporter=verbose
timeout --kill-after=5s 60s node node_modules/vitest/vitest.mjs run packages/cli/test/controlled-owned-read-fdinfo.test.ts --maxWorkers=1
timeout --kill-after=5s 180s node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
timeout --kill-after=5s 60s node node_modules/typescript/bin/tsc -p packages/app/renderer/tsconfig.json --noEmit
```

The first command intentionally reports the unresolved compatibility failures;
its nonzero exit must not be treated as an instruction to relax source checks.

Separate agent `/root/independent_review` reviewed the main-relative
producer/child composition, current-main behavior preservation, source-check
ordering, new refusal tests and the connected v2 incompatibilities; it also ran
the five new tests independently. It did **not** fully audit the roughly 9,700
imported lines, perform a formal GitHub/security approval or independently rebuild
the image. See the [initial source review](current-main-nonlive-source-review.json)
and [frozen-build resolution](current-main-nonlive-review-resolution.json).
The reviewer subsequently checked this handoff, all eleven recorded log hashes,
the published evidence copies and all three archive members independently.

## Publication and remaining work

Preparation branch publication is authorized and does not match this repository's
`push: branches: [main]` CI trigger. A draft PR against main would trigger CI:
`ci.yml` can select a self-hosted runner through `runners.theroses.dev/health`, and
DEVELOPMENT requires a fresh CPU/RAM/load check before a new homelab job. This
environment has no verified runner preflight/access. Therefore PR creation is
**pending, not attempted or denied**. No workflow, repository variable, runner or
network policy was changed to route around that prerequisite.

Remaining blockers/actions:

1. **Current-source observer proof: pending compatibility work.** Build and review
   the finite v2 standing-review/approval/rule/currentness/expiry grammar with
   adversarial correlations before any coherent observer repin. Preserve Save's
   zero-execution behavior and fresh execution authority. The four historical
   image-designation failures are still open; do not treat this branch as green.
2. **Draft PR: pending runner preflight.** Perform the repository-required resource
   check in an authorized environment, then open a draft using the text below.
3. **Live observation/activation: not authorized by this checklist.** No historical
   run, hash, synthetic positive or build check supplies live proof. Any future
   observation remains separate and requires its applicable authority/review.

No automatic-approval denial occurred in this task. The earlier denials for #779
security review, #793 merge and #794 formal approval remain untouched. No main
merge, auto-merge, release, deployment or activation was attempted.

### Prepared draft PR text

Title: `test(guards): stage current-main observer preparation without live proof`

Current main's v2 standing grants differ from the draft observer's v1 proof
grammar. This candidate preserves main's Save-only persistence, separate Allow
Once and fresh execution authority while integrating the necessary test-only
producer/child/observer work. Legacy source pins deliberately refuse the new
image before observation; five new controls document that boundary.

A frozen-dependency test image has independent verification of all 387 inputs
and three outputs. Checks: 337/341 non-live Python tests pass (four historical
image-designation tests remain failing), 20 optimized controls and 52 focused Vitest
tests pass; both typechecks and changed-file lint/format pass. Broad test attempts
hit the 180-second bound. See `current-main-nonlive-handoff.md` for exact pins,
manifests, review limits and blockers. Draft preparation only: no live proof,
runtime designation, merge or activation.
