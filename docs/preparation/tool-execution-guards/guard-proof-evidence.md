# Guard-proof preparation — evidence record (8 November 2026)

Implementation commit `9469ff67a710dad8a070ec58b84d71907658a4f3` (tree
`c648206e4bdc76fb941e93be4e34669a8781c253`) on `claude/project-thread-7med65`,
parent main `c41c878170767f122107558d2d719e428661eb73`. This record is added in
a following documentation-only commit. See the [gap matrix](guard-proof-gap-matrix.md),
the [identity matrix](guard-proof-identity.json) and the
[draft exact-run plan](guard-proof-exact-run-plan.md).

**No live observation ran. No candidate image was executed. Nothing is
qualified, designated, authorized, activated, deployed or published.**

## Status of the three required results

| Result | Implemented | Simulated | Observed | Production-qualified | Exact blocker |
| --- | --- | --- | --- | --- | --- |
| Save = 0 | Checker (`journal.require_lane_counts`) | Yes: synthetic journal gives zero invocations, reads, executions, answers, deliveries and effects; injected Save effects, answers, deliveries, invocations and dispatches refuse | No | No | G1–G5 and G7 of the exact-run plan, then Casey's authorization of a frozen plan |
| Allow Once = 1 | Checker | Yes: one `require-human` evaluation, one `allow_once` answer, ack, native delivery, one `human-once` permit consumed once, one dispatch of the exact action, one observed read; `allow_always`, remembered rule, rule permit, lost/late ack, duplicate dispatch refuse | No | No | Same, plus G4 (original bootstrap-to-connected lineage) |
| Fresh rule = 1 | Checker | Yes: different invocation and turn, `allow` attributed to rule id and revision, no callback/answer/delivery, one `rule` permit, one dispatch, one observed read; stale revision, other rule, policy revision drift, added human confirmation refuse | No | No | Same |

Separately, the existing in-process producer tests (real ORCA code, synthetic
environment, no containment, no independent observer) pass; see below. They are
code-level evidence, not observation of an exact run.

## Commands and results

All on this cloud host: Linux 6.18.44-fc-v310 x86_64, Node v22.23.4, Python
3.13.18, pnpm 12.4.2, `pnpm install --frozen-lockfile` (8.1 s, exit 0).

| Command | Result |
| --- | --- |
| `cd tools/guard-qualification && timeout 180 python3 check_offline.py` | 62 tests OK, 0 skipped, 2.8 s |
| `cd tools/guard-qualification && timeout 180 python3 -O check_offline.py` | 62 tests OK, 0 skipped, 2.7 s |
| `ruff check --select E,F,W,B --line-length 120 tools/guard-qualification` and `flake8 --max-line-length 120` | Clean after fixes (initial run: 6 long lines, 3 loop-closure warnings in tests) |
| `cd tools/owned-read-proof && python3 [-O] -m unittest test_controlled_contract test_observer` plus the three non-tracer `test_cleanup` cases | 31 OK normal, 31 OK optimized. The real-tracer cases were not run (same exclusion as #809's selector) |
| `pnpm run typecheck` | Pass (10 s) |
| `pnpm run design:check` | Pass |
| `pnpm run format:check` | Pass (28 s) |
| `pnpm run lint` | **First attempt failed**: ESLint aborted with a JavaScript heap out-of-memory error after 55 s (exit 134). Retry with `NODE_OPTIONS=--max-old-space-size=8192`: pass (73 s), including the CSS token check |
| `pnpm run build` | Pass (6 s) |
| `pnpm test` (Vitest, whole suite) | **Failed**: 4 failed, 10,054 passed, 36 skipped, 1 todo; 582 files passed, 2 failed, 5 skipped; 671 s |
| Same two failing files on pristine main `c41c878` in this checkout | Same 4 failures, so pre-existing on this host: `tools/test/ci-shadow-selection.test.js` (3, expects a Node 24 runtime) and `packages/app/test/first-run.test.ts` "refuses denied selection without writing files" (1; this host runs as root, so a permission denial does not occur) |
| `vitest run` of the five `packages/cli/test/controlled-owned-read*.test.ts` / `controlled-standing-workflow.test.ts` files (in-process real producer code; no containment, no independent observer) | 5 files, 115 tests passed, 449 s (also inside the full-suite run) |
| `node tools/owned-read-proof/build-controlled.mjs <new dir>` on main | Built, never launched; outputs recorded in the identity matrix |

The Python tests in `tools/guard-qualification` are not part of ordinary CI.
`ci.yml` runs only for pull requests to and pushes on main, so pushing this
branch produces no CI run; exact-head CI needs a pull request, which is Casey's
decision. Ordinary CI and the app smoke workflow would not be guard
qualification in any case.

## Mandatory historical tests

The separated historical physical tests (`test_controlled_image_pins.py`,
`legacy_image_pin_controls.py`) and #809's explicit non-live selector exist only
on #809's branch, not on main. This branch does not modify or remove them. They
were not executed here: the required historical fixture
(`ORCA_LEGACY_IMAGE_FIXTURE`, a frozen SOURCE `3fce8bcc` checkout) is not
present on this host. That is reported as not run, not as a pass or a skip.

## Independent review

Not obtained. The environment of this task offered no way to start a separate
reviewer, and no other reviewer has seen the diff. The author's own pass over
the code found and fixed: a phase-boundary authority check whose statement
digest was not validated (found by a new test), duplicate-key refusals masked as
malformed, empty trust roots accepted by the verifier constructor, caller-set
authority fields accepted by `public_summary`, raw `OSError` escaping
`file_digest` and `PrivateEvidence.write`, and process-uncertainty and body
failure sharing one flag (which skipped directory removal after an ordinary
refusal). A self-review is not independent review; an independent reviewer
must examine the diff and artifacts before any of this is relied on.

Known limitations for that reviewer: `public_summary` accepts short lowercase
tokens for descriptive keys (a bounded but not vocabulary-checked channel);
`ledger.spawn` pipes created by `subprocess` are owned by the `Popen` object, not
the ledger; containment has no seccomp or cgroup limits; the loader's boundary
is cooperative inside one V8 realm; the journal grammar is a proposal that the
producer does not yet emit.

## Artifact hashes (SHA-256 at the implementation commit)

| File | SHA-256 |
| --- | --- |
| `tools/guard-qualification/authority.py` | `428b779b403c1c93376e13483bb373e2ef717227a8e9db0298f84fbec20df088` |
| `tools/guard-qualification/bound-loader.mjs` | `af3dd413be87d3523f9055ecf7858f459568677dca9ec0c0e3d5cb1da1a2c9ca` |
| `tools/guard-qualification/bounds.py` | `b4420f62088a9db3c2ea4c4a003236100608c493e6a5749894c7de004c4d9bea` |
| `tools/guard-qualification/check_offline.py` | `f1813e9fefd9069e1bb86aae314c9532a953d0b8128b03bfce0abed3edfa5672` |
| `tools/guard-qualification/contained_preflight.py` | `7362cc6c289b17b0763f61e58971984482cf47b72991f6726d4972622137cde5` |
| `tools/guard-qualification/containment.py` | `320914a448d13a9721cf70a00c1b6990eef8a9418a77dbfec3bb1d24149a8297` |
| `tools/guard-qualification/identity.py` | `28231a6b3de778696054c61ff0856439e5a383e9280d8122038943dbca2a5da4` |
| `tools/guard-qualification/journal.py` | `79153a0da44c8d3d116e7b0b08fe29cbe3ad91758b8c17ab396550f231cf25bc` |
| `tools/guard-qualification/journal_fixture.py` | `bcd29b20a369565743e71f0ddab97f9ddd520ebe866c64165b4e5703bc390a64` |
| `tools/guard-qualification/ledger.py` | `d5e9828195392877258b968b2e0edf95bbc388633a377cdeb02d1416ffb93772` |
| `tools/guard-qualification/loader.py` | `789432deac866725c26352bb8a74b4c905545181e869d6fbd7cc4380f052a4f0` |
| `tools/guard-qualification/reasons.py` | `4d3c90e4e3242815f5075fa5d0860dc4a308eecca4a98fa9bd27f9b14feab598` |
| `docs/preparation/tool-execution-guards/guard-proof-identity.json` | `935070b01e6d2eff2418f418499c12417d183298f80c1227dbf25c56fc2ffdd9` |
| Unlaunched main image `controlled-producer.mjs` (2,248,585 bytes) | `b145543ef28899ba2e4a076e2fed6f3193260b3d2987103821cc23bef956bb31` |
| Unlaunched main image `controlled-child.mjs` (5,254 bytes) | `a58036e5343fe07dac8625f7d5dfc2a7e0c6bfe660ddb1e96711b5b8d002e35c` |
| Unlaunched main image `controlled-build.json` (48,711 bytes) | `9fd5294d059ded8cec9a36c0727163f95c8fbb6c0279a43fba3b5b2d1bf96ee8` |

## Decisions that need Casey

1. Whether to open a pull request for this branch (needed for exact-head CI).
2. Who performs the independent review of this diff and of the draft plan.
3. Key custody for exact-session authority (gate G5) and the qualification
   runtime (G6).
4. Authorization of a frozen exact-run plan, only after gates G1–G8 close.
5. How #809's owner integrates or supersedes these modules; #809 itself is
   untouched and still conflicts with main.
