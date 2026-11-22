# Store contracts v1 (#338)

Implementation baseline: main `4fb74e47`. The types and gates live in
`packages/store/src/store-contracts.ts`; the reusable conformance suite is
`packages/store/test/conformance/` and runs against the memory, file and SQLite
(#339) backends. A backend is accepted when it passes the same suite with the
capability matrix it declares.

This contract changes **nothing on disk**. Every file the store writes keeps its
name, layout and content; the store format epoch (`store-format.ts`, #566) is not
touched, and any future format change still waits for the updater write fence
(#897).

## Versioning

There are two independent version numbers, and neither implies the other:

| What | Where | Changes when |
|---|---|---|
| **Contract version**, one per seam | `STORE_CONTRACT_VERSIONS` | A documented guarantee below is weakened or changed. Adding an optional capability does not bump it. |
| **Store format epoch** | `store-format.json`, `STORE_FORMAT_EPOCH` | The bytes on disk change shape. Governed by #566 and #897. |

All seven seams are at contract version **1**. A backend's
`StoreCapabilityMatrix` states the contract versions it meets and every optional
capability as `true` or `false`; `Stores.capabilities` carries it.

## Authoritative and derived data

| Seam | Authoritative | Derived (rebuildable, never the source of truth) |
|---|---|---|
| Event | The run's append-only log (`runs/<runId>.jsonl`, private payloads in the execution store). | Run state, step state, work-item status, summaries and every read model: projections of the log. The tail cache (`lastSeq`, size, inode) in `JsonlLogDir`. |
| Artifact | The index record (`artifacts/index.jsonl`) **and** the blob it names. A blob with no index record is not an artifact. | The in-memory index map. `size`/`mediaType` are the producer's claims, checked only by hash. |
| Document | The collection file (`<name>.json`). | The per-process cache (trusted only while `{ino,size,mtimeMs}` holds) and the document version, which is computed from content. |
| Claim | One file per claim (`claims/<id>.json`). | Nothing. |
| Lease | One file per lease (`leases/`). | `lapsed()` is computed from `renewedAt`, `ttlMs`, host and pid on every read. |
| Journal | The plan's append-only log (`plans/<planId>.jsonl`). | Plan read models. The plan/dependency/risk/decision collections are documents of their own, authoritative for current state. |
| Workflow version | The first snapshot written for `(id, version)`. | `versions()` is a directory listing. |

## The seven seams

Each seam lists identity, ordering, durability, retention and errors. "Durable"
means the file backend has synced the bytes before the call resolves; the memory
backend makes no durability promise (`durable: false`).

### 1. Event (`EventStore`)

- **Identity:** `(runId, seq)`; `id` is a unique `evt_` id assigned by the store; `at` is the store's clock.
- **Ordering:** `seq` is per run, gap-free, starting at 0, decided under the run's lock so concurrent appenders across processes never share or skip one (#97). `read`, `readTypes` and `readRange` are oldest first. `readRange` applies `types` and `match` *before* `limit`, and `after`/`before` are exclusive cursors, so walking pages reconstructs the log exactly.
- **Durability:** an append resolves after the line is durable; subscribers are notified only after that, so a subscriber can always read what it was told about.
- **Retention:** the log is never truncated or compacted by the store. A torn last line from a crash is skipped on read and truncated by the next append under the lock.
- **Errors:** an unknown run reads as empty (`[]`, `lastSeq` `undefined`). A failed append is `STORE_WRITE`; lock starvation is `STORE_LOCK_TIMEOUT`. Observation and admission boundaries fail closed with `RUN_STATE`.
- **Optional:** `appendDurableUnique` (`event.durableUnique`) and `readObservation` (`event.observation`). Production journal services refuse a store without them.

### 2. Artifact (`ArtifactStore`)

- **Identity:** artifact `id` for the record; the blob is content-addressed by `contentHash` (SHA-256 of the bytes). Identical bodies share one blob.
- **Ordering:** none promised for `list`. A re-put of the same `id` replaces the record (last write wins), so a retried put is idempotent.
- **Durability:** the blob is written, synced and linked into place (never replaced) *before* the index record is appended.
- **Retention:** blobs and records are kept; nothing deletes them.
- **Errors:** `ARTIFACT_MISSING` for an unknown id or a missing blob; `ARTIFACT_INVALID` when a body does not match its hash, on put (`artifact.verifiedContent`, file backend only: the memory backend accepts whatever hash it is given, which test fixtures rely on) and on read by the file backend.
- **Blob and metadata are not one transaction.** If the blob write succeeds and the index append fails, the put rejects, the blob is invisible to every reader, and a retried put adopts it. `FileArtifactStore.unreferencedBlobs()` (`artifact.orphanInventory`, also on `SqliteArtifactStore`) lists such blobs. It is a projection of the index *as it is now*, not permission to reclaim: it reports and never deletes, because a concurrent put may sit between its blob and its record, so a reclaimer must re-check under its own fence (or after a grace period) before deleting anything it lists.

### 3. Document (`DocumentStore<T>`)

- **Identity:** `doc.id` within one collection.
- **Ordering:** `list` has no promised order. `query` (and the `queryDocuments` adapter) returns ascending **code-unit** id order, which is the same on every host and locale; `after` is an exclusive id cursor and `next` is present only when more remain.
- **Durability:** a write resolves after the whole collection has been synced and renamed into place under the collection lock. Concurrent writers in several processes never lose an update (#196, #197); writes from one process are coalesced, and each call still resolves only once its own change is on disk.
- **Atomicity (`document.batchAtomic`):** `putMany` is all-or-nothing to every reader, within one collection. Atomicity *across* collections is `metadata.unitOfWork`: `false` for memory and file, where `runUnitOfWork` refuses with `NOT_SUPPORTED` rather than running the work non-atomically, and `true` for SQLite (see below).
- **Versions and compare-and-swap (`document.versioned`):** `getVersioned` returns an opaque version (an ETag). `putIfVersion(doc, expected)` and `deleteIfVersion(id, expected)` write only while the stored version is `expected` (`null` means "absent"); the check runs inside the collection lock against the freshly read file, so of two **state-changing** writers holding one version exactly one wins, across processes. A lost race is an outcome, `{ ok: false, current }`, not an error, and `current` is what to rebase on. A replayed state-changing request loses to its own earlier write, which the caller can recognise by the returned version.
  - **No-op writes.** The one-winner guarantee is for writes that change the document. Because the shipped backends' version is a content hash, a conditional write whose document equals the stored one (or a conditional delete-then-recreate of identical content) leaves the version unchanged, so a second writer holding that version can also succeed. That is safe for lost-update protection (nothing a writer read has changed), but a caller that needs to *count* writers, rather than protect content, must not rely on CAS of identical content; a backend with a revision counter (#339) may be stricter and still conform.
  - **Outcome of a failed write.** On the file backend the rename is the commit point. A failure before it rejects with the underlying error and nothing was committed, so a retry is safe. A failure of the rename itself rejects with `STORE_WRITE` and `details.outcome: "uncertain"`: the write may have landed, so re-read (`getVersioned`) before retrying. A failure after the rename (refreshing the cache fingerprint, releasing the lock) does not reject, because the write is committed and its results stand; a lock that could not be released shows up on the next write as `STORE_LOCK_TIMEOUT`.
  - **Snapshot ownership.** A collection owns its documents. `put`, `putMany` and `putIfVersion` store a copy of the caller's object (taken at the call, before the write lands), and `get`, `list`, `query`, `getVersioned` and a conflict's `current` each return a fresh copy. Mutating an input or a returned document therefore never changes the stored document or its version without a write.
  - **Commit boundary.** `getVersioned` reads committed state only (unlike `get`/`list`/`query`, which also show the calling process's own queued unconditional writes). A conditional write is decided against, and resolves with, exactly the state its own write commits: on the file backend it always ends its write batch, so a later queued mutation can never overwrite it inside the same write, and its caller resumes before any later write commits. A success's `version` and a conflict's `current` therefore always describe a committed state. If the write fails, every mutation it carried (conditional or not) rejects and none is retried or resurrected by a later write.
  - The shipped backends derive the version from content (SHA-256 of the canonical JSON as it parses back), so it changes exactly when the stored document changes and costs no on-disk field. Content versions do not detect A→B→A; a backend with a stored revision counter may, and callers must only compare versions for equality.
- **Typed queries (`document.query`):** `query({ where, limit, after })` matches top-level scalar fields by equality. Memory and file serve it by filtering the collection (`document.query: false` marks that it is not natively indexed); SQLite serves it in SQL (`document.query: true`), matching JSON types exactly (`true` is not `1`, `null` is a present null). `queryDocuments` gives every `DocumentStore`, versioned or not, the same answers.
- **Retention:** documents stay until deleted. **Errors:** a missing id is `undefined`; an invalid `limit` is a `RangeError`; asking a store without versioning for `asVersionedDocumentStore` is `NOT_SUPPORTED`. There is deliberately no adapter that emulates CAS over `get`/`put`.

### 4. Claim (`ClaimStore`)

- **Identity:** `workItemId`, held by `(runId, branch)`.
- **Ordering:** `list` has no promised order.
- **Atomicity:** `claim` is a compare-and-set (link into place): exactly one claimant wins, across processes, and every claimant is returned the incumbent. A retried claim by the same owner returns its own claim.
- **Fencing:** `release(workItemId, runId)` only removes a claim `runId` holds; `beforeRelease` runs under the same lock, so a successor cannot claim mid-release.
- **Retention:** claims are not released when the child run finishes; release is an explicit operator act.
- **Errors:** a lost claim is an outcome (compare owners), not an error. `CLAIM_NOT_FOUND` is raised by the engine's operator paths, not the store.

### 5. Lease (`LeaseStore`)

- **Identity:** `resource` (the engine uses `run:<runId>`), held by `holder` (one per attachment).
- **Atomicity:** `acquire` is a compare-and-set; exactly one holder wins (#101). The same holder re-acquiring refreshes in place and keeps `acquiredAt`.
- **Liveness:** a lease lapses when `renewedAt + ttlMs` has passed, or its holder was a process on this host that is gone. A lapsed lease may be taken over.
- **Fencing (#267):** `withOwnership(lease, write)` runs `write` under the same exclusion as takeover and release, and throws `RUN_LEASED` once the caller no longer holds that exact lease; `renew` returns `undefined`; `release` by a stale holder does nothing.
- **Retention:** a lease stays on file until released, force-released or taken over. Legacy and unreadable records fail closed.

### 6. Journal (`PlanJournal`)

- **Identity:** `(planId, seq)`; `id` is a unique `pev_` id.
- **Ordering, durability, retention:** as the event seam: per-plan gap-free `seq` decided on disk under the plan's lock, subscribers notified after the append, never truncated except a torn tail.
- **Errors:** an unknown plan reads as empty.

### 7. Workflow version (`WorkflowVersionStore`)

- **Identity:** `(id, version)`.
- **Atomicity:** write-once. The first definition written for a pair is the one every later reader sees; `put` returns `true` only for the write that won, across processes. A duplicate put returns `false` and changes nothing.
- **Ordering:** `versions(id)` is sorted (string order).
- **Retention:** snapshots are never removed; a run resumes on the definition it started with.
- **Errors:** a missing pair is `undefined`; an unreadable snapshot is `WORKFLOW_INVALID`.

## Capability matrix

| Capability | memory | file | sqlite |
|---|---|---|---|
| `durable` | no | yes | yes |
| `crossProcess` | no | yes | yes |
| `document.versioned` | yes | yes | yes |
| `document.query` (native) | no (adapter) | no (adapter) | yes |
| `document.batchAtomic` | yes | yes | yes |
| `metadata.unitOfWork` | no | no | yes |
| `event.durableUnique` | yes | yes | yes |
| `event.observation` | yes | yes | yes |
| `artifact.verifiedContent` | no | yes | yes |
| `artifact.orphanInventory` | no | yes | yes |

### SQLite backend (#339)

`sqliteStores(dir)` keeps the metadata collections, the run event log, the plan
journal and the artifact index in one database, `<dir>/metadata.sqlite`, through
Node's built-in `node:sqlite` (no new dependency). It is not the default backend
and nothing opens it unless asked; switching a workspace to it, and the store
format epoch that goes with that, wait for the format carry-over gates (#897,
#905, #910). The full design, deployment rules and recovery procedures are in
`docs/storage/sqlite-metadata.md`.

- **Commit point:** every write is one `BEGIN IMMEDIATE ... COMMIT` with
  `synchronous = FULL` in WAL mode. A failure before `COMMIT` rolls back and
  rejects with the underlying error; a failure of `COMMIT` is `STORE_WRITE` with
  `details.outcome: "uncertain"`, as for a failed rename on the file backend.
  Contention past the busy deadline (default 10 s) is `STORE_LOCK_TIMEOUT`.
- **Documents:** a write must parse back through the collection's schema, or it
  is refused inside the transaction (the file backend would commit it and fail
  every later read). Versions are the same content hash as the other backends.
- **Unit of work:** optimistic. Writes are staged and read back by the work; at
  the end one transaction checks that every document the work read still has the
  version it saw (and every collection it listed or queried has had no write),
  then applies everything. A change it did not see is `REVISION_STALE` with
  `details.unitOfWork: true`, and nothing is written. Work that throws writes
  nothing.
- **Stays on files:** artifact bytes, private execution records and pinned
  workflow versions (encrypted per record), and claims and leases (their
  ownership callbacks write other stores while the fence is held, which cannot
  run inside a synchronous SQLite transaction).

`requireStoreCapability(matrix, capability)` throws `NOT_SUPPORTED` with
`details: { capability, backend }` for a `false` entry; the suite checks every
`false` entry is refused that way.

## Adding a backend

1. Implement the seven interfaces, `VersionedDocumentStore` for collections when
   you can, and `Stores.unitOfWork` only if writes across metadata collections
   really commit together.
2. Declare a `StoreCapabilityMatrix` that states only what you guarantee.
3. Implement `ConformanceBackend` (`packages/store/test/conformance/backend.ts`)
   and call `runStoreConformance(yourBackend)` from a test file. A `true`
   capability enables its tests; a `false` one tests the refusal.
