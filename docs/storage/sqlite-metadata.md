# SQLite metadata backend (#339)

`sqliteStores(dir)` (`packages/store/src/sqlite/`) is a durable store backend that
keeps ORCA's metadata in one SQLite database, `<dir>/metadata.sqlite`, and keeps
everything large or encrypted where it already is. It implements the #338 store
contracts and passes the same conformance suite as the memory and file backends
(`packages/store/test/conformance/`), with the capability matrix in
`docs/contracts/store-contracts-v1.md`.

It is **not the default**, and **no workspace can be moved onto it yet**: `orca
store sqlite switch` is refused (`LEGACY_UNFENCED`) until released ORCA versions
that never read the store's format marker can be kept out (see [Choosing SQLite for
a workspace](#choosing-sqlite-for-a-workspace)). Every store stays on files.

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
    commit that crosses it, so that commit pays for the copy. It is a **trigger, not
    a bound**.
  - `idleMs` 1000: once a connection has made no write for a second, it runs a
    passive checkpoint itself, off the write path, so a burst is followed by one
    checkpoint and the log is copied back while the store is quiet. It never waits
    for readers and never fails a write that has committed; anything it could not
    copy is left for the next one. `observe` reports each one (what it copied, how
    long it took, or why it failed).
  - `walLimitBytes` 64 MiB (`journal_size_limit`): what a log file **keeps** once
    SQLite starts it over after a complete checkpoint, or a truncating checkpoint
    runs. It does not limit how far the log grows before then.

  **Nothing bounds the log's growth.** A checkpoint cannot copy past the oldest
  snapshot a reader still holds, and the log cannot start over while one is held,
  so a long read or one large transaction lets it grow past `autoPages` and
  `walLimitBytes` alike (`sqlite-checkpoint.test.ts` shows it with a pinned reader).
  Its size is something to measure and budget, not a promise SQLite keeps.

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

The `walCheckpoint` workload measures checkpoints on one run receiving a sustained
burst of appends, as an agent streaming output does (SQLite runs with the default
settings, separate `--scale` runs from the table above):

| | medium (20,000 appends) | large (50,000 appends) |
|---|---|---|
| Appends per second | 2,729 | 2,936 |
| Append latency p50 / p95 / max (ms) | 0.32 / 0.57 / 10 | 0.30 / 0.53 / 10 |
| Latency outliers (appends over 5 ms) | 7 | 10 |
| Log file before the burst / sampled peak / end of burst | 4.2 / 4.2 / 4.2 MB | 33 / 33 / 33 MB |
| The store's own idle checkpoint (as it reported) | 1 run, 1.4 ms, copied 535 of 535 pages | 1 run, 1.6 ms, copied 677 of 677 pages |
| Truncating checkpoint | 4 ms, log emptied | 23 ms, log emptied |

- **Outliers are measured, not explained.** Roughly one append in 3,000 to 5,000 took
  over 5 ms (at most about 10 ms here, 93 ms in an earlier run). Commits that run the
  automatic checkpoint are the likely cause, but the workload cannot tell them from
  any other slow commit, so they are counted as outliers only. In single-connection
  experiments at 250, 1000 and 4000 `autoPages` the tail was within this container's
  noise, so the default stays at SQLite's 1000.
- **The idle checkpoint does the copying after a burst.** The benchmark runs no
  checkpoint of its own before reading the store's report, and the store's timer
  copied the whole log (the pages written since the last automatic checkpoint).
- **The log file's size is the file earlier work left.** At `large` it was 33 MB
  before the burst began: SQLite reuses a log file from the start instead of shrinking
  it, and `walLimitBytes` (64 MiB) only cuts back what is kept beyond that. The burst
  itself never grew it. The peak is a sampled measurement (every 100 appends) for the
  #341 budget to judge, not a bound SQLite keeps.

Every workload invariant held on all backends. These are observations, not the
baseline: the #341 ADR records its budgets and the reference machine first.

## Choosing SQLite for a workspace

A store records which metadata backend it runs on in its format marker
(`store-format.json`, `packages/store/src/store-backend.ts`):

- **Files** (every store until it is switched): the marker carries the file format,
  `operator-journals-v4`.
- **SQLite**: the marker carries `operator-journals-v4-sqlite`, a store format of its
  own. ORCA opens such a store on SQLite only.

Within this ORCA, that keeps one populated workspace from ever being opened by both
backends:

- ORCA 0.7.1 and later read the marker before opening a store, so one that does not
  know the SQLite format refuses the store as newer than it can open (naming the
  backup below), instead of reading the file metadata the switch left behind.
  **ORCA 0.7.0 and earlier never read the marker.** Nothing in the store stops them
  from opening that file metadata, which no longer keeps up, and writing to it. This
  is why the in-place switch below is refused for now.
- This ORCA's file backend refuses a store recorded for SQLite, and its SQLite backend
  refuses a store recorded for files (`STORE_FORMAT`, `reason: "OTHER_BACKEND"`). Only
  maintenance that builds or checks a database beside the files (`import`, `backup`,
  `verify`, the benchmark) opens one there, and says so.
- The daemon opens whichever backend the marker records, after the same format
  check as always. Closed update validation opens a SQLite store read-only (no
  migration, no setting written).
- A store on SQLite opens **only the database it was switched to**. The switch gives
  the database an id (`store_binding`) and records it in the marker (`sqliteId`).
  Before anything opens the database for the workspace, a read-only check that
  changes nothing refuses a missing database (`METADATA_MISSING`; it is never created
  empty in its place), a file that is not an ORCA database or is bound to no store or
  to another one (`METADATA_MISMATCH`), and a newer schema (`NEWER`). Put it back with
  `orca store sqlite restore` from a backup of that database, or restore the whole
  store from the format backup the marker names.

**Who has the store open.** The format lock covers opening a store, not the time a
writer keeps it open: an idle daemon holds a file store without it. So every ORCA
writer from this one on (the daemon and CLI commands, `import`, `restore`)
registers in `<store>/.store-writers/` while it has the store open
(`packages/store/src/store-writers.ts`). A switch first announces itself in
`<store>/.store-switch.json`, then lists the registrations: it is refused (`BUSY`)
while any belongs to a live process, or to a process on another host it cannot
check, and a writer that starts while the announcement stands is refused
(`SWITCHING`). Each side writes before it reads the other's, so one of them always
sees the other. Registrations and announcements of processes that are gone are
ignored. ORCA versions from before the registry do not register: the marker
records whether one has opened the store (`writerRegistry` is set on a fresh store
and dropped by any older ORCA that rewrites the marker), and the switch refuses
such a store (`OLDER_WRITER`) unless the caller states that every older ORCA using
it is stopped. That statement is the operator's word, not a fence, and it says
nothing about an older ORCA started *after* the switch.

**`orca store sqlite switch`** will be the one way from files to SQLite. **It is
refused for now** (`LEGACY_UNFENCED`, `IN_PLACE_SQLITE_SWITCH` in
`store-format.ts`), changing nothing: a store switched in place keeps its file
metadata beside the database, and a released v0.7.0 or v0.6.0 opens that without
looking at the marker. It stays refused until an enforced boundary keeps those
releases out (or the switch moves the metadata to a separately provisioned store),
proven against a real released build. The steps below are implemented and tested
with the gate off. Under the store's format lock it:

1. Switches only a store in this ORCA's current file format. An older store is
   carried forward first; an unmarked one is opened once first. A store already on
   SQLite is left as it is.
2. **Refuses on Windows** (`UNDURABLE`), changing nothing, for as long as store format
   changes are refused there (#910: until the power-cut test in #947 proves the
   backup taken first survives).
3. Announces itself and checks that no registered writer is alive, and, for a store
   an older ORCA has opened, that the operator said every older ORCA is stopped (see
   above). The announcement stands until the marker is written.
4. Takes a verified whole-store backup into `format-backups/`, exactly as
   `carry-forward` does: refused while a run is active or while anything writes, and
   read back under this ORCA before it counts.
5. Imports (`orca store sqlite import`, below) and verifies (`orca store sqlite
   verify`); a problem leaves the store on files. Then binds the database to the
   store with a new id.
6. Checks that no file of the store changed since the backup and that still no
   writer is registered; a write that landed meanwhile would be missing from the
   database, so the switch is refused instead.
7. Only then writes the SQLite format into the marker, naming the backup and the
   database's id.

A refusal at any step leaves the store on files and in charge; a database the
import built is inert, as after a plain `import`. The desktop app's own workspaces
are refused (`APP_OWNED`), as for `carry-forward`: the app's daemon holds their write
fence, which this command cannot. There is no switch back to files yet: the backup
from step 4 is the store as it was.

## Operations

`import`, `backup`, `restore` and `verify` work on the configured store directory and
never touch the file-backed metadata they read from.

| Command | What it does |
|---|---|
| `orca store sqlite import` | Mirrors the file store's metadata into `<store>/metadata.sqlite`. **Run it with every ORCA using the store stopped**, as for `carry-forward`: the source is read twice and the reads must agree, or the import is refused (`SOURCE_CHANGED`). Then one transaction checks both sides before writing anything: runs, plan journals and artifact records are history, so what the database holds must be exactly a prefix of the source, record for record (same id with different content is a conflict), and nothing may exist only in the database (refused as `STORE_FORMAT` `IMPORT_CONFLICT`). Collections are current state the file store owns until the switch, so they are mirrored. Only then and applies everything: collections replaced, runs and journals extended, the artifact index upserted (blobs are already in place). The commit is the single publish point, so a refused or interrupted import leaves the database as it was, and a rerun is safe. Ids, sequence numbers and timestamps are copied, never reassigned. |
| `orca store sqlite backup <file>` | Refuses a store with no database (never an empty "backup"). `VACUUM INTO` from a read-only connection (never migrating what it copies) into a staging file while the database stays in use, switch it to rollback-journal mode so it is one sealed standalone file, sync and integrity-check it, then hard-link it to `<file>`, which is never replaced. Blobs, encrypted records, claims and leases are files and are backed up as files. |
| `orca store sqlite restore <file>` | Accepts only a sealed backup (refuses a WAL-mode file or one with a `-wal`/`-journal` beside it). Copies it into a staging file in the store, syncs it, checks the **staged** bytes (integrity, ORCA application id, a known schema version with exactly its tables, indexes, views and triggers, still standalone), then publishes with a hard link under a restore lock: if a database (or `-wal`) appeared meanwhile the link fails and nothing is replaced. A crash leaves no database or the whole backup. |
| `orca store sqlite verify` | Read-only: a read-only connection (no migration; a schema this build does not verify is refused), one read snapshot, blobs only read. Checks integrity, per-run and per-plan sequence gaps, every stored event, journal entry and artifact record, and every artifact row's blob (present, matching its hash). Blobs no row references (an interrupted `put`) are listed, not deleted. Exit 1 on any problem. The only files that can appear are SQLite's own WAL coordination files (an empty `-wal` and the `-shm`), which SQLite creates when a reader opens a WAL database nobody else has open; the next writer's clean close removes them. |

Until a store is switched, the database is inert: nothing reads it, and older ORCA
versions ignore the file.

**Crash behaviour.** `sqlite-recovery.test.ts` kills a writer with `SIGKILL` at
random points, four times on one database, and checks that every acknowledged
write survives (at most the one write in flight is also there), journal
operations are never duplicated, event sequences have no gaps, and `verify`
finds no dangling artifact reference: a kill between a blob and its index row
leaves only an unreferenced blob.

## Not in this change (follow-ups under #339)

- Reference numbers for the #341 baseline come from the store workload workflow on a
  GitHub-hosted runner (`docs/performance/store-workloads/README.md`); the numbers
  above are from a cloud container.
- Turning the switch on: an enforced boundary against released ORCA versions that
  ignore the marker (v0.7.0, v0.6.0), with coverage against a real released build,
  or a migration into a separately provisioned store.
- Switching from the desktop app, which holds its workspaces' write fence, and on
  Windows once store format changes are allowed there (#947).
- A switch back from SQLite to files.
