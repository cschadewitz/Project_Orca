# ADR 0011: SQLite is the durable metadata store; no graph database or key-value store

- Status: Proposed (#341)
- Date: 2026-11-23
- Inspected baseline: main `9413feac7fdd9abea8f9b76af1344c6ee115fbcc` (workloads, run
  45084792624) and the checkpoint-under-load workload merged in #989 (`095c156b`, run 45136569819)

## Context

#339 added a SQLite metadata backend beside the file backend (`docs/storage/sqlite-metadata.md`).
Two further ideas were proposed for ORCA's storage: a **graph database** for workflow,
dependency and causal-history traversals, and a **key-value store** for disposable caches,
indexes and ephemeral coordination. #341 asks for each to be decided separately, from measured
ORCA workloads, against budgets written down before any comparison, and forbids a new
production dependency on the strength of a favourable microbenchmark alone.

The measurements come from the store workload benchmark (`tools/benchmarks/store-workloads/`,
`docs/performance/store-workloads/README.md`): six workloads written against the #338 store
contracts only, at three seeded dataset scales, on three backends, with invariant checks on every
run. It runs on every push to `main` that touches the store, and on benchmark pull requests.

### Why these budgets

ORCA's metadata is read by people through the desktop app and CLI, and written by the daemon
on behalf of agents. The budgets follow from that, not from what any backend happens to achieve:

- **Interactive reads** (a timeline page, "what blocks this item") must feel immediate in the
  app: 100 ms is the usual limit for a response to feel instant, and the page is one part of a
  render, so a single store read gets half of it.
- **Writes** come from agents: a busy shared daemon (the `large` scale) has a few tens of
  concurrent runs, each committing a handful of metadata writes a second and streaming output
  at tens to hundreds of events a second. Budgets carry headroom of roughly ten times that.
- **Rebuilds** happen on daemon start after a lost cache, while someone waits for the app.
- **Durability and recovery** are not traded for speed: the authority is the store, and any
  cache must be rebuildable from it.
- **Operating complexity** matters as much as speed: ORCA is installed on people's machines and
  on one control-plane host serving remote workers (#339); every extra service is something a
  person must install, upgrade, back up and debug.

### Budgets (p95 on the reference machine, unless stated)

| Area | Budget | Scale |
|---|---|---|
| History tail page, warm | ≤ 50 ms | large |
| History tail page, cold (fresh handle) | ≤ 100 ms | large |
| History paging backward, warm | ≤ 50 ms | large |
| Dependency traversal ("what blocks this"), warm | ≤ 250 ms (≤ 50 ms at medium) | large |
| Metadata writes, 16 concurrent writers | ≥ 500 committed ops/s, p95 ≤ 50 ms | large |
| Streamed appends, sustained | ≥ 1,000 appends/s, no append over 250 ms | all |
| Projection rebuild after cache loss | ≤ 5 s (≤ 1 s at medium) | large |
| Write-ahead log under ORCA's own reads | ≤ 64 MiB (`walLimitBytes`) | all |
| Memory growth of a workload (RSS delta) | ≤ 512 MB | large |
| Durability | An acknowledged write survives process kill and power loss on storage that honours flushes | — |
| Recovery | Reopening after a kill needs no manual step; ≤ 5 s | large |
| Operating complexity | No new service, daemon, port or native dependency; one store directory to back up | — |

**Reference machine:** GitHub-hosted `ubuntu-24.04` runner (image 20261116.133.1), 4 vCPU Intel
Xeon 6975P-C, 16 GB RAM, Node 24.21.0. Chosen because every benchmark run lands there unattended,
so a regression shows up on `main` without anyone running anything. A shared hosted runner
varies by tens of percent between runs: budgets are judged with that margin, and ratios between
backends in one run carry more weight than any single figure.

## Measurements

Store workload benchmark, Actions run
[45084792624](https://github.com/cschadewitz/Project_Orca/actions/runs/45084792624)
(three repeats per sample), and the checkpoint-under-load workload from #989's run
[45136569819](https://github.com/cschadewitz/Project_Orca/actions/runs/45136569819). The
`memory` backend is not a deployment option: it is the **in-RAM ceiling** that any embedded
graph or key-value engine could at best approach, since it has no I/O, serialisation or
durability cost at all.

| Workload (large scale) | file | SQLite | memory (ceiling) | Budget |
|---|---|---|---|---|
| History tail page, warm / cold | 0.9 / 4.5 ms | 0.4 / 6.3 ms | 19.5 ms / — | 50 / 100 ms |
| History backward page | 9.9 ms | 0.3 ms | 15.6 ms | 50 ms |
| Dependency traversal, warm / cold | 146 / 261 ms | 160 / 156 ms | 166 ms / — | 250 ms |
| Metadata writes, 16 writers | 43 ops/s, 1,064 ms | 8,391 ops/s, 3.8 ms | 84,148 ops/s, 0.5 ms | 500 ops/s, 50 ms |
| Streamed appends (burst / sustained, daemon) | 6,068 / — | 9,391 / 5,969 per s, max 3.4 ms | 269,886 / — | 1,000/s, 250 ms |
| Projection rebuild after loss | 21.5 s | 0.52 s | 2.7 s | 5 s |
| Store on disk | 118 MB | 211 MB | — | — |

At medium scale SQLite's dependency traversal is 11.5 ms p95 (budget 50 ms) and its projection
rebuild 0.09 s (budget 1 s).

**Checkpoints under sustained load** (`walUnderLoad`, reference machine, SQLite): one writer
appending without pause for 20 s at large scale, with the daemon paging history throughout:

| Readers on other connections | Log file peak | Appends/s | Max append |
|---|---|---|---|
| none (the daemon alone) | 4.2 MB | 5,969 | 3.4 ms |
| polling every 100 ms | 4.2 MB | 5,840 | 4.7 ms |
| short reads back to back | 7.2 MB | 5,420 | 8.8 ms |
| 100 ms snapshots, 10 ms apart | 16.5 MB | 5,822 | 11.7 ms |
| 100 ms snapshots, no pause | **1,212 MB** | 3,108 | 9.0 ms |

Every append committed and every read succeeded in every phase. Only a reader that holds a
snapshot open essentially all the time keeps the log from ever starting over; once it stops, the
idle checkpoint copies everything back and the next write cuts the file to `walLimitBytes`. No
ORCA component reads that way: the daemon's reads are synchronous and never overlap a commit.

**Against the budgets:** SQLite meets every timed one. The file backend misses three at large
scale (metadata writes at 43 ops/s with a 1 s p95, projection rebuild at 21.5 s, and cold
dependency traversal at 261 ms), which is why SQLite is the durable backend. Durability is the
#339 kill-at-each-commit-boundary and recovery tests, which pass; they prove no acknowledged write
is lost and reopening needs no manual step, but the time to reopen after a kill is not yet timed
(see Limitations).

## Decision proposed

### SQLite remains the single durable authority

Metadata, run event logs, plan journals and the artifact index stay in SQLite; artifact bytes
and encrypted records stay as files (`docs/storage/sqlite-metadata.md`). No second durable store
is added.

### Graph database: rejected for now

- **Measured rationale.** Dependency traversal costs the same on all three backends at every
  scale (160 ms SQLite, 146 ms file, 166 ms in RAM at large). The time is spent building and
  walking the in-memory dependency projection, not reading from the store, so even a graph
  engine with zero storage cost could not meet the budget by a wider margin than SQLite already
  does. Multi-hop questions over plans and causal history are answered by that projection, which
  is rebuilt from the authoritative store in 0.5 s at large scale.
- **Cost it would add.** A new engine and dependency to install, upgrade, back up and keep
  consistent with SQLite, with a second recovery path, for no measured gain.
- **Reconsider when** any of these holds on the reference machine: warm dependency traversal
  p95 exceeds 250 ms at large scale (or the dataset grows past the large scale's 25,000 items
  and 100,000-event runs by an order of magnitude) with the time shown to be in the store, not
  the projection; or a product need arises for traversals across runs and plans (for example
  causal history spanning many runs) that the in-memory projection cannot answer within the
  traversal budget.

### Key-value store: rejected as an authority or a coordination mechanism; deferred as a cache

- **Measured rationale.** Every read and write budget is met by SQLite with at least an order
  of magnitude of headroom on writes (8,391 committed ops/s against 500) and history paging
  (0.3 to 0.4 ms against 50 ms). The in-RAM ceiling is faster still, but no ORCA workload needs
  that speed. Projection rebuild after loss, the main case for a disposable cache, takes 0.52 s
  from SQLite at large scale, against a 5 s budget, and the existing on-disk projection cache is
  already disposable and rebuilt from authoritative data (checked byte-identical after loss on
  every benchmark run).
- **Coordination.** Claims, leases, compare-and-swap and fencing stay on the store's contracts
  (#338). Correctness never depends on an evictable cache, so no key-value store is used for it.
- **Reconsider when** any of these holds on the reference machine: projection rebuild after
  loss exceeds 5 s at large scale; a cold history page exceeds 100 ms; or several daemons must
  share a derived cache (multi-daemon control-plane writes are not supported, #339). Any key-value
  cache adopted then must be rebuildable from SQLite and tested after deletion, as the
  `projectionRebuild` workload already does for the current cache.

### SQLite's write-ahead log under a pinned outside reader: a recorded limit

The log stays within `walLimitBytes` under every read pattern ORCA produces. A reader in another
process holding a snapshot open without pause can grow it without bound (1.2 GB in 20 s on the
reference machine) until it stops. This is SQLite's documented behaviour, not a defect, and no
ORCA command reads that way. It is recorded here as an operating limit. **Reconsider when** an
ORCA component or supported tool reads the store from another process for longer than the idle
window at a time; the remedy then is a restart checkpoint once the log passes `walLimitBytes`
(waiting for readers, never on the write path), scoped as its own change.

## Consequences

- No new production dependency, service or recovery path. Backup, restore and verify remain
  one SQLite file plus the store's existing file trees.
- The benchmark keeps running on every store change on `main`, so a regression against these
  budgets is visible without anyone running it; the budgets are the comparison line.
- Adopting a graph or key-value store later is new, separately scoped work with its own
  owner and prerequisites, started only by one of the triggers above.

## Limitations

- One hosted reference machine; no fsync-latency attribution, and the OS page cache is not
  dropped for cold reads (`docs/performance/store-workloads/README.md`).
- Concurrent writers are handles in one process; cross-process exclusion is proven by the store
  tests, not timed.
- Recovery time after a kill is not timed yet; the 5 s budget is checked only by the #339 tests
  completing. A timed reopen-after-kill workload is a follow-up for the benchmark.
- No graph or key-value engine was benchmarked directly. The in-RAM `memory` backend stands in
  as the ceiling any such engine could reach; that is enough to reject them where SQLite already
  meets the budget, but not to rank engines against each other if a trigger fires.
