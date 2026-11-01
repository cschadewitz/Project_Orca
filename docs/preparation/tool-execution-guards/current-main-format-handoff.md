# PR 809 evidence formatting repair

The parent opened [draft PR #809](https://github.com/cschadewitz/Project_Orca/pull/809)
under explicit user approval after the previously recorded denial. The first
[CI run](https://github.com/cschadewitz/Project_Orca/actions/runs/41272363166), on
head `bcac6f14928966c2cd40e63dbe673f63ec5cc6ea`, ran `check (node 24)` on **tyler-3**.
Typecheck and design-token checks passed. Format failed on the three JSON files
below; subsequent lint/build/test/smoke steps were skipped, not passed.

This repair runs the frozen checkout's pinned Prettier on those three files. JSON
values and recursive key order are unchanged. The historical manifest consumer
in `test_controlled_image_pins.py` parses JSON before comparing values; its four
existing source-designation failures remain unresolved. There are no executable,
workflow, lockfile, timeout or authority changes. The unconditional observer
refusal remains in place.

## Repository copy hashes

Paths below are relative to this directory. These are **repository copy** hashes,
not replacements for physical artifact or original review-record hashes.

| File | Before bytes / SHA-256 | Formatted bytes / SHA-256 |
| --- | --- | --- |
| `controlled-currentness-composition-frozen-build.json` | 47911 / `7363dcc4d83530f43744c7c031f3f9f054c21917b3ffc99d27725c3840634dc2` | 50255 / `090f842e10e5e7f28a6599665f167b1df1f16457c1c45aa5ffb7eb858be87412` |
| `current-main-nonlive-build-review.json` | 3196 / `711fd2e5c9a79018e028130377c9eff785819c5ac5401f39dba87dee443b6b38` | 3112 / `f6ac931e759d35e81463e689f88b54f8ae4e7a76d137626612b1727f3d7e9fc6` |
| `current-main-nonlive-build.json` | 48027 / `889bd46eeec3bf3133bea022591d23ad4a627b2e7bfc73d71fd8c4ecc971d977` | 50377 / `cd73902b4a3ed8d5fb4003f2db9bab5b169b1aceedafb3bd067448690bb8116b` |

The first original is recoverable byte-for-byte from the pre-repair Git commit.
The original independent review remains at
`/tmp/orca-current-main-evidence/frozen-build-review.json`; its `711fd2…` hash in
`current-main-nonlive-review-resolution.json` still identifies that original local
file. It does not identify the now-formatted repository copy. Its review findings
were not changed or attributed to a new build.

The native manifest remains at
`/tmp/orca-current-main-evidence/frozen-image/controlled-build.json` and identically
in `v2-image/controlled-build.json`, with SHA-256 `889bd4…` as recorded in the build
identity/reviews. Those hashes still identify the original physical files, not the
formatted documentation copy. Producer, child, all build inputs, and archive are
unchanged; no new image was built. The artifact/source identities in the
[v2 handoff](current-main-v2-nonlive-handoff.md) remain applicable.

Local validation passed full-repository Prettier 3.9.10, JSON value/order equality,
physical artifact hashes, documentation links and whitespace. Independent agent
`/root/independent_review` checked the same evidence distinction, JSON values and
recursive key order, old/new sizes and hashes, both physical images, and archive
members. It found one stale byte-copy description, corrected before publication;
there were no executable changes. Runtime tests are not rerun for this
formatting-only repair; prior
test outcomes and limitations remain unchanged. Exact-head CI after publication
must be reported separately from the earlier failing run. No live proof,
activation, merge or formal security approval is implied.
