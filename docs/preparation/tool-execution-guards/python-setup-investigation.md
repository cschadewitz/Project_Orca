# Non-live Python setup blockers: diagnosis and repair

This continuation starts at `c848c1903d3107a1b1ca8808c71af1a024088026`.
It changes evidence only. No production source, observer entry refusal, pin,
assertion, budget, workflow or package lock is changed.

The earlier failed selection remains a failed run: 512 top-level tests in
17.008 seconds, 511 passes, one missing-historical-fixture test error and one
current-image-inspection class-setup error. The earlier 80 focused passes are a
separate result. The [machine-readable investigation](python-setup-investigation.json)
retains exact source-key/hash differences, fresh source/harness inventories,
install and test log hashes, and output hashes. Passing [ordinary CI 41555758262](https://github.com/cschadewitz/Project_Orca/actions/runs/41555758262)
on `c848c190` (10,065 tests, as reported by the parent) does not qualify these
separate Python setup prerequisites.

## Exact current-image mismatch

The installed primary workspace lock did not match the committed workspace lock
document. Its SHA-256 was
`b72bf9d3931e93238fe90d709086426d6dfe29104b7c1bb0c45b102e55a04400`.
It selected ACP SDK **1.5.0** / Zod **4.6.5**; the committed lock and retained
current manifest require SDK **1.8.0** / Zod **4.6.7**. This is a measured stale
dependency installation, not an attribution based on Node version alone. Its
installation date, origin and responsible operation are not inferred.

Compared directly with `current-main-nonlive-build.json`:

- Expected: **387 inputs**, comprising 195 repository and 192 dependency inputs.
- Stale actual: **386 inputs**, comprising 195 repository and 191 dependency inputs.
- All **281 shared exact path keys** have equal hashes. The 106 expected-only and
  105 actual-only paths belong entirely to the version-qualified SDK/Zod trees.
- After removing only version-qualified package-store prefixes for comparison,
  **180 dependency inputs are byte-identical**, **11 differ** (seven SDK and four
  Zod files), and the new SDK adds `dist/stream-limits.js`. Full old/new logical
  paths and SHA-256 values are in the JSON evidence.

The correct current manifest is `current-main-nonlive-build.json`.
`controlled-currentness-composition-frozen-build.json` is the separate historical
manifest, not a replacement for the current pin.

The documented Node 24.21.0 binary and pnpm 12.4.2 entry remain available, with
exactly the recorded hashes `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`
and `b6e13402c88a275f5b1ec4fb420df8763179bbe9f2b87a10911be44a3622d68d`.
A separate detached current checkout received its own normal frozen install;
policy verification remained enabled, and only Electron's binary download was
omitted per DEVELOPMENT. The install passed in 15.4 seconds. Its installed lock
is semantically identical to the committed workspace document and its installed
lock hash is the previously recorded
`a2077f20668fef13914cac77e73f0113d9b2783706f0ebec025f3aa7863e220f`.
All 195 repository and 192 dependency bytes match the retained manifest.

Its new unlaunched outputs reproduce the unchanged current pins exactly:

| Output | Bytes | SHA-256 |
| --- | ---: | --- |
| controlled-build.json | 48027 | `889bd46eeec3bf3133bea022591d23ad4a627b2e7bfc73d71fd8c4ecc971d977` |
| controlled-producer.mjs | 2248652 | `1c0bffce70e7bb70245962590f2f291b68b6afdd35078caa5fd25fbd573e5ff7` |
| controlled-child.mjs | 5713 | `17fdd509f6702c70229c95df53d669754118379e09ab4d26912466859f102f13` |

After preserving the stale installation evidence and prior baseline dependency
copy, the primary checkout also received its own normal frozen install, passing
in 6.1 seconds. Its lock now matches the committed workspace lock. No lockfile,
package version, pin, source selector or assertion was edited to obtain equality.

## Historical fixture availability and fresh reproduction

At investigation start the documented `/workspace/orca-legacy-image-fixture` and
`/tmp/orca-current-main-evidence` were absent. Git registered only the primary
checkout and the earlier comparison baseline worktree. No original historical
fixture or original observed image was recovered; this environment did retain
the historical Git source and documented toolchain. Why the earlier fixture was
not retained is not established.

The parent explicitly authorized the fresh-fixture protocol in
[current-main-separated-image-tests-handoff.md](current-main-separated-image-tests-handoff.md).
A new detached worktree at exact SOURCE
`3fce8bcc9afd381cd07c0e06051921307d6322b3` received its own frozen installation,
with normal supply-chain checks, passing in 14.2 seconds. Current dependencies
were not copied into it. Its historical workspace lock and installed lock match
semantically; their hashes and separate historical image hashes are recorded in
the JSON evidence. A fresh unlaunched build equals the retained historical
manifest, with 194 repository plus 192 dependency inputs.

Before copying the current Python harness, 199 protected historical Git inputs
were verified, and the copy list was checked disjoint from all declared image
sources plus the builder, child, lockfile, package manifest and tsconfig. Exactly
62 current Python files and the one historical reference manifest were copied
and inventoried separately. The real wrapper repeats the exact HEAD, protected
Git input, disjointness and complete harness-byte checks before executing the
seven original historical controls. No source checker acceptance or pin assertion
was mocked or bypassed; existing synthetic closure callbacks supply no runtime
authority. This setup repair leaves the test method bodies unchanged from
`c848c190`; the current harness already differs from raw historical SOURCE.

This is a genuine fresh historical source/dependency test fixture. It is a new
physical instance and supplies no original observation, loaded-code evidence,
bootstrap continuity or live authority.

## Verification with repaired setup

- Detached current validation checkout: explicit `check_nonlive.py`, with the
  documented Node and fixture, passed **527 top-level tests plus seven historical
  child tests**, in 26.512 seconds (child subprocess 6.187 seconds), exit 0.
- Repaired primary checkout: optimized Python selection of
  `test_controlled_image_pins`, `test_current_image_inspection` and
  `test_source_sizing` passed **32 top-level plus seven historical child tests**,
  in 7.131 seconds (child subprocess 5.749 seconds), exit 0.
- A fresh invocation with `ORCA_LEGACY_IMAGE_FIXTURE` unset still fails with one
  test error and the original fixed missing-fixture message (exit 1, expected).
  Correct setup requires the explicit fixture parameter; no fallback was added.
- The missing-fixture negative, current-image/legacy-source rejection and source
  sizing refusals remain active. Full discovery and the real-tracer cases were
  not run. No whole-stack runtime or live qualification follows from these tests.

Reproduction uses the documented toolchain on PATH and the explicit fixture:

```sh
PATH=/workspace/.orca-tools/node-v24.21.0-linux-x64/bin:$PATH ORCA_LEGACY_IMAGE_FIXTURE=/workspace/orca-legacy-image-fixture timeout --kill-after=5s 180s python3 -B tools/owned-read-proof/check_nonlive.py
```

No host, SSH, VM260, pve2, live observer/tracer/provider or manual workflow work
occurred. Owner custody, private sink reservation, durable recovery, preventive
containment, loaded-code closure and complete original current-source kernel
replay remain unproven. The old uncertain PR-description write remains held.

## Independent review

Independent **gpt-6.1-sol, xhigh** review found no actionable setup finding. The
reviewer had the exact source and evidence files, independently verified all
195 current repository / 192 dependency and 194 historical repository / 192
dependency inputs, compared repository inputs to the exact Git commits, and
confirmed the 63-file harness/reference inventory is disjoint from all 199
protected historical inputs. All six recorded install/test log hashes matched.

As a controlled countercheck, it rebuilt the stale dependency tree under the
documented Node 24.21.0. That output remained byte-identical to the stale build
under Node 24.19.0. It separately rebuilt the repaired primary checkout to the
exact current pins. This distinguishes dependency content from Node alone.
Its own focused run passed **32 top-level plus seven historical child tests**
in 6.973 seconds (child 5.786 seconds), log SHA-256
`5a0881beceda53bba2df47d6b01cdf124562395700d7c071986d2b360b88d1e6`.

The review corrected an overly broad draft callback statement and clarified that
unchanged test bodies refer to this setup repair from `c848c190`, not equality
between the current harness and raw historical SOURCE. These prose corrections
are incorporated above. No checker, pin, assertion or launch boundary changed.
This review is non-live setup verification, not formal security qualification.
