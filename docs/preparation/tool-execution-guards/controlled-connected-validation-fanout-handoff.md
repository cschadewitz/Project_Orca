# Handoff — controlled connected validation fan-out (#706)

Working notes for whoever picks this up: what was done, what was found, what changed
and what is still open. The polished record is
[controlled-connected-validation-fanout.md](controlled-connected-validation-fanout.md),
with [measurements JSON](controlled-connected-validation-fanout.json). Diagnostic
tooling is in
[`tools/owned-read-proof/diagnostics/fanout/`](../../../tools/owned-read-proof/diagnostics/fanout/README.md).

Nothing here is an observer attempt, an accepting token, production eligibility or a
connected acceptance. No credentials, registries, settings, limits or deployments
were touched. No PR was opened; Cal manages PRs, integration and review.

## Status at handoff

| Item | State |
| --- | --- |
| Branch | `claude/intelligent-meitner-mab2ml`, from exactly `6a4d30dda73be89b90b7684a821d18768dcc2e14` (tree `1584948c…`), pushed without force (new branch) |
| `prep/706-single-stat-observation` | untouched; still `6a4d30d` on the remote when checked |
| Exact-duplicate removals (A, D1, D2) | done, tested; measured necessary but **not sufficient** |
| Assertion-only enrollment check (B) | done, tested; **needs an owner decision**; with it the full flow completes in diagnostics |
| Observer run of the candidate | **not done** — needs review, repin and the reviewed strace 6.13 environment |

## Commits on the branch

| Commit | What |
| --- | --- |
| `93ac60d` | **A** — managed gate observes each distinct root/ancestor once per check invocation; drops the duplicate realpath walk |
| `ec1f91a` | **D1/D2** — child bootstrap association no longer re-runs the physical check; managed build port gets a genuine image/proof check |
| `7c478c2` | **B (decision point)** — managed assertions check enrollment once per invocation; read-for-use `inspect()` keeps its closing check |
| `7299bc3` | Evidence write-up and measurements JSON |
| (head) | This handoff, the diagnostic tooling, experiment patches, evidence cross-links |

The branch head is whatever `git log -1 origin/claude/intelligent-meitner-mab2ml`
shows; this file is in that commit.

## Files changed (all relative to the start commit)

**Product / producer source (in the 386-input build manifest):**

- `packages/cli/src/typed-workspace-gate.ts`
  - A: `observe()` map; `canonical`/`directory`/`metadata` take it; no `realpathSync`; `metadata()` returns `{ bytes, named }`; internal `resolveBinding()`; `assertCurrent()` creates its own map after the ports.
  - B: `enrollment()` split from `inspect()`; `assertMarker()` uses `enrollment()`.
  - Production imports only `assertNoUnownedTypedWorkspace`, which is unchanged.
- `packages/cli/test/controlled-owned-read-producer.ts`
  - New required `assertBuildCurrent()` on `ControlledReadTestSupervisor`, retained before any await.
  - Initial call after the bootstrap check.
  - `build` wrapper passed as the managed build port; lifetime port unchanged (`check`).
  - Doc comments updated.
- `tools/owned-read-proof/controlled-child.mjs`
  - `image()` helper used by `check()`.
  - `association()` (proof identity, bytes, digests) replaces the bootstrap closure that called `check()`.
  - New `assertBuildCurrent` (image, plus association when connected).

**Tests:**

- `packages/cli/test/typed-workspace-gate-observations.test.ts` (new, 20 tests).
  - Per-resolution and per-assertion observation counts.
  - No realpath; nothing reused across invocations.
  - Symlink-alias refusal at each root and an ancestor.
  - Mutation inside an invocation after its ports.
  - Between-invocation mutations: lifetime, build, replaced root, mode, identity bytes, sidecar hardlink, marker.
  - B semantics: inspect re-checks after marker reads; an assertion is refused by the next invocation.
- `packages/cli/test/controlled-owned-read.test.ts`
  - Harness supplies `assertBuildCurrent`; call log; build-refusal switch.
  - New test: build-port-only change after Save refuses with no read.
  - Connected test asserts the build port is used in every phase, and each proof check immediately follows a complete check.
  - Pin test also replaces `assertBuildCurrent`.
- `tools/owned-read-proof/test_child_stat_observations.py`
  - Exact observations per callable (physical, association, build).
  - Counts: checks 14→10, FIFO 28→20, inventory 42 (30 physical + 12 build).
  - Image and stamp mutations probed on both `current` and `build`.
  - New proof-tamper test probing each callable independently.
  - `assert_refused` now requires the refusal *after* a `PROBING AFTER MUTATION` marker.
- `tools/owned-read-proof/test_bootstrap_receipt_child.py`
  - Proof reads 12→8 and 21→16 (association no longer repeats the check).
  - `probe` plumbing; tamper refused with the association probed first.

**Notes and tooling (this commit):**

- `docs/preparation/tool-execution-guards/controlled-connected-validation-fanout.md` — evidence write-up.
- `docs/preparation/tool-execution-guards/controlled-connected-validation-fanout.json` — sanitized measurements.
- `docs/preparation/tool-execution-guards/controlled-connected-validation-fanout-handoff.md` — this file.
- `tools/owned-read-proof/diagnostics/fanout/`:
  - `README.md`
  - `drive.py`
  - `census-preload.mjs`
  - `analyze.py`
  - `gate-units.mjs`
  - `child-units.py`
  - `experiments/exp1-no-inspect-closing-check.patch`
  - `experiments/exp2-lifetime-port-narrowed.patch`

## What I did, in order

1. Fetched `6a4d30d`, verified its tree, branched locally from it, and read `AGENTS.md`.
   - The designated branch's stale local tracking ref pointed at `7f42c3a`, an unrelated non-main commit.
   - That branch turned out not to exist on the remote, so the push created it.
2. Node 24.21.0 and pnpm 12.4.2 with `--frozen-lockfile`.
   - Rebuilt the image: child `9c3e6236…`, producer `d0ad8d81…`, manifest `9e37d858…` — all expected.
   - 386 inputs (194/192), ACP SDK 1.8.0 / Zod 4.6.7; the manifest is byte-identical to the retained one.
3. Ran the unchanged observer once (`observe_new()`).
   - It refused at preflight: `unreviewed tracer version for entry clock provenance`. Installed strace is 6.8; the observer requires 6.13. 6.8 also lacks `--always-show-pid`.
   - Not waived, no other tracer installed, no child ran under the observer.
4. Built a diagnostic driver around the observer's own `prepare()`/`prepare_connected()`, with a synthetic designation, and measured untraced, with the census preload, with `strace -c` and with a full trace.
5. Mapped the call graph from real stacks, measured exact unit costs with marker syscalls, and built a cost model that matches Save's measured `statx` to 0.1%.
6. Implemented A, D1 and D2, measured them, then two experiments, then B. Experiments: removing the bracket everywhere, and narrowing the lifetime port.
7. Measured same-synchronous-turn adjacency with a promise-tracking async hook. Without the hook, `executionAsyncId()` does not change across awaits — a trap.
8. Wrote adversarial tests and mutation-tested them against faulty variants.
   - Found that Python mutation subtests could "refuse" for the wrong reason (setup assertions), and strengthened them.
9. Split the work into reviewable commits, verified each commit's state, measured each commit's image, ran an enforced-limit run, and wrote the evidence.

## What I found

**Root cause: multiplicative fan-out of complete currentness checks.** These are real stacks:

```text
readCaptureFacts (owner)        ≈ 20 inspect
currentStore() (gate)           =  5 inspect
typed-sidecar read()            =  3 inspect
binding.assertCurrent()         =  1 inspect  (via assertCompatibilityCurrent → assertMarker)
inspect() enrolled              =  2 managed owner checks (bracket around marker reads)
managed assertCurrent()         =  2 producer check() (lifetime + build ports) + root re-resolution + identity
producer check() (connected)    =  2 child checks (direct + inside bootstrap.assertCurrent) + receipt + 4 credential stats
child check()                   = 18 statx, 3 openat, 4 read, 3 close
```

- **Shares of producer checks:** managed `assertCurrent` is the caller of 85.9%; `readCaptureFacts` alone drives 40.8%.
- **Managed-check entry points:** `currentStore` 40.7%, `assertManagedTypedStoreBinding` 23.3%, retained-owner `assertCurrent` 16.3%, typed-sidecar `read` 15.6%, `readRules` 3.5%.
- **Per-unit baseline statx:**
  - root resolution 96
  - identity tail 31
  - managed check 209
  - producer check 41
  - inspect markers 27

**Save model check:** 1,139 × 127 + 2,717 × 41 + 570 × 27 + ≈5k = 276.6k, against 276,647 measured. That is 52% gate re-resolution, 40% producer checks, 6% markers. `statx` is 92% of trace bytes at about 958 B/line.

**Refinement of the starting hypothesis:** the roots/ancestors share comes mostly from the managed gate. It walks each component twice (lstat walk, then realpath walk), about eight times per resolution. The child's image checks are only 3 of 18 child `statx`.

**Not a hot loop:** no single consumer dominates. Fixing consumers one by one would mean broad product changes across the daemon owner, agents and engine.

**Same-turn adjacency:**

- On A+D1+D2, 69% of consecutive producer-check pairs are in the same synchronous turn with only check reads between.
- By code site:
  - inspect bracket 54%
  - chained inspects 10%
  - service `current()` back-to-back 10%
  - producer closure `check()` then managed 9%
- None is provably effect-free, so no memo, flag or cache was used.

**Residual same-turn pairs on the final candidate:** 1,830 of 3,445 (53%):

- service `current()`→`current()` 19.6%
- producer closure `check()`→managed 17.5%
- service `current()`→producer closure 15.3%
- chained `enrollment()`→`enrollment()` 11.9%

These are the leads if more margin is ever needed; all are product or engine structure.

**Load-bearing points:**

- The Save commit's final synchronous check is `assertOwnerCurrent()` (a managed assertion) plus `assertCommitCurrent`. So managed checks cannot simply drop the full producer `check()`. That is why D2 keeps it on the lifetime port.
- Read dispatch calls producer `check()` directly in `createOriginal.assertCurrent`.

**Replay:** by source inspection, the observer validates each open/read generically against retained original bytes, with a bounded fdinfo sentinel sequence. It has no per-check grammar, so fewer syscalls should only remove events. That is unverified without an observer run.

**Refusal reasons for the over-budget runs:**

- Start commit: human-read `choose` returned `"uncertain"` at 59.5 s. The cause was not isolated; timing is consistent with expiry.
- Commits 1 and 2: the synthetic read fence's lifetime timer fired at the unchanged 55 s `expiresAt`. That fails closed.

## Measurements (diagnostic driver, strace 6.8, synthetic designation)

| Image | Bootstrap trace | Connected |
| --- | ---: | --- |
| start (reviewed) | 104.8 MiB | Save alone 287.8 MB; 340.9 MiB at refusal |
| `93ac60d` A | 43.9 MiB | 285.9 MiB at refusal (expiry, human-read) |
| `ec1f91a` A+D1+D2 | 34.7 MiB | 263.6 MiB at refusal (expiry, rule-read) |
| `7c478c2` A+D1+D2+B | 23.7 MiB | **216.3 MiB complete**; 46.4 s, exit 0 under `prlimit` 256 MiB + 60 s deadline |
| exp1 (no `inspect()` bracket) | — | 207.8 MiB complete, 43.5 s — rejected |
| exp2 (narrow lifetime port) | — | 238.7 MiB complete, 53.6 s — rejected |

Connected-flow counts, baseline → candidate:

| Unit | Baseline | Candidate |
| --- | ---: | ---: |
| Child checks | 18,430 | 3,451 |
| Producer checks | 9,212 | 3,445 |
| Managed checks | 3,955 | 2,143 |

`strace -c` statx counts:

| Lane | Baseline | Candidate |
| --- | ---: | ---: |
| Bootstrap | 108,682 | 21,523 |
| Connected | 466,748 (partial, refused) | 193,923 (complete) |

Gate units: resolution 96 → 16 statx, never-typed inspect 141 → 30, enrolled
inspect 59 (two owner checks with no-op ports).

Untraced connected wall time is 6.0 s → 3.2 s. These are runs in one environment,
not a controlled causal claim.

## Tests actually run

- **Vitest:**
  - Whole `packages/cli` suite: 534 passed, 1 skipped (`admission-retry-wiring`, gated on `ORCA_RETRY_INTEGRATION`).
  - Targeted suites at `7c478c2`: 119 passed.
  - Per-commit states: 117 at `93ac60d`; 60 plus 10 Python at `ec1f91a`.
- **Mutation checks, all caught:**
  - Gate variants: cross-invocation cache (12 failures), no symlink check (3), assertion keeps bracket (2), inspect drops bracket (2), map shared across inspect (7).
  - Child variants: association without identity, build without image, association repeating `check()` (114–115 subtests fail each).
  - Producer with the build port wired back to `check`: 2 failures.
- **Python:** 329 run, 323 pass.
  - 4 `test_controlled_image_pins` refuse by design (`installed child differs from reviewed producer source`, `CHILD_SHA` mismatch). The observer requires every repository input to equal `git show SOURCE:…`, so any candidate refuses until a reviewed repin.
  - 2 `test_kernel_runtime_queries` errors are environmental (no cgroup `memory.max`). The start commit shows the same 2 (328 run, 326 pass).
- **Static checks:** `tsc --noEmit`, ESLint and Prettier on all changed and new files are clean; `git diff --check` is clean.

## Decisions and open questions for Cal / owners

1. **Accept or reject B.**
   - It changes the inactive managed owner: an assertion observes ownership once, before its marker reads. A change during those reads is refused by the next assertion, not that one.
   - `inspect()` keeps its bracket for state it returns for use.
   - Without B, A+D1+D2 is measured insufficient.
2. **If B is rejected,** the alternatives are product fan-out restructuring or exp2. Exp2 has thinner margin and drops supervisor-only facts from managed checks.
   - Product fan-out targets: owner `readCaptureFacts`, provider/`currentStore` chains, service `current()`.
3. **Margin:** about 15% bytes, and 46.4 s against the 55 s owner window in this (slower) environment. Whether that is enough is a judgment call.
4. **Changelog:** I suggest `no-changelog`. This is test preparation plus an inactive managed owner.
5. **Tooling:** whether `tools/owned-read-proof/diagnostics/fanout/` should stay in the repository. It contains an opt-in `assert_image_sources` bypass for measuring candidates. Drop that commit if unwanted; the evidence does not depend on it.

## Next steps (in order)

1. Independent source review of the exact head: gate, child, producer and tests.
2. If accepted, repin coherently in one commit:
   - `SOURCE` in `controlled_supervisor.py`, `controlled_connected.py` and `controlled_timestamps.py` → the reviewed commit.
   - `CHILD_SHA` → `7729c6faa7cca7436c0d7ab3008fd4532e3ed3d11e9c4ec01e98c04004782b13`.
   - `PRODUCER_INPUT_SHA` → `42597750deea858c41a8c19a1eb12870b71f6ee737409e2fc46e6173ce61c5d6`.
   - Expected rebuilt image here: producer `ef9e795eb1d79f7b211cee737e14feed517aee10503c15a7cb4dc28c1e098909`, manifest `51fc0c8b831bb0d842e03ea48fefa92de7d46e20d6aa60c988593701c78a6580`.
   - All 192 dependency inputs are identical to the reviewed build. Re-verify in the review environment, because build output is root-sensitive.
3. Retain and review the new manifest, then run **one** fresh observation in the reviewed strace 6.13 environment. Report it whatever the outcome; no favourable retries.
4. Independent review of that complete observed flow before any acceptance claim.
5. Still unexercised: the zero-result private-wake boundary case from `6a4d30d`.

## Gotchas I hit

- **Tracer:** the observer needs strace 6.13 exactly (version line); distro 6.8 refuses at preflight and lacks `--always-show-pid`.
- **Stale branch ref:** the session's stale `origin/claude/intelligent-meitner-mab2ml` ref looked like an existing diverged branch; `git ls-remote` showed it did not exist.
- **Stack labels:** V8 labels the bound child check `Object.check@child`. Classify both forms.
- **Async ids:** `executionAsyncId()` needs an enabled async hook to distinguish promise continuations.
- **Heavy census:** it slows the flow enough for the 55 s expiry to refuse; use light mode for full flows.
- **Builder:** the image builder resolves `@orca/*` through tsconfig paths. A worktree needs its own `pnpm install --frozen-lockfile` to reproduce identical manifest keys. Symlinked `node_modules` changes the input paths.
- **Pin controls:** `test_controlled_image_pins` fails for any working tree that differs from the reviewed `SOURCE`. That is expected until a repin.
- **Vitest mocking:** mocking `node:fs` needs the named exports *and* `default` overridden, because some modules default-import `fs`.

## Not retained

Raw traces (25–360 MB each), census JSON, `strace -c` outputs and scratch images
lived only in the ephemeral session scratchpad. The sanitized numbers are in the
measurements JSON, and the tooling above regenerates them.
