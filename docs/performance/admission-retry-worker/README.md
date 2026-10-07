# Admission retry worker compilation (#510)

Experiment contract, written before paired runs. Base: verified remote main
`d7546ce6bcaf51f194aade26de2cd9a432cd7073`, including #512 and #511. The
credential-admin optimization is already shipped. #509 owns CI reporting/workflows.

## Boundary and preservation

Only the retry harness, a new test-only compiler helper, dedicated regression and
this evidence directory change. Compile the same tsconfig-resolved worker source
closure once per source-content candidate hash in each Vitest supervisor. Emit
individual ESM modules with no bundling, tree shaking, runtime dist imports or
process pooling. The bundle used to discover the graph is discarded. Generated
package links implement the original source aliases; external dependencies keep
the original pnpm realpaths and Node export conditions. The helper resolves esbuild
through the existing declared tsx tool. No manifest/dependency/config change.

Before every fork, hash source/config/lock/compiler/package inputs and every emitted
module/generated manifest; verify package links. Stale/missing artifacts fail closed
without fallback/rebuild. The supervisor owns a unique ignored `.orca` directory
and removes it after all workers close. Each supervisor builds afresh; no sensitive
or mutable state is shared. Compiler target follows the verified invoking Node. Baseline tsx can use its own
transform cache; the measurements remove repeated loader/cache-resolution startup
and do not establish that all 75 baseline launches actually retranspile sources.

| Stable cases | Preserved oracle/boundary |
| --- | --- |
| R01–R02, R15–R16: request/direct × accepted/in-progress races (4) | Two distinct simultaneous fresh PIDs, empty ledgers, IPC claim/lock barriers, one owner, bounded live contention, one start, identical durable IDs, third fresh replay |
| R03–R11, R17–R25: request/direct × claimed, bound, material, inputs, created, policy, owner, receipt, response (18) | SIGKILL at completed durable call before acknowledgement, no finally, fresh recovery and further replay, exact accepted/uncertain/failure receipts, reserved IDs, start counts, durable owner/events |
| R12–R14: request × request-document, linked, admission-accepted (3) | Same real Request/admission stores, links and additional death boundaries |
| all 25 original cases | Three workers each: 75 launches; 21 SIGKILL + 54 normal exits; file-backed locking/persistence, isolated directories, existing cleanup and 15-second IPC/test deadlines |
| new regression (outside timings) | Source/dynamic-import identity, exact external ESM resolution, source/config/lock and emitted/link negatives, distinct fresh Workers, missing-output refusal before another fork |

The original scenario/assertion file, worker and service fixture remain byte-for-byte
identical. This is service/store admission evidence; its trusted fixture authority
is not transport/grant/keychain acceptance. No added mocks or altered durability.

## Measurement contract

- Node 24.21.0 / pnpm 12.4.2; frozen installations retain supply-chain policies.
- One task workload at a time, one Vitest worker and no file parallelism. All test
  deadlines, workload dimensions and process boundaries remain unchanged.
- Initial six alternating-order micro pairs observe IPC ready and close events:
  fresh processes, warm filesystem/compiler cache after the retained slower first
  tsx sample. Timed readiness includes fork, imports and fixture/store initialization.
  Compilation is separately timed; this initial probe is feasibility only.
- Three alternating-order pairs run the unchanged 25-case file from isolated base
  and committed candidate. Record all outcomes/names, source/lock/tool hashes,
  supervisor elapsed, Vitest file duration and observed worker lifecycle counts.
  Candidate elapsed includes preparation, hashing and cleanup. Added tests excluded.
- Each run is bounded at 180 seconds plus five-second grace, with a blocking wait
  and independent watchdog. Exit is observed without Python completion polling.
  The observational Node preloader records fork/ready/close events; it preserves
  fork arguments and messages and applies equally to both variants. Observation
  overhead remains part of these local measured workloads.
- Stop and retain a failed comparison. Never retry a failed benchmark invisibly.
  Report medians/ranges and individual paired differences, no p95 from three pairs.
- Local Linux/cloud allocation and recently populated overlay/tmpfs storage do not
  establish homelab contention, physical-media behavior or whole-CI savings.

The paired order/provenance method follows the existing #423
[persistence baseline](../persistence-baseline/README.md). Its old pinned runtime
measurements are not a current baseline. No persistence workload is duplicated;
#408 retains ownership of private-phase, physical-media and durability performance.

Reproduce after frozen installs from exact heads:

```sh
export PATH=/workspace/.orca-tools/node_modules/.bin:/opt/codex/cua_node/bin:$PATH
python3 docs/performance/admission-retry-worker/measure.py \
  --baseline /workspace/orca-issue510-retry-base \
  --candidate /workspace/orca-issue510-retry \
  --output /workspace/scratch/issue510-retry/paired
```

## Results

The primary ESM-observer cohort measured local source snapshot
`8104e795d0909a8c331a90c53819e36c3f2dea1f` against the verified main base.
The helper/harness implementation has been unchanged since `cf4ba6f`; later
changes before/after these runs affect the measurement tooling and evidence only.
Publication preserves those exact measured source and emitted hashes.

| Three samples per side | Baseline median (range) | Candidate median (range) |
| --- | ---: | ---: |
| Supervisor elapsed, seconds | 50.415 (49.634–51.160) | 41.970 (41.615–41.996) |
| Vitest file duration, seconds | 48.994 (48.229–49.519) | 40.503 (40.195–40.528) |
| Median of within-run fork-to-ready medians, ms | 441.037 (431.650–445.403) | 307.878 (304.005–308.779) |

Supervisor median is **16.8% lower locally**. Individual paired savings are
**8.020 / 8.445 / 9.164 seconds**. Every run passed the same 25 names with zero
failures/skips/todo: **150 passed executions, 450 distinct worker launches across
the six runs, 126 SIGKILL exits and 324 normal exits**. Each run independently
observed exactly 75 distinct PIDs. The candidate includes preparation, per-fork
input/output/link validation and cleanup costs.

Fork-to-ready intervals include imports, store/fixture initialization and parent
message scheduling. They are not pure compilation, CPU or process-only time.
Blocking exit observation avoids #512's Python completion-polling quantization;
Node event scheduling and synchronous observation writes still add overhead.
Nested/concurrent worker intervals are not added to whole-file elapsed.

The earlier CJS-observer cohort passed the same workload, with supervisor medians
50.682 / 41.060 seconds and savings 9.560 / 9.625 / 9.546 seconds. It is retained
separately and not pooled with the primary ESM cohort. This cohort difference,
three-pair sample size, recently populated caches and unmeasured host interference
limit precision and generalization. There is no p95, confidence interval, adopted
performance budget or measured whole-CI saving. Node 22 paired performance and
homelab replication remain unmeasured.

The initial six-pair temporary micro probe observed fork-to-ready medians of
422.477 / 292.731 ms, with a 207.374 ms preparation pass over 104 modules. Its
first tsx sample (884.435 ms) is retained. It lacks the final provenance checks and
is feasibility evidence only, not pooled with the whole-file experiment. Baseline
tsx may read its own transform cache, so repeated transpilation is not established.

## Validation and limits

- Node **24.21.0** and checksum-verified official Node **22.23.3**: all **33 focused
  cases** passed on each, zero skips/failures (25 original + eight added regressions).
  Both explicit CLI/ACP retry opt-ins passed **2/2 without skips** on each Node.
- Node 24 whole typecheck, lint (including CSS tokens), formatting, design freshness,
  clean build and emitted CLI demo passed. Build retains the existing renderer
  chunk-size advisory. The normal frozen installs passed supply-chain policies;
  no lockfile, allowlist or installation policy override was used.
- Separate verified Node 22/24 closure emissions have **120 matching input hashes**
  and **109 identical output hashes** (104 modules + five generated manifests).
  Node version is included in each candidate key. No normal runtime dist output is
  accepted as worker provenance or consumed by this fixture.
- The first observer attempt passed baseline tests but failed to flush process
  evidence. Initial offline metadata/tsx-loader-resolution failures and the first
  lint failure on probe output/CJS syntax remain documented. Later successful
  cohorts are separate; no failed test outcome is hidden or retried to green.
- Only two tests consume this harness: the unchanged original file and the new
  regression. Full local ordinary/coverage suites and coverage threshold verdicts
  were not run for this draft. Normal full PR CI and independent review remain
  acceptance gates before any later merge; this task grants no merge authority.
  The separate production MCP, Electron/native and live-provider workloads are
  unrun here. #512's historic local umask failure is not relabeled as a current run.

[Raw evidence, commands, source/artifact hashes and failure history](evidence/README.md)
are checked in with SHA-256 checksums. Measurements used Linux 6.18.44/glibc 2.41,
five affinity-visible CPUs, a four-CPU cgroup quota and 16 GiB memory; these are
allocation observations, not physical-host capacity. Emitted code uses `/workspace`
overlay; scenario stores retain the original `/tmp` tmpfs location. No cache flush,
physical-media, power-loss, private-phase attribution or host change was performed.

Rollback is the original harness fork of worker.ts with the tsx loader; remove the
helper/regression/evidence as a reviewed fixture rollback. No runtime or workflow
migration is involved. #510 and #408 remain open, and #509's owned paths are untouched.
