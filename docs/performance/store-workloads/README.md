# Store workload benchmark (#341)

A reproducible benchmark of the four storage workloads #341 names, plus a checkpoint workload for backends with a write-ahead log (#339), at three dataset scales,
run through the #338 store contracts so the same code measures every backend: memory, file
and SQLite (#339). The comparison that decides whether a graph projection or a key-value
cache improves on SQLite is recorded in
[ADR 0011](../../adr/0011-sqlite-metadata-graph-and-kv-deferred.md), with its budgets and the
reference machine.

Code: `tools/benchmarks/store-workloads/`. Reference runs: `.github/workflows/store-workloads-bench.yml`. Self-test: `tools/test/store-workloads.test.js`
(runs the smoke shape on every push). No production store code and no new dependency.

```sh
pnpm run build   # or: npx tsc -b packages/store
node tools/benchmarks/store-workloads/run.js --scale small --output small.json
node tools/benchmarks/store-workloads/run.js --scale medium --backend file --repeat 5 --output medium-file.json
```

Options: `--scale smoke|small|medium|large` (required), `--backend memory,file,sqlite`
(default `memory,file`), `--seed`
(default 341), `--repeat` (default 3), `--scratch DIR` (default the OS temp dir),
`--workloads` (comma list), `--output FILE` (refuses to overwrite; default stdout). Progress
goes to stderr. The process exits 1 if any workload invariant fails.

## Workloads

Each is a function in `workloads.js` that touches the store only through `Stores`,
`DocumentStore`, `queryDocuments` and `asVersionedDocumentStore`.

| Workload | What it models | Measured | Invariant checked |
|---|---|---|---|
| `dependencyTraversal` | "What blocks this work item?" in the plan view and scheduler: read one plan's dependency edges (`queryDocuments` by `planId`), then a breadth-first walk to every transitive blocker. Also a full topological order of the plan. | Per-question latency, cold and warm; topological-order time. | The order covers every work item (the seeded graph is acyclic). |
| `paginatedHistory` | The run timeline over a long agent log: open at the tail, scroll back, scroll forward through everything, a type-filtered page (`step.started`), and `lastSeq`. | Latency of each read, cold and warm; per-page latency of a full forward walk and a 20-page backward walk. | The forward walk sees every event exactly once. |
| `concurrentMetadataWrites` | Several writers on one metadata collection: compare-and-swap increments of a few hot documents (retrying on conflict, up to 64 attempts) beside unconditional writes of their own documents, at 1, 4 and 16 writers. Each level gets its own identically seeded collection, and every writer's operations (which hot key each CAS targets) are fixed from the seed before timing starts. | Wall time, attempted and **succeeded** ops/s separately (only committed operations count as throughput), per-op latency, CAS conflicts, exhausted retries, errors by code. | Every intended operation committed (no error, no exhausted retry); hot counters rose by exactly the *intended* number of increments; every intended unconditional write is present. A backend that acknowledges writes without keeping them, or fails them, fails the workload (self-tested by injection). |
| `projectionRebuild` | A derived read model (per-run event summaries from the logs, the plan's blocked-by index from the dependency collection) kept in a disposable on-disk cache that is then lost. | Initial build, cache write, cache load, and rebuild-after-loss time. | The rebuilt projection is byte-identical (canonical JSON) to the one that was lost: the cache is never the authority. |
| `walCheckpoint` | An agent streaming output into one run on a backend with a write-ahead log (SQLite): a sustained burst of appends, then quiet. Backends without a log report `skipped` rather than zeros. | Append rate and latency, and latency outliers (appends over 5 ms; not attributed to checkpoints, which the workload cannot observe inside a commit); the log file's size before the burst, at its sampled peak (every 100 appends), at the end and after a truncating checkpoint; and every checkpoint the store's connections ran by themselves once writes stopped, as the store's `observe` hook reported it. The log's size is a measurement for a budget to judge, not an invariant: nothing in SQLite bounds it. | Every append committed; a truncating checkpoint emptied the log. |
| `walUnderLoad` | Checkpoints under sustained load (#339): one writer appends streamed agent output round-robin to four runs, without pause, for the scale's `sustainedMs`, so the store's idle checkpoint never runs and only SQLite's automatic one does, while the writer's own process pages history every 25 appends. Five phases (`LOAD_PHASES`), each from an emptied log, add readers on other connections (worker threads, as another process reading the store): none (`daemon`), a short read every 100 ms (`pollingReader`), short reads back to back (`backToBack`), reads holding their snapshot 100 ms, 10 ms apart (`slowConsumer`), and the same with no pause (`pinnedSnapshot`). Backends without a log report `skipped`. | Per phase: append rate overall and in the first and last fifth, latency (p99, max, appends over 5 and 50 ms), the in-process page reads' latency, each outside reader's reads and errors, the log file's size over time (sampled every 250 ms, at most 40 points kept), its peak in the first half and overall, at the end, after the idle checkpoint, and after the next write; and the idle checkpoint after the load. | Every append committed; no read failed and every page was in order; after the next write the log file is back to at most `walLimitBytes`. Growth during the load is a measurement, not a check. |

Writers in `concurrentMetadataWrites` are separate handles in one process. Cross-process
exclusion is proven by the store's own tests (`document-store-multiprocess`, the conformance
suite); this workload measures throughput and contention, not that proof.

## Dataset scales

`scales.js` fixes each shape; the dataset is seeded deterministically (`--seed`), so two
backends see identical data.

| Scale | Work items / dependency edges | Runs x events per run | Metadata collection | Writers | Checkpoint burst |
|---|---|---|---|---|---|
| small | 250 / ~540 | 4 x 1,000 | 200 + 4 hot | 1, 4, 16 x 40 ops | 5,000 appends |
| medium | 2,500 / ~5,400 | 4 x 10,000 | 2,000 + 8 hot | 1, 4, 16 x 40 ops | 20,000 appends |
| large | 25,000 / ~54,000 | 2 x 100,000 | 20,000 + 16 hot | 1, 4, 16 x 20 ops | 50,000 appends |
| smoke | 20 / ~30 | 2 x 60 | 20 + 2 hot | 1, 2 x 8 ops (self-test only) | 200 appends |

Why these sizes: an agent step streams `agent.update` events, so a run's log is dominated by
them and a long multi-step run reaches tens of thousands of events; 100,000 is a run that
has been left working for hours. Plans decompose into hundreds of work items in ordinary use
and a shared daemon accumulates thousands across plans; each item usually waits on one or
two others. Metadata collections (requests, work items, plan entities) are whole-file JSON
documents today, so their size directly sets every write's cost, which is the point of the
large collection. 16 writers is more than one workspace runs today and is the
multi-machine (#873 to #885) direction.

## Cold and warm

**Cold** reads go through a fresh store handle with empty in-process caches (a new
`fileStores(dir)`), which is what a newly started daemon or CLI command sees. **Warm** reads
reuse one handle after an untimed warm-up read. The OS page cache is never dropped
(that needs root and is not portable), so "cold" is process-cold, not disk-cold. An
in-process backend has no separate cold state and reports `"same as warm"`.

## Report

JSON, `schemaVersion: 1`: the scale and its shape, seed, repeat, commit and dirty flag,
machine (platform, kernel, Node, CPU model and count, memory), the limitations above, and
per backend: `status` (`ran` or `skipped` with a reason), seeding time and append rate,
each workload's measurements, its wall time and RSS delta, the store's bytes on disk, and
`checksPassed`. Latencies are milliseconds: `n`, `min`, `p50`, `p95`, `max`, `mean`,
`total`, with nearest-rank percentiles.

## Adding a backend

Add an entry to `backends.js` with `name`, `durable` and `create(dir)` returning
`{ stores(), collection(name), dispose() }`: a new handle per call on a durable backend.
That is the same shape as the conformance suite's `ConformanceBackend`. An entry with
`unavailable: "<reason>"` instead of `create` is reported as `skipped`.

## First observations (container smoke, not the reference machine)

A `small` run in a cloud container (Linux, Node 22, shared CPU) shows the shape of what the
comparison will need to look at. These numbers are not a baseline:

- The file backend's forward history walk re-scans the log from the start for every page,
  so paging forward is linear in position and a full walk is quadratic. Tail and backward
  pages stay cheap. That is the workload where an index helps most.
- Every document write rewrites the whole collection file under its lock, so write latency
  grows with collection size and p95 rises steeply with 16 writers, all of them serialized.
  CAS conflicts stay correct: no lost increments.
- Rebuilding the projection from the authoritative stores costs tens of milliseconds at
  `small`, against well under a millisecond to load the cache, which is the trade a
  disposable cache would buy.

## Reference machine

The baseline's reference machine is a **GitHub-hosted `ubuntu-24.04` runner** with
Node 24, run by `.github/workflows/store-workloads-bench.yml`. It needs no one: it runs
`small`, `medium` and `large` on memory, file and SQLite, one scale per runner, every
time store, core or benchmark code lands on `main`, on a pull request that changes the
benchmark, and on demand (`workflow_dispatch`,
optional `repeat`). Each report is kept as an artifact for 90 days
(`store-workloads-<scale>`) and summarized in the job summary by `summarize.js`.

A hosted runner is not dedicated hardware: its CPU model can change between runs and it
shares a host, so compare reports by their recorded `machine` and treat small
differences as noise. Each report records the commit, CPU model and count, memory,
Node version and, on a hosted runner, the runner image and its version, so a comparison across runs is always of known machines.

## What is next (not in this PR)

1. Keep the reference reports the ADR is decided on beside it (the workflow above produces
   them). Container observations for SQLite are in `docs/storage/sqlite-metadata.md`.
2. The ADR records the target p95 latency, throughput, resource, durability, recovery-time
   and operating-complexity budgets and the test machine **before** the comparison, then
   decides graph and key-value separately, each with a reconsideration trigger.
3. Any candidate projection or cache is rebuildable from authoritative metadata and events
   and tested after deletion, which `projectionRebuild` already checks for this one.
