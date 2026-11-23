# SQLite metadata backend (#339)

`sqliteStores(dir)` (`packages/store/src/sqlite/`) is a durable store backend that
keeps ORCA's metadata in one SQLite database, `<dir>/metadata.sqlite`, and keeps
everything large or encrypted where it already is. It implements the #338 store
contracts and passes the same conformance suite as the memory and file backends
(`packages/store/test/conformance/`), with the capability matrix in
`docs/contracts/store-contracts-v1.md`.

It is **not the default**. A workspace runs on it only after `orca store sqlite
convert` has converted its store into a SQLite store of its own (see [Choosing
SQLite for a workspace](#choosing-sqlite-for-a-workspace)); every other store stays on
files.

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

- **Files** (every store until it is converted): the marker carries the file format,
  `operator-journals-v4`.
- **SQLite**: the marker carries `operator-journals-v4-sqlite`, a store format of its
  own. ORCA opens such a store on SQLite only.

That keeps one populated workspace from ever being opened by both backends, by
any ORCA:

- ORCA 0.7.1 and later read the marker before opening a store, so one that does not
  know the SQLite format refuses the store as newer than it can open (naming the
  backup below).
- **ORCA 0.7.0 and earlier never read the marker**, so a SQLite store keeps them out
  with the [legacy fence](#the-legacy-fence) below: every path they open first holds a
  marker instead of what they expect, and they refuse the store before writing
  anything. A converted store has the fence before anything has ever opened it.
- This ORCA's file backend refuses a store recorded for SQLite, and its SQLite backend
  refuses a store recorded for files (`STORE_FORMAT`, `reason: "OTHER_BACKEND"`). Only
  maintenance that builds or checks a database beside the files (`import`, `backup`,
  `verify`, the benchmark) opens one there, and says so.
- The daemon opens whichever backend the marker records, after the same format
  check as always. Closed update validation opens a SQLite store read-only (no
  migration, no setting written).
- A store on SQLite opens **only the database it was switched to**. The switch (the
  last step of a conversion) gives
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
ignored. ORCA versions from before the registry do not register; the legacy fence
below turns them away when they start, but cannot stop one that is already running.

### The legacy fence

`packages/store/src/sqlite/legacy-fence.ts`. A released v0.7.0 or v0.6.0 opens a
store without reading its marker, so the switch puts a marker at every path they
open before they write:

| Path | Becomes | What a released ORCA does |
|---|---|---|
| `private-execution/.execution-key`, `private-workflows/.execution-key` | a marker file (not a 32-byte key); the key is hard-linked to `.execution-key.sqlite`, where this ORCA reads it | v0.7.0 reads these keys while it starts and refuses every command (`RUN_STATE`), the daemon included |
| `requests.json`, `work-items.json`, `plans.json`, `dependencies.json`, `risks.json`, `decisions.json` | a marker file that is not a JSON array | v0.6.0's reads fail, and its writes (read, change, write under a lock) fail before writing |
| `runs/`, `plans/` | a marker file | creating or reading a log fails (`EEXIST`, `ENOTDIR`) |
| `workflows/` (snapshots pinned before 0.7) | a marker file; the directory moves to `workflows.sqlite/`, where this ORCA reads it | the same |
| `artifacts/index.jsonl` | a marker directory; the blobs beside it stay | reading it fails (`EISDIR`) |

The keys and collection files are each replaced by a single rename, so they are never
missing. The directories and the index are renamed aside and then replaced, so for an
instant nothing stands at their path.

`tools/legacy-fence/run.js` (CI: `legacy-fence.yml`, Linux) builds v0.7.0 and v0.6.0
from their tags, makes workspaces with v0.7.0's own demo, starts a released daemon of
each version on one, converts it with the current CLI (`orca store sqlite convert`;
the file store must not change by a byte), and runs every released command that opens
the store (`runs`, `status`,
`events`, `plan ...`, `claims ...`, `leases ...`, `admissions`, `answer`, `resume`,
`submit`, `run`, `serve`), first against an unconverted workspace (the baseline) and
then against the converted one. A command passes only if, in the baseline, it exists
in that release, takes its arguments and reaches the store without timing out; and,
on the converted store, exits with one of that release's store refusals (above) that
its baseline output does not show, leaving every byte of the store as it was. A
command the release does not have (`admissions` in v0.6.0) is reported as such.
v0.6.0's `serve` opens nothing at start, so it comes up: it is sent every store
request (`runs.list`, `runs.get`, `runs.events`, `plans.list`, `inputs.list`,
`claims.list`, `runs.start`), each answered in the baseline and refused on the converted
store. Reported apart as answered, never as refused: v0.6.0's `leases list`, from the
lease files both backends keep, and `workflows.list`, from the workflows a daemon
registered in memory.

The daemons that were already running must keep answering from the file store
(`runs.list`, `plans.list`) and change nothing in the new one; a v0.7.0 write to the
file store afterwards must be reported by `orca store format`; and the in-place
`orca store sqlite switch` must still refuse and change nothing.

**What the fence does not do.** It turns away a released ORCA that starts, or opens a
fenced path, after the fence is in place. It does not stop one that is already
running: an idle v0.7.0 daemon, or a command between two writes, holds what it read
and may write it back, over a marker. Released versions leave nothing in the store
while idle that could be checked for. That is why a store is converted into a new one
rather than switched in place.

### Converting a workspace: `orca store sqlite convert`

`packages/store/src/store-convert.ts`. The one way from files to SQLite. It converts
the workspace's file store into a SQLite store of its own beside it, `<store>-sqlite`
(`.orca` becomes `.orca-sqlite`), names that store in the workspace's config, and
leaves the file store exactly as it was. Under the file store's format lock:

1. Converts only a store in this ORCA's current file format (an older one is carried
   forward first, an unmarked one opened once first); a store already on SQLite is
   left as it is. **Refuses on Windows** (`UNDURABLE`) for as long as store format
   changes are refused there (#947), and the desktop app's own workspaces
   (`APP_OWNED`): the app's daemon holds their write fence, which this command cannot.
   Needs exactly one existing config in the workspace (`CONFIG_INVALID`, before anything
   is copied): a config is never created, since a new one would be in use before it
   could be checked against the other names a config may have, and could not be taken
   back; with two, which one an ORCA opens depends on how it was started.
2. Announces itself and checks that no registered writer of this ORCA is alive
   (`BUSY`), and that no run is active.
3. Copies the store whole into staging beside it (`<store>-sqlite.staging-<id>/store`,
   with a record of the store and the process that made it), checks every copied
   file's bytes, and checks the store did not change meanwhile (`BUSY`).
4. Switches the copy in place, as below, with no backup (the file store is the
   backup): import, verify, bind, the legacy fence, and the SQLite marker, which also
   records the file store and the signature of its files (`convertedFrom`).
5. Checks the file store once more and renames the copy to `<store>-sqlite`, then
   flushes the new store and its parent directory. From then on that store is never
   removed by ORCA: another config could already name it.
6. Checks that it is a complete conversion of the file store as the file store is now,
   under its own format lock: its marker names this store and the signature; no switch
   of it is half done; the legacy fence is complete; its database is the one it is
   bound to and verifies. Anything else is refused (`SWITCH_REFUSED`, or
   `SOURCE_CHANGED` when the file store changed), leaving both stores and the config as
   they are. The new store and its parent directory are flushed again (also when an
   interrupted conversion is resumed), so the config never names a store whose rename
   a power loss could still undo; a failed flush leaves the config as it is.
7. Writes the config, under the config writer's lock (`<config>.lock`, the one
   `config.set` takes), and only if the config is still the revision read when the
   conversion began, is still the only config beside it, and still names the file
   store; otherwise `CONFIG_STALE`, and nothing is written. `storeDir` names the new
   store (relative if it was relative; YAML is edited in place, so comments stay). The
   config's rename is the commit: every ORCA started afterwards, released ones
   included, opens the new store.

A refusal before step 5 publishes nothing and removes its own staging. Staging an
interrupted conversion left is removed by the next one only when its record names
this store and a process on this host that is gone; anything else with a similar name
is left alone. A conversion that stopped after step 5 (killed, refused, or its config
write lost) is finished by the next one through steps 6 and 7, or refused and left for
the operator to move out of the way. Anything else already at `<store>-sqlite` is
refused.

**A released ORCA that was already running** keeps the file store it opened, and
nothing it does reaches the new store. What it writes there afterwards is not in the
new store: `orca store format` on the new store compares the file store with the
signature the conversion recorded and says `CHANGED since` when it differs. Stop
every older ORCA before converting to avoid that; the conversion cannot check for
them.

**To go back**, stop every ORCA using either store, keep both stores, and point
`storeDir` at the file store again: the conversion never changed it. That selects the
file store as it is; work recorded only in the SQLite store after the conversion does
not follow it back, and the two histories are never merged. Keep the SQLite store if
that work matters.

### The desktop app's own workspaces

`packages/cli/src/desktop-sqlite-switch.ts`. The app's workspaces cannot be converted
into a new store: the app always uses `.orca`, and its ownership claim pins the exact
config. They are switched in place instead, under the workspace's kernel-lifetime
writer fence, which only one writer holds at a time.

**Supported boundary.** An app workspace is supported only with ORCA 0.7.0 and later,
the versions that know app workspaces: their writable startup (the app's daemon and
the CLI alike) enters the first-run writer fence, with a launch the app granted,
before it opens the store (checked against released v0.7.0 and v0.7.1). Within that
boundary, a daemon holding the fence knows no other ORCA writes the store. An ORCA
from before 0.7 pointed at an app workspace by hand is outside it: the legacy fence
turns one away if it starts after the switch, but one already running is not seen.

The app asks for the switch on one daemon launch (`storeSwitch: "sqlite"` in
`daemon-process.ts`, which sets `ORCA_STORE_SWITCH=sqlite` for that child only; never
inherited, never on a closed update launch). The daemon, after its format check and
before it registers as a writer or opens the store, runs the switch below with its
writer hold as the `fence`. The fence is checked before anything changes, before the
journal, before the marker is staged, and at the marker's rename (after the temporary
marker was written and flushed).

- A refusal while the launch still holds the fence is an outcome, not a failure: the
  store stays on files, and the daemon starts on files, logs why and reports it
  (`OrcaApp.storeSwitch`).
- A lost fence (`FENCE_LOST`), or a refusal after which the launch no longer holds
  it, undoes the switch and then **aborts the launch** before it opens the store: it
  is no longer the workspace's writer.
- A daemon outside an app workspace (no fence) refuses (`SWITCH_REFUSED`) and points
  to `convert`. Windows is refused (#947).

**How the app asks** (`packages/app/src/main/store-switch.ts`). The daemon reports its
store in `hello.store` (protocol 2.7): the backend, whether the switch is available
(an app workspace on files, its fence held, not Windows) and how a switch asked for on
its launch ended. Config shows a "Workspace storage" section with the backend and that
outcome, and "Switch to SQLite" when main offers it. Main alone decides: only for the
connected bundled first-run daemon reporting the switch available. After a
confirmation, the restart goes through the update guards: drafts prepared, the
daemon's admission closed and drained (refused while a run is active), the exact
daemon stopped and its exit observed, its first-run reservation settled. Then a
request naming the workspace is written (`<userData>/store-switch/request.json`) and
ORCA restarts. The next owned launch of that workspace asks for the request, which is
spent by asking whether or not it names the workspace, and starts its daemon with the
switch; an update recovery's launch never does. A refusal before the stop reopens
admission on the running daemon; after it, nothing restarts the old daemon, and
reopening ORCA starts the workspace on files.

**Not offered yet.** Released-binary and native signed/installed acceptance of the
switch and of its rollback is a separate gate. Until it passes, the app offers the
switch only when started with `ORCA_SQLITE_SWITCH=1`, which only that acceptance sets.

### The switch in place

**`orca store sqlite switch`** always refuses (`SWITCH_REFUSED`) and changes nothing,
because it cannot make sure no released ORCA is still running against the store
(above); it points to `convert`. The switch itself, `switchStoreToSqlite` in the store
package, is what a conversion runs on its fresh copy (with `copyOf`: no backup, the
source recorded), and what the desktop app's daemon runs under its writer fence (with
`fence`). Under the store's format lock it:

1. Switches only a store in this ORCA's current file format. An older store is
   carried forward first; an unmarked one is opened once first. A store already on
   SQLite is left as it is.
2. **Refuses on Windows** (`UNDURABLE`), changing nothing, for as long as store format
   changes are refused there (#910: until the power-cut test in #947 proves the
   backup taken first survives).
3. Announces itself and checks that no registered writer is alive. The
   announcement stands until the marker is written.
4. Takes a verified whole-store backup into `format-backups/`, exactly as
   `carry-forward` does: refused while a run is active or while anything writes, and
   read back under this ORCA before it counts.
5. Imports (`orca store sqlite import`, below) and verifies (`orca store sqlite
   verify`); a problem leaves the store on files. Then binds the database to the
   store with a new id.
6. Checks that no file of the store changed since the backup and that still no
   writer is registered; a write that landed meanwhile would be missing from the
   database, so the switch is refused instead.
7. Records the switch in a journal (`<store>/.sqlite-switch/journal.json`, durable),
   then puts the legacy fence in place, setting each original aside in
   `.sqlite-switch/aside/`. It compares the originals with the snapshot from step 4
   once more: a released ORCA that wrote while the fence went in is caught here, and
   the switch is refused with every original put back.
8. Only then writes the SQLite format into the marker, naming the backup and the
   database's id. That rename is the commit, and it is flushed before the journal and
   what it set aside go (the database and the backup hold all of it).

A refusal at any step leaves the store on files and in charge, every marker gone and
every original back, durably, before the journal goes; a database the import built is
inert, as after a plain `import`. A failure after the marker's rename (its flush) may
have published it, so it is not rolled back: the journal stays, and the next start
settles the store from the marker that is actually there. So does any failure that
leaves the marker unreadable.

**Interrupted.** If the switch is killed after step 7 began, the journal stays. Until
the next start of this ORCA, released ORCA versions are already fenced out from the
first marker on, and this ORCA's read-only opens refuse the store (`INTERRUPTED`).
The next write-mode start (any command, the daemon, or `switch` again) settles it
under the format lock: with the marker still on files, every original goes back and
every marker goes, durably, leaving the store exactly as before the switch; with the
marker and the database both naming the journal's switch, the fence is completed and
the marker flushed again before the journal is dropped. Anything else (a marker or a
database naming another switch) is refused (`INTERRUPTED`) and left as it is.
`sqlite-legacy-fence.test.ts` kills a switch at each of these points and checks
both outcomes byte for byte. The desktop app's own workspaces
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
| `orca store sqlite restore <file>` | Accepts only a sealed backup (refuses a WAL-mode file or one with a `-wal`/`-journal` beside it). Copies it into a staging file in the store, syncs it, checks the **staged** bytes (integrity, ORCA application id, a known schema version with exactly its tables, indexes, views and triggers, still standalone, and, in a store on SQLite, bound to that store: a backup of another store, or of a database bound to none, is refused as `METADATA_MISMATCH` before anything is published), then publishes with a hard link under a restore lock: if a database (or `-wal`) appeared meanwhile the link fails and nothing is replaced. A crash leaves no database or the whole backup. |
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
- Converting from the desktop app, which holds its workspaces' write fence; on
  Windows once store format changes are allowed there (#947); a release check on
  macOS (the conversion runs there; the check runs on Linux).
- Bringing writes a released ORCA made to the file store after a conversion into the
  new store; they are reported, not merged.
- A switch back from SQLite to files.
