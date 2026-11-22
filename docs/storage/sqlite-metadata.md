# SQLite metadata backend (#339)

`sqliteStores(dir)` (`packages/store/src/sqlite/`) is a durable store backend that
keeps ORCA's metadata in one SQLite database, `<dir>/metadata.sqlite`, and keeps
everything large or encrypted where it already is. It implements the #338 store
contracts and passes the same conformance suite as the memory and file backends
(`packages/store/test/conformance/`), with the capability matrix in
`docs/contracts/store-contracts-v1.md`.

It is **not the default** and nothing opens it unless asked. Making it a
workspace's backend is a store format change, so the default switch and the
store format epoch bump wait for the format carry-over gates: #897 (updater write
fence), #905 (Linux package hand-off) and #910 (Windows durability).

## What is where

| Data | Backend | Why |
|---|---|---|
| Requests, work items, plans, dependencies, risks, decisions | SQLite `documents` | One row per document; typed queries in SQL; batches and units of work are transactions. |
| Run event log | SQLite `events` | Gap-free `(run_id, seq)`; pages and type reads are index range scans from either end. |
| Plan journal | SQLite `plan_events` | Same shape as the event log. |
| Artifact index | SQLite `artifacts` | The commit point of an artifact `put`. |
| Artifact bytes | files, `<dir>/artifacts/blobs/<sha256>` | Unchanged: content-addressed, synced before the index row commits, verified on read. |
| Private execution records, pinned workflow versions | files, encrypted per record | Unchanged protection (`protected-file.ts`). |
| Claims, leases | files | Their ownership callbacks write other stores while the fence is held; an asynchronous callback cannot run inside a synchronous SQLite transaction without holding the database's write lock across it. |

## Engine and settings

- **Driver:** Node's built-in `node:sqlite` (`DatabaseSync`). No new dependency;
  it is loaded lazily, so a process that never opens a SQLite store never loads it.
- **Journal mode:** WAL, so readers never block the writer and the writer never
  blocks readers.
- **Durability:** `synchronous = FULL`: an acknowledged commit survives power loss
  on storage that honours flushes. The file backend gives the same promise
  (fsync before rename).
- **Writes:** every write is one `BEGIN IMMEDIATE ... COMMIT`. `node:sqlite` is
  synchronous, so no other operation in the process can interleave with a write.
  Contention with another connection is `SQLITE_BUSY`: the connection waits 50 ms,
  then the store retries asynchronously with jittered backoff (1 to 32 ms) until
  the busy deadline (default 10 s, `busyDeadlineMs`), then fails with
  `STORE_LOCK_TIMEOUT`. The event loop is never held for the whole deadline.
- **Write outcomes:** a failure before `COMMIT` rolls back and rejects with the
  underlying error (retry is safe); a failure of `COMMIT` is `STORE_WRITE` with
  `details.outcome: "uncertain"` (re-read before retrying).
- **Schema:** migrations in `sqlite/schema.ts`, tracked in `PRAGMA user_version`,
  applied at open in one transaction. A database from a newer build is refused
  with `STORE_FORMAT` (`reason: "NEWER"`), never opened and half-understood.
- **Ids:** `documents.sort_key` holds the id as UTF-16 code units, so query
  pagination is the contract's code-unit order on every host.

## Deployment and topology

- **One control-plane host owns the database file.** The file must be on a local
  filesystem. SQLite's locking is not reliable over network filesystems (NFS, SMB,
  most FUSE mounts), and two hosts opening one database file over a share can
  corrupt it. **Do not put `metadata.sqlite` on a network share.**
- **Remote workers never open the file.** They reach metadata through the
  control-plane daemon's protocol, as they do today with the file backend.
- **Several processes on the one host** (the daemon, a CLI command, a test
  harness) may open the same database: writes are serialized by SQLite's write
  lock and the conformance suite and `sqlite-store.test.ts` exercise this with
  real child processes.
- **Several active control-plane daemons** writing one workspace are not a
  supported topology until their coordination contract is tested (#339
  non-goal).

## Measured (container, not the reference machine)

The #341 harness runs against SQLite (`--backend sqlite`). A `small` and `medium`
run in a 4-vCPU cloud container (Node 22) compared with the file backend:

| medium | file | sqlite |
|---|---|---|
| History page, forward walk (p50 / p95 ms) | 12.6 / 21.4 | 0.41 / 0.48 |
| History page, backward walk (p50 / p95 ms) | 3.0 / 6.1 | 0.41 / 0.72 |
| Metadata writes, 1 writer (committed ops/s) | 267 | 3,577 |
| Metadata writes, 16 writers (ops/s, p95 ms) | 207, 265 | 4,617, 7.5 |
| Projection rebuild (ms) | 640 | 84 |
| Event appends while seeding (per s) | 3,152 | 4,010 |
| Bytes on disk (incl. WAL) | 19.8 MB | 33.8 MB |

At `large` (SQLite only: 200,000 events, 54,000 dependency edges, 20,000-document
collections) history pages stayed under 1 ms p95 and the log reached 214 MB with
its WAL. Two things to look at before a baseline: a dependency question costs
about 160 ms because one plan's edges are a large result, and single-writer
throughput at that scale dropped to about 400 ops/s with 12 to 24 ms p95 at 4
writers while 16 writers reached 4,750 ops/s, which points at WAL checkpoints
landing inside the measured window.

Every workload invariant held on all backends. These are observations, not the
baseline: the #341 ADR records its budgets and the reference machine first.

## Operations

All four commands work on the configured store directory and never touch the
file-backed metadata they read from.

| Command | What it does |
|---|---|
| `orca store sqlite import` | Mirrors the file store's metadata into `<store>/metadata.sqlite`: collections are replaced, runs and plan journals are extended with the events the database lacks, the artifact index is upserted (blobs are already in place). Ids, sequence numbers and timestamps are copied, never reassigned. Each collection, run and journal is one transaction, so a rerun finishes an interrupted import. History the database has that the files do not is refused (`STORE_FORMAT`, `IMPORT_CONFLICT`), never overwritten. |
| `orca store sqlite backup <file>` | `VACUUM INTO` a consistent copy while the database stays in use, synced and integrity-checked. Refuses an existing file. Blobs, encrypted records, claims and leases are files and are backed up as files. |
| `orca store sqlite restore <file>` | Checks the copy (integrity, schema not newer), then copies, syncs and renames it into place; a crash leaves no database or the whole backup. Refuses a store that already has a database (or a stray `-wal`): move it aside first. |
| `orca store sqlite verify` | Integrity check, per-run and per-plan sequence gaps, every stored event, journal entry and artifact record parsed, every artifact row's blob present and matching its hash. Blobs no row references (an interrupted `put`) are listed, not deleted. Exit 1 on any problem. |

Until a workspace can select SQLite, the database is inert: nothing reads it, and
older ORCA versions ignore the file.

**Crash behaviour.** `sqlite-recovery.test.ts` kills a writer with `SIGKILL` at
random points, four times on one database, and checks that every acknowledged
write survives (at most the one write in flight is also there), journal
operations are never duplicated, event sequences have no gaps, and `verify`
finds no dangling artifact reference: a kill between a blob and its index row
leaves only an unreferenced blob.

## Not in this change (follow-ups under #339)

- Checkpoint behaviour under sustained load, and the `large` scale on the
  reference machine.
- Making SQLite selectable for a workspace, after the format gates above. That
  switch is also when the daemon serves history from it to #255.
