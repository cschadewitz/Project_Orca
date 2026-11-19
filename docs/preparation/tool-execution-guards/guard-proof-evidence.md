# Guard-proof preparation — evidence record (8 November 2026)

Original implementation commit `9469ff67a710dad8a070ec58b84d71907658a4f3`,
reviewed independently at `d67cdd2a`. Review-fix commit
`d8400d248a480a3a43855d4043d92021ab2c9bf9` (tree
`0c5cdc3730d8985ac0f9f08028915ab9de9e1651`) on `claude/project-thread-7med65`
(draft PR #824), base main `c41c878170767f122107558d2d719e428661eb73`. This
record is updated in a following documentation-only commit. See the [gap matrix](guard-proof-gap-matrix.md),
the [identity matrix](guard-proof-identity.json) and the
[draft exact-run plan](guard-proof-exact-run-plan.md).

**No live observation ran. No candidate image was executed. Nothing is
qualified, designated, authorized, activated, deployed or published.**

## Status of the three required results

| Result | Implemented | Simulated | Observed | Production-qualified | Exact blocker |
| --- | --- | --- | --- | --- | --- |
| Save = 0 | Checker (`journal.require_lane_counts`) | Yes: synthetic journal gives zero invocations, reads, executions, answers, deliveries and effects; injected Save effects, answers, deliveries, invocations and dispatches refuse; an observer that starts late, ends early, names another statement or is silent for more than 1 s refuses | No | No | No independent observer (G3), no authenticated stream custody, and `require_lane_counts` refuses every non-simulated call; then G1–G8 and Casey's authorization of a frozen plan |
| Allow Once = 1 | Checker | Yes: one `require-human` evaluation, one `allow_once` answer matched by a supervisor-sent answer, ack, native delivery, one `human-once` permit consumed once, one dispatch of the exact action, one observed read; `allow_always`, remembered rule, rule permit, lost/late ack, duplicate dispatch, uncorroborated answer or check refuse | No | No | Same, plus a reviewed supervisor-side human answer channel (G2) and G4 (original bootstrap-to-connected lineage) |
| Fresh rule = 1 | Checker | Yes: different invocation and turn, `allow` attributed to rule id and revision, no callback/answer/delivery, one `rule` permit, one dispatch, one observed read; stale revision, other rule, policy revision drift, added human confirmation refuse | No | No | Same as Save |

Separately, the existing in-process producer tests (real ORCA code, synthetic
environment, no containment, no independent observer) pass; see below. They are
code-level evidence, not observation of an exact run.

## Commands and results

### At the review-fix commit `d8400d24` (8 November 2026)

All on this cloud host: Linux 6.18.44-fc-v310 x86_64, Node v22.23.4, Python
3.13.18, pnpm 12.4.2, running as root unless stated.

| Command | Result |
| --- | --- |
| `timeout 180 python3 tools/guard-qualification/check_offline.py` | 95 tests OK, 0 skipped, 7.0 s |
| `timeout 180 python3 -O tools/guard-qualification/check_offline.py` | 95 tests OK, 0 skipped, 6.6 s |
| Same selection as an unprivileged user (`setpriv --reuid=65534 --regid=65534 --clear-groups`, all capability sets zero, copy of `tools/guard-qualification` and `docs/preparation/tool-execution-guards` in the repository layout) | 95 tests OK normal, 95 OK `-O`. The containment tests use user namespaces only; the nested-mount fixture runs in its own user and mount namespace |
| Per module | `test_reasons` 8, `test_identity` 12, `test_authority` 16, `test_journal` 21, `test_ledger` 12, `test_loader` 10, `test_containment` 16 |
| `ruff check --select E,F,W,B --line-length 120 tools/guard-qualification`; `flake8 --max-line-length 120 tools/guard-qualification` | Clean (first run of this pass: 3 `zip()` without `strict`, 4 layout warnings; fixed) |
| `pnpm run typecheck` | Pass (18 s) |
| `pnpm run design:check` | Pass |
| `pnpm run format:check` | Pass (36 s) |
| `pnpm run lint` | **First attempt failed** again with an ESLint heap out-of-memory abort (exit 134, 83 s). Retry with `NODE_OPTIONS=--max-old-space-size=8192`: pass (85 s), including the CSS token check |
| `pnpm run build` | Pass |
| `pnpm test` (Vitest, whole suite) | **Failed, same as before**: 4 failed, 10,054 passed, 36 skipped, 1 todo; 582 files passed, 2 failed, 5 skipped; 707 s. The 4 failures are the same pre-existing host failures recorded below for `9469ff67` and pristine main (`ci-shadow-selection.test.js` 3, Node 24 expected; `first-run.test.ts` 1, host runs as root) |

Pre-fix confirmation: the new regression tests were run against the previous
implementation. For containment this needed a small API shim (the old
`make_spec`/`launch_contained` lacked the new parameters); with it the
reproductions failed as the reviewer described: a write to a nested mount under
a runtime directory succeeded and reached the host, a host write to the
snapshot after launch was visible inside, a changed snapshot was not refused,
`/tmp/.orca-contained-root` was left on the host, a raw `OSError` escaped
`launch_contained`, and launch failed with a raw `FileNotFoundError` when the
`/proc/.../children` interface was absent.

### At the original implementation commit `9469ff67`

| Command | Result |
| --- | --- |
| `check_offline.py`, normal and `-O` | **63** tests OK, 0 skipped (this record previously said 62; the reviewer counted 63, which is correct). Run as root only |
| `cd tools/owned-read-proof && python3 [-O] -m unittest test_controlled_contract test_observer` plus the three non-tracer `test_cleanup` cases | 31 OK normal, 31 OK optimized. The real-tracer cases were not run (same exclusion as #809's selector) |
| `pnpm test` | 4 failed, 10,054 passed, 36 skipped, 1 todo; the same 4 fail on pristine main `c41c878` on this host: `tools/test/ci-shadow-selection.test.js` (3, expects a Node 24 runtime) and `packages/app/test/first-run.test.ts` "refuses denied selection without writing files" (1; this host runs as root, so a permission denial does not occur) |
| `vitest run` of the five `packages/cli/test/controlled-owned-read*.test.ts` / `controlled-standing-workflow.test.ts` files (in-process real producer code; no containment, no independent observer) | 5 files, 115 tests passed |
| `node tools/owned-read-proof/build-controlled.mjs <new dir>` on main | Built, never launched; outputs recorded in the identity matrix |

The Python tests in `tools/guard-qualification` are not part of ordinary CI.
`ci.yml` runs for pull requests to main, so draft PR #824 runs ordinary CI on
its head; ordinary CI and the app smoke workflow are not guard qualification.

## Mandatory historical tests

The separated historical physical tests (`test_controlled_image_pins.py`,
`legacy_image_pin_controls.py`) and #809's explicit non-live selector exist only
on #809's branch, not on main. This branch does not modify or remove them. They
were not executed here: the required historical fixture
(`ORCA_LEGACY_IMAGE_FIXTURE`, a frozen SOURCE `3fce8bcc` checkout) is not
present on this host. That is reported as not run, not as a pass or a skip.

## Independent review

A separate reviewer reviewed `d67cdd2a` against main `c41c8781`, ran the code
and had no access to the author's conclusions. Verdict: "nothing observed or
production-qualified" holds; "implemented and tested" overstated gap-matrix
rows 2, 3, 4, 6, 8 and 10. The gap matrix has been corrected. A human
collaborator (Cal) separately requested changes on draft PR #824 at
`d67cdd2a`. The fixes below have **not** been independently reviewed yet; that
review is still required before any of this is relied on.

## Review findings and resolutions

Every finding has a regression test that fails on the previous code and passes
at `d8400d24`. "Remaining refusal" is what the code now does instead of
reporting success where the gap is not closed.

| Finding | Resolution | Covering tests | Remaining refusal or open gap |
| --- | --- | --- | --- |
| H1 containment: non-recursive read-only remount | Fixed. Runtime binds made read-only, nosuid, nodev with `mount_setattr(AT_RECURSIVE)`; preflight reads `/proc/self/mountinfo` after `pivot_root` and refuses unless every mount except `/workspace` is read-only and every mount point is expected | `test_containment`: `test_h1_nested_writable_mount_under_runtime_dir_is_read_only` (privileged fixture: tmpfs on `/opt` and a nested tmpfs, in a private outer mount namespace), `test_h1_mountinfo_check_refuses_if_recursive_setattr_is_missing` | `containment_root_writable`, `containment_mount_unexpected`, `containment_workspace` |
| H2 journal: observer window not compared | Fixed. Observer and supervisor streams must start at or before session start, end at or after settlement and name the session's statement; the observer must also never be silent longer than 1 s (`observer.alive` liveness records) | `test_journal`: `test_h2_observer_must_cover_the_whole_session`, `test_h2_observer_is_bound_to_the_session`, `test_cal1_observer_coverage_must_be_continuous` | `journal_observer_window`, `journal_attribution`. Open: the observer itself (G3) and authenticated stream custody; `require_lane_counts` refuses non-simulated input |
| H3 loader: `module._compile` on arbitrary strings | Fixed for the reproduction. `Module.prototype._compile` is replaced by a non-writable guard that only compiles the reviewed bytes of a listed file; `_extensions` frozen; `wrap`, `wrapper`, `_load`, `_resolveFilename`, `prototype.require/load` locked before the entry runs; reviewed bytes referencing those internals refuse statically | `test_loader`: `test_h3_module_compile_cannot_run_unreviewed_strings`, `test_h3_reviewed_bytes_referencing_loader_internals_refuse` | `loader_compile_denied`, `loader_compile_reference`. Consequence: the main-built producer bundle (15 `_extensions` references) is refused until reviewed source removes them. Same-realm boundary remains cooperative |
| M1 loader flags not checked | Fixed. Loader refuses unless `--permission`, `--no-addons`, `--disallow-code-generation-from-strings` and exactly one `--allow-fs-read` are present, `NODE_OPTIONS` is unset and write/child/worker permissions are absent | `test_loader`: `test_m1_required_node_flags_are_enforced` | `loader_flags` |
| M2 source identity fooled by skip-worktree; runs repo-controlled commands | Fixed. Every index entry must carry plain `H` flags, stage 0 and an allowed mode, and its blob hash is recomputed from the worktree bytes; untracked files refuse; git runs with global/system config disabled and `core.fsmonitor`, hooks, untracked cache, attributes file, split index, external diff disabled | `test_identity`: `test_m2_skip_worktree_and_assume_unchanged_cannot_hide_changes`, `test_m2_repository_configured_commands_are_not_run` | `source_dirty` makes the tuple invalid (`identity_malformed`) |
| M3 cleanup: settled with a live background process | Fixed. `spawn` requires subreaper mode; close sweeps descendants and requires `waitid(P_ALL)` to report no children | `test_ledger`: `test_m3_spawn_requires_a_dedicated_subreaper_supervisor` | `supervisor_not_dedicated`, `descendant_unsettled` |
| M4 single use per ledger directory | Fixed. A ledger is created with a random id; the signed statement names `ledgerSha256`; any other ledger refuses | `test_authority`: `test_m4_statement_is_bound_to_one_designated_ledger` | `ledger_mismatch`, `ledger_unavailable` |
| M5 revocation only in memory | Partially fixed. Signed revocations are written to the designated ledger and re-read and re-verified at every verify and check by every verifier using it | `test_authority`: `test_m5_revocation_is_durable_and_shared_through_the_ledger` | Unreadable or invalid revocation records refuse with `ledger_unavailable`. Open: delivery to another host; because a statement names one ledger, other ledgers refuse it (`ledger_mismatch`) instead of accepting it |
| M6 capability attributes writable | Fixed. The handle is an opaque slot-less object that refuses attribute writes; every decision uses the verifier's private copy of the statement bytes | `test_authority`: `test_m6_capability_attributes_do_not_carry_authority` | `authority_unregistered`, `authority_closed`. Open trust assumption: same-process code can reach the verifier's private record |
| M7 identity/authorization circularity; caller-supplied hash | Fixed in code and plan. The identity tuple has no session or authorization field; the verifier measures identity itself; the plan names the identity digest; the statement binds plan, identity and ledger; the verifier then issues an outer run envelope naming identity, plan, consumed statement, ledger and session | `test_authority`: `test_m7_identity_is_measured_by_the_verifier_not_supplied`, `test_cal5_end_to_end_with_measured_digests` | `identity_mismatch`, `run_envelope_mismatch` |
| M8 producer self-reported check and answer records | Partially fixed. Every producer boundary check must match, in order, a check in the supervisor's own stream (built from its verifier's log) made no later than the producer recorded it; every recorded human answer must match a supervisor-sent answer | `test_journal`: `test_m8_producer_check_records_need_supervisor_corroboration`, `test_m8_no_non_simulated_success_path_exists` | `journal_authority_check_missing`, `journal_attribution`. Open: no reviewed supervisor-side human answer channel, so `require_lane_counts(..., simulated=False)` refuses with `prerequisite_missing` |
| M9 loader and manifest read from mutable host paths | Fixed for the contained route. The snapshot is copied into a private tmpfs inside the namespace, checked file by file against the reviewed digests in the spec (extra, missing, changed, symlinked or special files refuse), then made read-only | `test_containment`: `test_m9_host_changes_to_snapshot_after_launch_are_not_visible`, `test_m9_snapshot_must_match_reviewed_digests` | `containment_snapshot_mismatch`. The uncontained loader invocation (tests only) still reads host paths and is not a qualification route |
| L1 `pipe()` leaked a descriptor at budget | Fixed. Both slots are reserved before `pipe2`, or nothing is acquired | `test_ledger`: `test_l1_pipe_reserves_both_slots_or_acquires_nothing` | `resource_budget_exceeded` |
| L2 failed reap skipped the sweep | Fixed. The descendant sweep runs in an outer `finally` | `test_ledger`: `test_l2_failed_reap_still_sweeps_descendants` | Settlement `uncertain` |
| L3 unreliable `/proc/.../children` | Fixed. Descendants and the namespace init are found by scanning `/proc/<pid>/stat`; the `children` file is optional; unreadable `/proc` refuses | `test_ledger`: `test_l3_descendants_found_without_proc_children_interface`; `test_containment`: `test_cal6_no_proc_children_interface_needed`, `test_cal6_unreadable_proc_refuses_with_allowlisted_reason` | `procfs_unavailable`. Open: cgroup-based tracking (`cgroup.procs`) not implemented |
| L4 fixed shared `/tmp/.orca-contained-root` | Fixed. The staging root is a tmpfs mounted over `/tmp` inside the private mount namespace; nothing is created on the host | `test_containment`: `test_l4_no_shared_host_side_root_directory` | Runtime directories under `/tmp` are refused (`containment_spec_invalid`) |
| L5 empty host id when `/etc/machine-id` missing | Fixed | `test_identity`: `test_l5_missing_machine_id_refuses` | `identity_incomplete` |
| L6 lstat-then-open races | Fixed for the ledger, evidence and snapshot directories (open with `O_NOFOLLOW`, then `fstat` the descriptor) | `test_authority`: `test_l6_ledger_directory_checked_on_the_opened_descriptor`; `test_reasons`: `test_l6_evidence_directory_checked_on_the_opened_descriptor` | `ledger_unavailable`, `acquisition_failed` |
| L7 raw exceptions from `launch_contained` | Fixed. Any non-refusal exception becomes `containment_startup_failed`; the ledger still settles what was acquired | `test_containment`: `test_l7_launch_errors_are_allowlisted_refusals` | `containment_startup_failed` |
| L8 caller-asserted `evidenceClass` | Fixed. Callers may assert only `implemented` or `simulated` | `test_reasons`: `test_l8_callers_cannot_assert_observed_evidence` | Refusal on `observed` or anything else |
| L9 doc errors | Fixed. Test count corrected (63 at `9469ff67`, 95 now); `bounds.py` docstring now names `BoundsTests` in `test_reasons.py` | Documentation | — |

### Cal's review on draft PR #824

| Item | Resolution |
| --- | --- |
| 1. Observer coverage (`journal.py`) | Same as H2, plus continuity: the observer must start no later than the session, end no earlier than settlement, name the session's statement and never be silent longer than 1 s. Boundary regressions for late start, early end and a mid-session silence (`test_h2_*`, `test_cal1_observer_coverage_must_be_continuous`). Coverage is established by the stream's own records; an independently implemented observer does not exist yet (G3), so no non-simulated count is produced |
| 2. Nested mounts (`contained_preflight.py`) | Same as H1: enforced recursively with `mount_setattr(AT_RECURSIVE)` and verified from `/proc/self/mountinfo`. Privileged fixture: two tmpfs mounts (`/opt`, nested `/opt/rt/sub`) created in a private outer mount namespace (as root `unshare --mount`, as non-root `unshare --user --map-root-user --mount`), so the host is not touched |
| 3. Pipe acquisition (`ledger.py`) | Same as L1: both slots reserved before the pipe is created; at budget nothing is acquired and nothing leaks |
| 4. Partial evidence writes (`reasons.py`) | Bytes are charged before writing; a failed write or fsync removes the partial record and refunds only after removal succeeds; if removal fails the store closes. Failures are `evidence_write_failed`. Regression reproduces the 4-byte partial write followed by an error under a 10-byte limit (`test_cal4_partial_writes_are_accounted_and_removed`) |
| 5. Identity/authorization circularity | Same as M7: pre-authorization identity bound in the signed statement (by digest, re-measured by the verifier), outer run envelope carrying that identity digest with the plan and consumed statement digests. End-to-end test computes every digest from a real git repository, this host, the Python executable, the loader file and a real containment spec (`test_cal5_end_to_end_with_measured_digests`) |
| 6. procfs environment dependence | The `/proc/.../children` interface is no longer needed anywhere (ledger and containment scan `/proc/<pid>/stat`); a `/proc` that cannot be read refuses with `procfs_unavailable`; never a skip. The host requirement is in the identity tuple (`host.requirements`: `mount-setattr`, `pidfd`, `proc-pid-stat`, `unprivileged-user-namespaces`), probed by `measure_host`, and stated in the gap matrix and plan. `cgroup.procs` tracking was considered and is not implemented; recorded as open. Not re-run on Cal's host |
| 7. Evidence budget reset on reopen (second review, at `af318bc0`) | `PrivateEvidence` now owns its directory exclusively for its whole life: the directory must be empty when opened and is held under an exclusive non-blocking `flock` until close. A reopened, pre-populated or concurrently opened store refuses with the new code `evidence_store_not_exclusive` instead of starting a fresh in-memory budget. Regressions: `test_cal7_reopen_and_duplicate_writers_cannot_reset_the_budget` (8 bytes, then concurrent open, then reopen after close; 8 bytes on disk at the end) and `test_cal7_foreign_content_and_lock_are_refused`. Both fail on `af318bc0` and pass after the fix. Assumption: `flock` is advisory, so a same-uid writer that bypasses `PrivateEvidence` is out of scope |

Known limitations still open: `public_summary` accepts short lowercase tokens
for descriptive keys (bounded, not vocabulary-checked); containment has no
seccomp or cgroup limits; the loader boundary is cooperative inside one V8
realm; the producer does not emit the journal; the final no-children check runs
after directory removal; original bootstrap lineage (row 5) is not implemented.

### After the second review (10 November 2026)

Only `reasons.py` and `test_reasons.py` changed. Results: `check_offline.py` 97 tests OK, 0 skipped, normal and `-O`, as root and as uid 65534 (same `setpriv` setup as above); ruff (E,F,W,B) and flake8 clean. `reasons.py` SHA-256 is now `586369357fb216d28636cd917398f741a8957a26282d0060931f4aabb504cdad`; every other hash below is unchanged.

## Artifact hashes (SHA-256 at the review-fix commit `d8400d24`)

| File | SHA-256 |
| --- | --- |
| `tools/guard-qualification/authority.py` | `f7b87ca95996e3889bbbe3e5ba4198993a49cd75092ff7cb789d819ce0eda9ef` |
| `tools/guard-qualification/bound-loader.mjs` | `aee90854e3ecfb9d229ca648dd98c45a52b8d3c392d3d95cad817ea6df1864b5` |
| `tools/guard-qualification/bounds.py` | `0eca31c0870bb3829632388482b2f39bbf805250dd73d556774a5e848d64b470` |
| `tools/guard-qualification/check_offline.py` | `f1813e9fefd9069e1bb86aae314c9532a953d0b8128b03bfce0abed3edfa5672` |
| `tools/guard-qualification/contained_preflight.py` | `edbaeb666c1c86de9b39c46b74715d8dc65901d314f197fee3d2b552afa81042` |
| `tools/guard-qualification/containment.py` | `02e565f5fe9fd565742b30fc8c79a8f255ffd49991424d8f45db25c4af8762ef` |
| `tools/guard-qualification/identity.py` | `fd114283997eddf7c056dcc5e1abd4037d1e0ed3cbbc056967987ed5dc1f595d` |
| `tools/guard-qualification/journal.py` | `d5fc7d7ba56c0aeeb481b9b23a8e132a1f556f608c8ce7c31758e780e08d63a1` |
| `tools/guard-qualification/journal_fixture.py` | `fe00e2b1f57986de52be328bf4bec879708cc2f16d34e17249ce5eecbc0415a1` |
| `tools/guard-qualification/ledger.py` | `3ff35921c2e112c4e9227c4292d04cf582a0da437bba82523b02d35776ff95fe` |
| `tools/guard-qualification/loader.py` | `789432deac866725c26352bb8a74b4c905545181e869d6fbd7cc4380f052a4f0` |
| `tools/guard-qualification/reasons.py` | `1938bcc65719f676bf42a87e7e439388bdb8d917b2aa5b21e2344ab1a4a2343b` |
| `docs/preparation/tool-execution-guards/guard-proof-identity.json` | `5d907969b666c4b6cdaf5b382a612c63a77e68e3b60f8fbe1d13beecaa665cea` |
| Unlaunched main image `controlled-producer.mjs` (2,248,585 bytes) | `b145543ef28899ba2e4a076e2fed6f3193260b3d2987103821cc23bef956bb31` |
| Unlaunched main image `controlled-child.mjs` (5,254 bytes) | `a58036e5343fe07dac8625f7d5dfc2a7e0c6bfe660ddb1e96711b5b8d002e35c` |
| Unlaunched main image `controlled-build.json` (48,711 bytes) | `9fd5294d059ded8cec9a36c0727163f95c8fbb6c0279a43fba3b5b2d1bf96ee8` |

## Decisions that need Casey

1. Draft PR #824 exists for this branch; whether it stays draft (it must not
   be merged as qualification).
2. Who independently reviews these fixes and the revised draft plan.
3. Key custody for exact-session authority (gate G5) and the qualification
   runtime (G6).
4. Authorization of a frozen exact-run plan, only after gates G1–G8 close.
5. How #809's owner integrates or supersedes these modules; #809 itself is
   untouched and still conflicts with main.
