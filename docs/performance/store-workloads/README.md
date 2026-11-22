# Store workload benchmark (#341)

A reproducible benchmark of the four storage workloads #341 names, at three dataset scales,
run through the #338 store contracts so the same code measures every backend. This is the
harness only. The comparison that decides whether a graph projection or a key-value cache
improves on SQLite waits for #339's SQLite baseline and is recorded in an ADR, with its
budgets written down **before** any comparison is read.

Code: `tools/benchmarks/store-workloads/`. Self-test: `tools/test/store-workloads.test.js`
(runs the smoke shape on every push). No production store code and no new dependency.

```sh
pnpm run build   # or: npx tsc -b packages/store
node tools/benchmarks/store-workloads/run.js --scale small --output small.json
node tools/benchmarks/store-workloads/run.js --scale medium --backend file --repeat 5 --output medium-file.json
```

Options: `--scale smoke|small|medium|large` (required), `--backend memory,file,sqlite`
(default `memory,file`; `sqlite` reports `skipped` until #339 registers it), `--seed`
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
| `concurrentMetadataWrites` | Several writers on one metadata collection: compare-and-swap increments of a few hot documents (retrying on conflict, up to 8 attempts) beside unconditional writes of their own documents, at 1, 4 and 16 writers. | Wall time, ops/s, per-op latency, CAS conflicts, exhausted retries, errors by code. | No lost CAS increment (hot counters rose by exactly the successful CAS count); every unconditional write is present. |
| `projectionRebuild` | A derived read model (per-run event summaries from the logs, the plan's blocked-by index from the dependency collection) kept in a disposable on-disk cache that is then lost. | Initial build, cache write, cache load, and rebuild-after-loss time. | The rebuilt projection is byte-identical (canonical JSON) to the one that was lost: the cache is never the authority. |

Writers in `concurrentMetadataWrites` are separate handles in one process. Cross-process
exclusion is proven by the store's own tests (`document-store-multiprocess`, the conformance
suite); this workload measures throughput and contention, not that proof.

## Dataset scales

`scales.js` fixes each shape; the dataset is seeded deterministically (`--seed`), so two
backends see identical data.

| Scale | Work items / dependency edges | Runs x events per run | Metadata collection | Writers |
|---|---|---|---|---|
| small | 250 / ~540 | 4 x 1,000 | 200 + 4 hot | 1, 4, 16 x 40 ops |
| medium | 2,500 / ~5,400 | 4 x 10,000 | 2,000 + 8 hot | 1, 4, 16 x 40 ops |
| large | 25,000 / ~54,000 | 2 x 100,000 | 20,000 + 16 hot | 1, 4, 16 x 20 ops |
| smoke | 20 / ~30 | 2 x 60 | 20 + 2 hot | 1, 2 x 8 ops (self-test only) |

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
That is the same shape as the conformance suite's `ConformanceBackend`. The `sqlite` entry
is a placeholder that #339 replaces.

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

## What is next (not in this PR)

1. #339 registers the SQLite backend; run `small`, `medium` and `large` on the reference
   machine, cold and warm, and keep the raw reports beside the ADR.
2. The ADR records the target p95 latency, throughput, resource, durability, recovery-time
   and operating-complexity budgets and the test machine **before** the comparison, then
   decides graph and key-value separately, each with a reconsideration trigger.
3. Any candidate projection or cache is rebuildable from authoritative metadata and events
   and tested after deletion, which `projectionRebuild` already checks for this one.
