# Separated current/historical image tests — no live proof

Base: `65f21c2d103cd129ed839c47397608c0dc46e3e9` on
`prep/706-current-main-nonlive`. The parent reviewed this independently validated
three-file candidate and approved non-force publication to draft PR #809.
The passing CI run `41273901932` belongs to the base; exact-head CI for this
publication must be reported separately. Test file hashes below identify the
reviewed implementation independently of this publication-status update.

## Exact test change

`test_controlled_image_pins.py` now builds the current image and verifies actual
input/output correspondence, rejects that image through the unchanged legacy
source checker, timestamp binding and designation constructor, and invokes a
mandatory separate historical fixture. Missing fixture configuration fails,
rather than skipping historical coverage. An explicit test also rejects using
the current checkout as the historical fixture.

`legacy_image_pin_controls.py` retains all seven original test method bodies
unchanged (verified by AST comparison). Before any mutation, its class setup
requires the fixed SOURCE checkout, equality with the retained historical
manifest, and a successful call to the real source checker. Thus its identity,
stamp, digest, proof, plan, byte-tamper and same-byte/new-inode assertions are
reachable from a valid baseline. No checker acceptance is mocked.

The wrapper requires `ORCA_LEGACY_IMAGE_FIXTURE`, checks its HEAD against unchanged
SOURCE `3fce8bcc9afd381cd07c0e06051921307d6322b3`, compares the complete Python
harness inventory and bytes, and verifies all historical repository image inputs
plus child, builder, lockfile, package manifest and tsconfig against that commit.
The harness/reference paths must be disjoint from these inputs. It runs only the
historical unittest module in a bounded subprocess, propagating optimized Python
mode. A failed baseline or historical test fails the outer suite.

No production, checker, pin, build recipe, workflow or runtime limit changed.
The current unconditional `observe()` refusal is copied with the harness and
remains unchanged; the existing refusal tests still run in the current context.

| Candidate file | SHA-256 |
| --- | --- |
| `tools/owned-read-proof/test_controlled_image_pins.py` | `d6263b99d15625957cbd0b0cb7b7305fcda5f4e8963882b1b966b6de3b3ea5e7` |
| `tools/owned-read-proof/legacy_image_pin_controls.py` | `b9224daf6698aa6a66b4a1e368e47b95f1a669df34535a3e7b96ef09f31d15ca` |

## Separate source, harness and artifacts

Historical source/dependencies are installed in
`/workspace/orca-legacy-image-fixture`, a detached SOURCE worktree. Its own normal
frozen install passed in 9.7 seconds using Node 24.21.0 / pnpm 12.4.2 and unchanged
supply-chain checks. Its lock differs from current main; the installed workspace
lock was compared to the historical workspace lock document and matches.

Forty current Python harness files and the reference manifest were copied and
inventoried separately. No declared image/build input was overwritten. The
current validation checkout is `/workspace/orca-fence-validation`; it has frozen
current dependencies and these exact local harness bytes.

A new, unlaunched historical reference image is retained at
`/tmp/orca-current-main-evidence/legacy-reference-image`. It reproduces the
historical bytes but is a new physical instance, not an original observed image:

| Output | Bytes | SHA-256 |
| --- | ---: | --- |
| `controlled-build.json` | 47911 | `7363dcc4d83530f43744c7c031f3f9f054c21917b3ffc99d27725c3840634dc2` |
| `controlled-producer.mjs` | 2184692 | `b155c2ae67af5be2b74468b909911c1af0a9db7c7559d76f06bfd089168b99f6` |
| `controlled-child.mjs` | 5713 | `17fdd509f6702c70229c95df53d669754118379e09ab4d26912466859f102f13` |

Independent verification checked all 194 repository inputs against SOURCE Git
blobs and installed bytes, all 192 dependency inputs, all three output hashes,
and all 41 separate harness/reference entries with no overlap. The current image
is distinct and unchanged; its producer hash remains `1c0bffce70e7bb70245962590f2f291b68b6afdd35078caa5fd25fbd573e5ff7`.
The formatted repository manifest copy is also distinct from the native artifact
manifest; see the [formatting handoff](current-main-format-handoff.md).

## Validation and reproduction

From the prepared current validation checkout, with Node 24.21.0 on PATH:

```sh
ORCA_LEGACY_IMAGE_FIXTURE=/workspace/orca-legacy-image-fixture timeout --kill-after=5s 180s python3 -B tools/owned-read-proof/check_nonlive.py
cd tools/owned-read-proof
ORCA_LEGACY_IMAGE_FIXTURE=/workspace/orca-legacy-image-fixture timeout --kill-after=5s 60s python3 -O -B -m unittest test_controlled_image_pins test_current_main_preparation test_controlled_timestamps test_controlled_v2_semantics -v
env -u ORCA_LEGACY_IMAGE_FIXTURE timeout --kill-after=5s 15s python3 -B -m unittest test_controlled_image_pins.HistoricalImagePinControls.test_real_historical_source_and_physical_controls -v
```

The first command passed **352 top-level tests plus seven historical child tests**
in 39.664 seconds. The top-level count includes the historical wrapper; the child
count is reported separately. The optimized selection passed **38 top-level plus
seven historical child tests** in 16.192 seconds. The final command intentionally
failed with one error and an explicit missing-fixture blocker; it must not pass.
The four real-tracer tests remain excluded by the unchanged non-live selector.

To prepare a fresh historical fixture, create a detached worktree at the exact
SOURCE above and install its own dependencies with Node 24.21.0 / pnpm 12.4.2
using `install --frozen-lockfile` and normal supply-chain checks. In this saved
environment, the CLI is `/workspace/.orca-tools/node_modules/pnpm/bin/pnpm.mjs`;
the install used `--store-dir /tmp/orca-current-main-pnpm-store --state-dir
/tmp/orca-current-main-pnpm-state --reporter append-only` and DEVELOPMENT's
non-launch `ELECTRON_SKIP_BINARY_DOWNLOAD=1` setting. Do not reuse current-main
dependencies as a substitute for that install.

Copy the current `tools/owned-read-proof/*.py` files and only
`docs/preparation/tool-execution-guards/controlled-currentness-composition-frozen-build.json`
into their corresponding historical-worktree paths. First check that this copy
list is disjoint from the reference manifest's `sources`, plus child, builder,
lockfile, package manifest and tsconfig. The wrapper independently repeats the
disjointness, exact harness inventory/byte and Git-input checks before running.
Re-copy the harness after any local test edit; stale copies fail. Do not launch
the image, run full Python discovery, or use any historical launcher.

Independent reviewer `/root/independent_review` found and resolved a missing
current-image timestamp-binding negative check, verified all seven original
method bodies, and independently passed ten targeted outer tests including seven
historical child tests. It independently confirmed missing-fixture failure and
the artifact/input/harness hashes. No remaining findings within this bounded
scope; no formal security approval or whole-stack audit is implied.

Evidence is local under `/tmp/orca-current-main-evidence/`:

| File | SHA-256 |
| --- | --- |
| `separated-nonlive-final.log` | `9c1ec7af58b053850c60ef23dde656e9f2e807fe81b53d32147c76e7c397b5f5` |
| `separated-optimized-final.log` | `44f0f4ec69c999c7260e056b35274b173c0300660dd03b083ca18f824c57e546` |
| `separated-fixture-inventory.json` | `539478ca8e40e85f20950a08a3407dc05ad25c56d62f4a2515365faff1a4ca7f` |
| `separated-image-pins-independent-review.json` | `a2375f131938bf70567934a9c49b0908b69da4a3a43fda55e55aa94c497d5b46` |
| `legacy-image-independent-build-review.json` | `cb47fef9953bae47ae819e5c6a20d5e3d5d0d1f3d2c1f5404b83a28d3072c8f0` |

The former four failures are addressed locally by correcting test context, not
by accepting current source under a historical pin. Current-image designation,
connected current-source proof and live qualification remain unavailable.
The parent authorized publication after reviewing the local result. This does
not authorize current-image designation, formal approval, merge, tracer/observer
execution or activation. The historical fixture remains an explicit prerequisite
for the separate Python non-live selection; ordinary Vitest CI does not provision
or run that Python fixture and cannot substitute for its recorded evidence.
