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
- **Checkpoints:** a checkpoint copies committed pages from `metadata.sqlite-wal`
  back into the database. Three settings (`SqliteOptions.checkpoint`, defaults in
  `SQLITE_CHECKPOINT`):
  - `autoPages` 1000 (about 4 MB): SQLite's automatic passive checkpoint, run by the
    commit that crosses it. It is the bound for a connection that never goes quiet,
    and that one commit pays for the copy (see the measurements below).
  - `idleMs` 1000: once a connection has made no write for a second, it runs a
    passive checkpoint itself, off the write path, so a burst is followed by one
    checkpoint and the log is copied back while the store is quiet. It never waits
    for readers and never fails a write that has committed; anything it could not
    copy is left for the next one.
  - `walLimitBytes` 64 MiB (`journal_size_limit`): after a large transaction (an
    import, a big unit of work) the log file is cut back to this size once it has
    been checkpointed, instead of keeping its largest size for good.

  `SqliteDatabase.checkpoint("truncate")` copies everything and empties the log, for
  maintenance; it waits for other connections and is never run on the write path.
- **Writes:** every write is one `BEGIN IMMEDIATE ... COMMIT`. `node:sqlite` is
  synchronous, so no other operation in the process can interleave with a write.
  Contention with another connection is `SQLITE_BUSY`: the connection waits 50 ms,
  then the store retries asynchronously with jittered backoff (1 to 32 ms) until
  the busy deadline (default 10 s, `busyDeadlineMs`), then fails with
  `STORE_LOCK_TIMEOUT`. The event loop is never held for the whole deadline.
- **Reads:** every read is one `BEGIN DEFERRED ... COMMIT` snapshot, so a read
  made of several statements (rows and a write counter; an observation's size
  check and its rows) never mixes two commits of another connection.
- **Write outcomes:** a failure before `COMMIT` rolls back and rejects with the
  underlying error (retry is safe); a failure of `COMMIT` is `STORE_WRITE` with
  `details.outcome: "uncertain"` (re-read before retrying).
- **Schema:** migrations in `sqlite/schema.ts`, tracked in `PRAGMA user_version`,
  applied at open in one transaction. A database from a newer build is refused
  with `STORE_FORMAT` (`reason: "NEWER"`) before anything can change the file
  (journal mode included), never opened and half-understood.
- **Identity:** every ORCA metadata database carries `PRAGMA application_id`
  `0x4f524341` ("ORCA"). The opener refuses any other non-empty SQLite file
  (`FOREIGN`); restore and verify also require exactly the tables, indexes, views and triggers of the
  database's schema version as the migrations define them, nothing missing and nothing extra
  (`SCHEMA_MISMATCH`), so a healthy but unrelated database is never published as
  `metadata.sqlite`.
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
collections) history pages stayed under 1 ms p95 and the log reached 212 MB. A
dependency question costs about 160 ms because one plan's edges are a large result
(a #341 question, not a storage setting).

### Checkpoints

An earlier `large` run reported single-writer throughput of about 400 ops/s, which
looked like checkpoints landing inside the measured window. With the checkpoint
settings above it did not recur: 1, 4 and 16 writers reached 4,186, 4,595 and
4,843 committed ops/s (p95 0.36, 1.7 and 6.9 ms). It did not recur without them
either: two `large` runs on the previous settings (one full, one of the write
workload alone) gave 3,388 to 4,798 ops/s at every writer level. The 400 ops/s
was this container's noise, not a checkpoint cost.

The `walCheckpoint` workload measures the checkpoints directly: one run receiving a
sustained burst of appends, as an agent streaming output does.

| | medium (20,000 appends) | large (50,000 appends) |
|---|---|---|
| Appends per second | 2,622 | 3,083 |
| Append latency p50 / p95 / max (ms) | 0.34 / 0.59 / 17 | 0.28 / 0.49 / 93 |
| Appends over 5 ms | 2 | 16 |
| Log file at its largest | 4.2 MB | 33 MB |
| Checkpoint after the idle window | nothing left (0.05 ms) | nothing left (0.03 ms) |
| Truncating checkpoint | 3 ms, log emptied | 19 ms, log emptied |

- The automatic checkpoint is the cost a writer sees: about one append in 3,000 runs
  one and takes 5 to 90 ms. That is the price of a bounded log under `synchronous =
  FULL`. A larger `autoPages` makes those commits rarer but longer, and a smaller one
  the reverse; in single-connection experiments at 250, 1000 and 4000 pages the tail
  was within this container's noise, so the default stays at SQLite's 1000.
- The idle checkpoint does its job: after a burst, the next checkpoint finds nothing
  to copy.
- The log file at `large` reached 33 MB, not 4 MB: while other connections were reading
  (the earlier workloads keep their handles open), SQLite could not start the log over
  and it kept growing. It stayed under the 64 MiB limit, and the limit is what brings
  it back down afterwards.

Every workload invariant held on all backends. These are observations, not the
baseline: the #341 ADR records its budgets and the reference machine first.

## Operations

All four commands work on the configured store directory and never touch the
file-backed metadata they read from.

| Command | What it does |
|---|---|
| `orca store sqlite import` | Mirrors the file store's metadata into `<store>/metadata.sqlite`. **Run it with every ORCA using the store stopped**, as for `carry-forward`: the source is read twice and the reads must agree, or the import is refused (`SOURCE_CHANGED`). Then one transaction checks both sides before writing anything: runs, plan journals and artifact records are history, so what the database holds must be exactly a prefix of the source, record for record (same id with different content is a conflict), and nothing may exist only in the database (refused as `STORE_FORMAT` `IMPORT_CONFLICT`). Collections are current state the file store owns until the switch, so they are mirrored. Only then and applies everything: collections replaced, runs and journals extended, the artifact index upserted (blobs are already in place). The commit is the single publish point, so a refused or interrupted import leaves the database as it was, and a rerun is safe. Ids, sequence numbers and timestamps are copied, never reassigned. |
| `orca store sqlite backup <file>` | Refuses a store with no database (never an empty "backup"). `VACUUM INTO` from a read-only connection (never migrating what it copies) into a staging file while the database stays in use, switch it to rollback-journal mode so it is one sealed standalone file, sync and integrity-check it, then hard-link it to `<file>`, which is never replaced. Blobs, encrypted records, claims and leases are files and are backed up as files. |
| `orca store sqlite restore <file>` | Accepts only a sealed backup (refuses a WAL-mode file or one with a `-wal`/`-journal` beside it). Copies it into a staging file in the store, syncs it, checks the **staged** bytes (integrity, ORCA application id, a known schema version with exactly its tables, indexes, views and triggers, still standalone), then publishes with a hard link under a restore lock: if a database (or `-wal`) appeared meanwhile the link fails and nothing is replaced. A crash leaves no database or the whole backup. |
| `orca store sqlite verify` | Read-only: a read-only connection (no migration; a schema this build does not verify is refused), one read snapshot, blobs only read. Checks integrity, per-run and per-plan sequence gaps, every stored event, journal entry and artifact record, and every artifact row's blob (present, matching its hash). Blobs no row references (an interrupted `put`) are listed, not deleted. Exit 1 on any problem. The only files that can appear are SQLite's own WAL coordination files (an empty `-wal` and the `-shm`), which SQLite creates when a reader opens a WAL database nobody else has open; the next writer's clean close removes them. |

Until a workspace can select SQLite, the database is inert: nothing reads it, and
older ORCA versions ignore the file.

**Crash behaviour.** `sqlite-recovery.test.ts` kills a writer with `SIGKILL` at
random points, four times on one database, and checks that every acknowledged
write survives (at most the one write in flight is also there), journal
operations are never duplicated, event sequences have no gaps, and `verify`
finds no dangling artifact reference: a kill between a blob and its index row
leaves only an unreferenced blob.

## Not in this change (follow-ups under #339)

- The `large` scale on the reference machine, for the #341 baseline. The numbers
  above are from a cloud container.
- Making SQLite selectable for a workspace, after the format gates above. That
  switch is also when the daemon serves history from it to #255. **Precondition
  for that change:** a populated workspace can never be opened by both backends.
  The selection records the backend in the store, each backend refuses a store
  recorded for the other, and the only way from file to SQLite is the supported
  import-then-switch migration.
