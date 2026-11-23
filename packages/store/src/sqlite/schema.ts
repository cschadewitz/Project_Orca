/**
 * The SQLite metadata schema (#339), as an ordered list of migrations. Migration `n` takes a
 * database from `PRAGMA user_version = n` to `n + 1`; `SqliteDatabase` applies the pending ones
 * in one immediate transaction at open and refuses a database whose version is newer than this
 * list. A released migration is never edited: a change is a new entry.
 *
 * What each table holds, and which of it is authoritative:
 *
 * - `documents`: every metadata collection (requests, work items, plans, dependencies, risks,
 *   decisions), one row per document. `body` is the document's JSON, exactly what the file
 *   backend keeps in `<collection>.json`. `sort_key` is the id as UTF-16 code units in hex, so
 *   SQLite's byte order is the contract's code-unit order (`compareIds`); the plain `id` would
 *   sort by UTF-8 bytes, which differs for characters outside the Basic Multilingual Plane.
 *   The rowid keeps first-insertion order, which is the order `list()` returns, as on file.
 * - `collection_versions`: a counter per collection, bumped by every committed write to it. A
 *   unit of work that listed or queried a collection compares it at commit to detect a write
 *   it did not see. Derived bookkeeping, not data.
 * - `runs`, `events`: the run event log. `(run_id, seq)` is the gap-free sequence; `journal_*`
 *   mirror `event.journal` so durable journal publication is one unique index lookup; `type`
 *   lets a page or a type read skip the `agent.update` bulk without parsing it. `runs` keeps
 *   the order runs were first written.
 * - `plan_journals`, `plan_events`: the plan journal, the same shape.
 * - `artifacts`: the artifact index. Blob bytes stay content-addressed files on disk: SQLite
 *   holds no blob, so a database backup is small and blob durability is unchanged.
 * - `store_binding` (one row at most): the id `orca store sqlite switch` gave this database when
 *   it made it a store's metadata, also recorded in the store's format marker. A store on SQLite
 *   opens only the database bound to it, so a lost, empty or swapped-in file is refused instead
 *   of becoming the workspace's metadata (store-backend.ts).
 */
export const SQLITE_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE documents (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    sort_key TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  );
  CREATE UNIQUE INDEX documents_order ON documents (collection, sort_key);
  CREATE INDEX documents_plan ON documents (collection, json_extract(body, '$.planId'), sort_key);

  CREATE TABLE collection_versions (
    collection TEXT PRIMARY KEY,
    counter INTEGER NOT NULL
  ) WITHOUT ROWID;

  CREATE TABLE runs (run_id TEXT NOT NULL UNIQUE);
  CREATE TABLE events (
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    journal_kind TEXT,
    journal_id TEXT,
    journal_revision INTEGER,
    body TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  ) WITHOUT ROWID;
  CREATE INDEX events_type ON events (run_id, type, seq);
  CREATE UNIQUE INDEX events_journal ON events (run_id, journal_kind, journal_id, journal_revision)
    WHERE journal_kind IS NOT NULL;

  CREATE TABLE plan_journals (plan_id TEXT NOT NULL UNIQUE);
  CREATE TABLE plan_events (
    plan_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (plan_id, seq)
  ) WITHOUT ROWID;

  CREATE TABLE artifacts (
    id TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    run_id TEXT,
    kind TEXT,
    name TEXT,
    body TEXT NOT NULL
  );
  CREATE INDEX artifacts_run ON artifacts (run_id);
  CREATE INDEX artifacts_hash ON artifacts (content_hash);

  PRAGMA application_id = 1330791233;
  `,
  `
  CREATE TABLE store_binding (
    slot INTEGER PRIMARY KEY CHECK (slot = 1),
    store_id TEXT NOT NULL,
    bound_at TEXT NOT NULL
  );
  `,
];

/**
 * `PRAGMA application_id` of every ORCA metadata database: "ORCA" in ASCII. It is what tells an
 * ORCA database from any other healthy SQLite file, which a schema number alone cannot.
 */
export const ORCA_SQLITE_APPLICATION_ID = 0x4f524341;

/** The tables and indexes a database at `version` must have, exactly as the migrations make them. */
export function expectedSchemaObjects(
  DatabaseSync: typeof import("node:sqlite").DatabaseSync,
  version: number,
): { type: string; name: string; tbl_name: string; sql: string | null }[] {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of SQLITE_MIGRATIONS.slice(0, version)) db.exec(migration);
    return schemaObjects(db);
  } finally {
    db.close();
  }
}

/**
 * Every application-owned schema object (tables, indexes, views, triggers), in name order.
 * Only SQLite's own internals are left out, by an exact `sqlite_` name prefix (not `LIKE`, where
 * `_` would be a wildcard).
 */
export function schemaObjects(
  db: import("node:sqlite").DatabaseSync,
): { type: string; name: string; tbl_name: string; sql: string | null }[] {
  return db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE substr(name, 1, 7) <> 'sqlite_' ORDER BY type, name",
    )
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
}
