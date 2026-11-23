/**
 * Import, backup, restore and verification for the SQLite metadata backend (#339).
 *
 * - `importFileMetadata(dir)` copies a file-backed store's metadata into `<dir>/metadata.sqlite`,
 *   beside the files it came from. The file store stays the authority until a workspace is
 *   switched to SQLite, so the import *mirrors* it: collections are replaced, runs and plan
 *   journals are extended with the events the database does not have yet, all in one
 *   transaction after every conflict has been checked. Ids, sequence numbers and timestamps are
 *   copied, never reassigned. History the database has that the files do not is a conflict,
 *   never overwritten, and a refused import changes nothing.
 * - `backupSqliteMetadata(dir, target)` writes a consistent copy with `VACUUM INTO` while the
 *   database stays open to other connections. Artifact blobs, encrypted records, claims and
 *   leases are files and are backed up as files.
 * - `restoreSqliteMetadata(backup, dir)` stages, checks and links a sealed backup into a store that
 *   has no database; it never replaces one.
 * - `verifySqliteMetadata(dir)` is the diagnosable repair state: integrity, per-run sequence
 *   gaps, artifact rows whose blob is missing or wrong, and blobs no row references.
 */
import { constants } from "node:fs";
import { copyFile, link, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ArtifactSchema,
  OrcaError,
  OrcaEventSchema,
  PlanEventSchema,
  sha256,
  type Artifact,
  type OrcaEvent,
  type PlanEvent,
} from "@orca/core";
import { withFileLock } from "../file-lock.js";
import { FileArtifactStore } from "../artifact-store.js";
import { fileStores } from "../document-store.js";
import { JsonlEventStore } from "../jsonl-event-store.js";
import { JsonlPlanJournal } from "../plan-store.js";
import { sqlite, type SqliteOptions } from "./database.js";
import type { SqliteCollection } from "./documents.js";
import { insertEvent } from "./events.js";
import { expectedSchemaObjects, ORCA_SQLITE_APPLICATION_ID, schemaObjects, SQLITE_MIGRATIONS } from "./schema.js";
import { SQLITE_METADATA_FILE, sqliteStores } from "./stores.js";

export interface SqliteImportReport {
  /** Documents now in each collection. */
  documents: Record<string, number>;
  runs: number;
  /** Events written by this import; events already present are not counted. */
  eventsImported: number;
  plans: number;
  planEventsImported: number;
  artifacts: number;
}

function conflict(what: string, details: Record<string, unknown>): OrcaError {
  return new OrcaError(
    "STORE_FORMAT",
    `the SQLite metadata has ${what} the file store does not; refusing to import over it`,
    { reason: "IMPORT_CONFLICT", ...details },
  );
}

/** Everything the import moves, read from the file store at one point. */
interface SourceSnapshot {
  collections: [name: string, docs: { id: string }[]][];
  runs: [runId: string, events: OrcaEvent[]][];
  plans: [planId: string, events: PlanEvent[]][];
  artifacts: Artifact[];
}

async function readSource(dir: string): Promise<SourceSnapshot> {
  const files = fileStores(dir);
  const collections: SourceSnapshot["collections"] = [];
  for (const [name, store] of [
    ["requests", files.requests],
    ["workItems", files.workItems],
    ["plans", files.plan.plans],
    ["dependencies", files.plan.dependencies],
    ["risks", files.plan.risks],
    ["decisions", files.plan.decisions],
  ] as const)
    collections.push([name, await (store as { list(): Promise<{ id: string }[]> }).list()]);
  const events = new JsonlEventStore(dir);
  const runs: SourceSnapshot["runs"] = [];
  for (const runId of await events.listRuns()) runs.push([runId, await events.read(runId)]);
  const journal = new JsonlPlanJournal(dir);
  const plans: SourceSnapshot["plans"] = [];
  for (const planId of await journal.listPlans()) plans.push([planId, await journal.read(planId)]);
  return { collections, runs, plans, artifacts: await new FileArtifactStore(dir).list() };
}

export interface SqliteImportOptions extends SqliteOptions {
  /** Test hook: runs between the two source reads that must agree. */
  betweenSourceReads?: () => Promise<void>;
}

/**
 * Mirror the file-backed metadata under `dir` into `<dir>/metadata.sqlite`. Safe to rerun.
 *
 * Run it with every ORCA using the store stopped, as for `carry-forward`. The source is read
 * twice and the two reads must be identical, so a write that lands during the read is refused
 * rather than half-imported. Then everything is decided and applied in **one** transaction:
 * every run and plan journal is checked for history only the database has *before* anything
 * is written, and the commit is the single publish point. A refused or interrupted import leaves
 * the database exactly as it was.
 */
export async function importFileMetadata(dir: string, options: SqliteImportOptions = {}): Promise<SqliteImportReport> {
  const { betweenSourceReads, ...dbOptions } = options;
  const source = await readSource(dir);
  await betweenSourceReads?.();
  const again = await readSource(dir);
  if (sha256(JSON.stringify(again)) !== sha256(JSON.stringify(source)))
    throw new OrcaError("STORE_WRITE", "the file store changed while it was being imported; stop ORCA and rerun", {
      reason: "SOURCE_CHANGED",
      dir,
    });

  // A mirror beside the files: before a switch the store still records file metadata.
  const target = sqliteStores(dir, { ...dbOptions, unselected: true });
  const collection = (store: unknown) => (store as { collection: SqliteCollection<never> }).collection;
  const db = collection(target.requests).db;
  const sinks = new Map(
    [
      target.requests,
      target.workItems,
      target.plan.plans,
      target.plan.dependencies,
      target.plan.risks,
      target.plan.decisions,
    ].map((store) => [collection(store).name, collection(store)]),
  );
  try {
    return await db.write(() => {
      // Preflight: decide every conflict, on both sides, before the first write. History (runs,
      // plan journals, artifact records) is append-only: what the database already holds must be
      // exactly a prefix of the source, record for record, and nothing may exist only in the
      // database. Collections are current state, which the file store owns until the switch.
      const sourceRuns = new Set(source.runs.map(([runId]) => runId));
      for (const { run_id: runId } of db.prepare("SELECT run_id FROM runs").all() as { run_id: string }[])
        if (!sourceRuns.has(runId)) throw conflict("a run", { runId });
      const appendFrom = new Map<string, number>();
      for (const [runId, history] of source.runs) {
        const present = db
          .prepare("SELECT seq, body FROM events WHERE run_id = ? ORDER BY seq")
          .all(runId) as unknown as { seq: number; body: string }[];
        if (present.length > history.length) throw conflict("more events in a run", { runId });
        for (const row of present) {
          const expected = history[Number(row.seq)];
          if (!expected || !isDeepStrictEqual(OrcaEventSchema.parse(JSON.parse(row.body)), expected))
            throw conflict("a different event in a run", { runId, seq: row.seq });
        }
        appendFrom.set(runId, present.length);
      }
      const sourcePlans = new Set(source.plans.map(([planId]) => planId));
      for (const { plan_id: planId } of db.prepare("SELECT plan_id FROM plan_journals").all() as { plan_id: string }[])
        if (!sourcePlans.has(planId)) throw conflict("a plan journal", { planId });
      const planFrom = new Map<string, number>();
      for (const [planId, history] of source.plans) {
        const present = db
          .prepare("SELECT seq, body FROM plan_events WHERE plan_id = ? ORDER BY seq")
          .all(planId) as unknown as { seq: number; body: string }[];
        if (present.length > history.length) throw conflict("more plan journal events", { planId });
        for (const row of present) {
          const expected = history[Number(row.seq)];
          if (!expected || !isDeepStrictEqual(PlanEventSchema.parse(JSON.parse(row.body)), expected))
            throw conflict("a different plan journal event", { planId, seq: row.seq });
        }
        planFrom.set(planId, present.length);
      }
      const sourceArtifacts = new Map(source.artifacts.map((a) => [a.id, a]));
      for (const row of db.prepare("SELECT id, body FROM artifacts").all() as { id: string; body: string }[]) {
        const expected = sourceArtifacts.get(row.id);
        if (!expected) throw conflict("an artifact record", { artifactId: row.id });
        if (!isDeepStrictEqual(ArtifactSchema.parse(JSON.parse(row.body)), expected))
          throw conflict("a different artifact record", { artifactId: row.id });
      }

      const report: SqliteImportReport = {
        documents: {},
        runs: source.runs.length,
        eventsImported: 0,
        plans: source.plans.length,
        planEventsImported: 0,
        artifacts: source.artifacts.length,
      };
      for (const [name, docs] of source.collections) {
        const sink = sinks.get(name)!;
        db.prepare("DELETE FROM documents WHERE collection = ?").run(name);
        for (const doc of docs) sink.putSync(doc as never);
        sink.bumpSync();
        report.documents[name] = docs.length;
      }
      for (const [runId, history] of source.runs) {
        db.prepare("INSERT OR IGNORE INTO runs (run_id) VALUES (?)").run(runId);
        for (const event of history.slice(appendFrom.get(runId))) insertEvent(db, event);
        report.eventsImported += history.length - appendFrom.get(runId)!;
      }
      for (const [planId, history] of source.plans) {
        db.prepare("INSERT OR IGNORE INTO plan_journals (plan_id) VALUES (?)").run(planId);
        for (const event of history.slice(planFrom.get(planId)))
          db.prepare("INSERT INTO plan_events (plan_id, seq, body) VALUES (?, ?, ?)").run(
            planId,
            event.seq,
            JSON.stringify(event),
          );
        report.planEventsImported += history.length - planFrom.get(planId)!;
      }
      // Blobs are already where SqliteArtifactStore reads them; only the index moves.
      for (const artifact of source.artifacts)
        db.prepare(
          "INSERT INTO artifacts (id, content_hash, run_id, kind, name, body) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (id) DO UPDATE SET content_hash = excluded.content_hash, run_id = excluded.run_id, " +
            "kind = excluded.kind, name = excluded.name, body = excluded.body",
        ).run(
          artifact.id,
          artifact.contentHash,
          artifact.producedBy.runId,
          artifact.kind,
          artifact.name,
          JSON.stringify(artifact),
        );
      return report;
    });
  } finally {
    target.close?.();
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * That `db` is an ORCA metadata database at a schema this build knows: the ORCA application id,
 * a schema version from 1 to the newest migration, and exactly the tables, indexes, views and
 * triggers that version's migrations create - nothing missing, nothing extra. A healthy SQLite file that is anything else
 * (another application's, an empty one, one with ORCA's version number but not its tables) is
 * `STORE_FORMAT`.
 */
function checkOrcaSchema(db: import("node:sqlite").DatabaseSync, file: string): number {
  const applicationId = Number(
    (db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id,
  );
  const schema = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (applicationId !== ORCA_SQLITE_APPLICATION_ID)
    throw new OrcaError("STORE_FORMAT", `${file} is not an ORCA metadata database`, {
      reason: "FOREIGN",
      file,
      applicationId,
    });
  if (schema > SQLITE_MIGRATIONS.length)
    throw new OrcaError("STORE_FORMAT", `${file} has SQLite metadata schema ${schema}, newer than this build`, {
      reason: "NEWER",
      file,
      schema,
      supported: SQLITE_MIGRATIONS.length,
    });
  if (schema < 1)
    throw new OrcaError("STORE_FORMAT", `${file} has no ORCA metadata schema`, { reason: "FOREIGN", file, schema });
  // The exact application-owned schema, not a superset: an extra trigger or view is behaviour,
  // not inert metadata, and a database carrying one is not an ORCA store.
  const key = (o: { type: string; name: string; tbl_name: string; sql: string | null }) =>
    JSON.stringify([o.type, o.name, o.tbl_name, o.sql]);
  const present = new Set(schemaObjects(db).map(key));
  const expected = new Set(expectedSchemaObjects(sqlite().DatabaseSync, schema).map(key));
  const missing = [...expected]
    .filter((k) => !present.has(k))
    .map((k) => (JSON.parse(k) as string[]).slice(0, 2).join(" "));
  const unexpected = [...present]
    .filter((k) => !expected.has(k))
    .map((k) => (JSON.parse(k) as string[]).slice(0, 2).join(" "));
  if (missing.length || unexpected.length)
    throw new OrcaError("STORE_FORMAT", `${file} does not have exactly the ORCA metadata schema ${schema}`, {
      reason: "SCHEMA_MISMATCH",
      file,
      schema,
      missing,
      unexpected,
    });
  return schema;
}

/** Integrity and identity of a database file, opened read-only; throws when it is not usable. */
function checkDatabaseFile(file: string): { schema: number } {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = (db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]).map(
      (r) => r.integrity_check,
    );
    if (integrity.join() !== "ok")
      throw new OrcaError("STORE_FORMAT", `${file} failed its integrity check`, {
        reason: "CORRUPT",
        file,
        integrity: integrity.slice(0, 20),
      });
    return { schema: checkOrcaSchema(db, file) };
  } finally {
    db.close();
  }
}

/**
 * A sealed copy of `<dir>/metadata.sqlite` at `target`, taken while the database stays in use.
 * `VACUUM INTO` writes a consistent snapshot to a staging file beside `target`; it is switched to
 * rollback-journal mode so it is one standalone file (no `-wal` it depends on), synced, checked,
 * and only then linked to `target`, which is never replaced.
 */
export async function backupSqliteMetadata(dir: string, target: string): Promise<{ file: string; bytes: number }> {
  if (await exists(target))
    throw new OrcaError("STORE_WRITE", `${target} already exists; a backup never overwrites a file`, {
      file: target,
      reason: "EXISTS",
    });
  const source = join(dir, SQLITE_METADATA_FILE);
  if (!(await exists(source)))
    throw new OrcaError("STORE_FORMAT", `${source} does not exist; there is no SQLite metadata to back up`, {
      reason: "MISSING",
      file: source,
    });
  const staged = `${target}.${randomUUID()}.partial`;
  try {
    const { DatabaseSync } = sqlite();
    // A read-only connection: a backup never migrates or otherwise changes what it copies.
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 10000");
      db.prepare("VACUUM INTO ?").run(staged);
    } finally {
      db.close();
    }
    const copy = new DatabaseSync(staged);
    try {
      copy.exec("PRAGMA journal_mode = DELETE");
    } finally {
      copy.close();
    }
    const handle = await open(staged, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (await walMode(staged)) throw new OrcaError("STORE_WRITE", `${staged} could not be sealed`, { file: staged });
    checkDatabaseFile(staged);
    try {
      await link(staged, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new OrcaError(
        "STORE_WRITE",
        `${target} appeared while backing up; nothing was replaced`,
        { file: target, reason: "EXISTS" },
        { cause: error },
      );
    }
    await syncDirectory(dirname(target));
  } finally {
    for (const leftover of [staged, `${staged}-journal`, `${staged}-wal`, `${staged}-shm`])
      await unlink(leftover).catch(() => undefined);
  }
  return { file: target, bytes: (await stat(target)).size };
}

/** SQLite's file header says whether a database needs a WAL file beside it (bytes 18-19 = 2). */
async function walMode(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(20);
    const { bytesRead } = await handle.read(header, 0, 20, 0);
    return bytesRead === 20 && (header[18] === 2 || header[19] === 2);
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface SqliteRestoreOptions {
  /** Test hook: runs after the staged copy is validated, just before it is published. */
  beforePublish?: () => Promise<void>;
}

/**
 * Put a backup in place as `<dir>/metadata.sqlite`, in a store that has no database.
 *
 * - The backup must be a **sealed standalone** database: what `backupSqliteMetadata` writes
 *   (`VACUUM INTO`), not a live WAL-mode file whose committed pages may still sit in a `-wal`
 *   beside it. A WAL-mode file, or one with a `-wal`/`-journal` sidecar, is refused.
 * - The bytes are copied into a staging file in the store first, synced, and the *staged copy*
 *   is what is checked (integrity, schema, still standalone): the file that gets published is
 *   exactly the file that was validated.
 * - Publication is a hard link to the final name, which fails rather than replaces when a
 *   database (or a `-wal`) appeared meanwhile, under a restore lock so two restores cannot race.
 *   A crash leaves either no database or the whole backup; the staging file is always removed.
 */
export async function restoreSqliteMetadata(
  backup: string,
  dir: string,
  options: SqliteRestoreOptions = {},
): Promise<{ file: string; schema: number }> {
  const file = join(dir, SQLITE_METADATA_FILE);
  const refuseExisting = async () => {
    for (const existing of [file, `${file}-wal`, `${file}-journal`])
      if (await exists(existing))
        throw new OrcaError("STORE_WRITE", `${existing} exists; move it aside before restoring`, {
          file: existing,
          reason: "EXISTS",
        });
  };
  for (const sidecar of [`${backup}-wal`, `${backup}-journal`])
    if (await exists(sidecar))
      throw new OrcaError("STORE_FORMAT", `${backup} is not a sealed backup: ${sidecar} is beside it`, {
        reason: "NOT_SEALED",
        file: backup,
      });
  await mkdir(dir, { recursive: true });
  return withFileLock(`${file}.restore.lock`, async () => {
    await refuseExisting();
    const staged = `${file}.${randomUUID()}.restore`;
    try {
      await copyFile(backup, staged, constants.COPYFILE_EXCL);
      const handle = await open(staged, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (await walMode(staged))
        throw new OrcaError("STORE_FORMAT", `${backup} is a WAL-mode database, not a sealed backup`, {
          reason: "NOT_SEALED",
          file: backup,
        });
      const { schema } = checkDatabaseFile(staged);
      await options.beforePublish?.();
      await refuseExisting();
      try {
        await link(staged, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new OrcaError(
          "STORE_WRITE",
          `${file} appeared while restoring; nothing was replaced`,
          { file, reason: "EXISTS" },
          { cause: error },
        );
      }
      await syncDirectory(dir);
      return { file, schema };
    } finally {
      await unlink(staged).catch(() => undefined);
    }
  });
}

export interface SqliteVerifyReport {
  ok: boolean;
  integrity: string[];
  schema: number;
  documents: Record<string, number>;
  runs: number;
  events: number;
  plans: number;
  planEvents: number;
  artifacts: number;
  /** Problems an operator must look at; empty when `ok`. */
  problems: { kind: string; detail: Record<string, unknown> }[];
  /** Blobs no artifact row references: what an interrupted `put` leaves. Reported, not a problem. */
  unreferencedBlobs: string[];
}

/** Check `<dir>/metadata.sqlite` and the artifact blobs it references, changing nothing. */
export async function verifySqliteMetadata(dir: string): Promise<SqliteVerifyReport> {
  const file = join(dir, SQLITE_METADATA_FILE);
  if (!(await exists(file))) throw new OrcaError("STORE_FORMAT", `${file} does not exist`, { reason: "MISSING", file });
  // Read-only all the way down: a read-only connection (no migration, no journal-mode change,
  // nothing created), one read transaction for a consistent snapshot, and blobs only read.
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const schema = checkOrcaSchema(db, file);
    if (schema !== SQLITE_MIGRATIONS.length)
      throw new OrcaError(
        "STORE_FORMAT",
        `${file} has SQLite metadata schema ${schema}; this build verifies ${SQLITE_MIGRATIONS.length}`,
        { reason: "OLDER", file, schema, supported: SQLITE_MIGRATIONS.length },
      );
    const problems: SqliteVerifyReport["problems"] = [];
    db.exec("BEGIN");
    const scan = (() => {
      const all = <R>(sql: string) => db.prepare(sql).all() as unknown as R[];
      const one = <R>(sql: string) => db.prepare(sql).get() as unknown as R;
      return {
        integrity: all<{ integrity_check: string }>("PRAGMA integrity_check").map((r) => r.integrity_check),
        schema: Number(one<{ user_version: number }>("PRAGMA user_version").user_version),
        documents: all<{ collection: string; n: number }>(
          "SELECT collection, COUNT(*) AS n FROM documents GROUP BY collection ORDER BY collection",
        ),
        gaps: all<{ run_id: string; n: number; last: number }>(
          "SELECT run_id, COUNT(*) AS n, MAX(seq) AS last FROM events GROUP BY run_id HAVING MIN(seq) != 0 OR n != last + 1",
        ),
        planGaps: all<{ plan_id: string; n: number; last: number }>(
          "SELECT plan_id, COUNT(*) AS n, MAX(seq) AS last FROM plan_events GROUP BY plan_id HAVING MIN(seq) != 0 OR n != last + 1",
        ),
        runs: one<{ n: number }>("SELECT COUNT(*) AS n FROM runs").n,
        events: one<{ n: number }>("SELECT COUNT(*) AS n FROM events").n,
        plans: one<{ n: number }>("SELECT COUNT(*) AS n FROM plan_journals").n,
        planEvents: one<{ n: number }>("SELECT COUNT(*) AS n FROM plan_events").n,
        artifacts: all<{ body: string }>("SELECT body FROM artifacts ORDER BY rowid"),
        eventBodies: all<{ body: string }>("SELECT body FROM events"),
        planEventBodies: all<{ body: string }>("SELECT body FROM plan_events"),
      };
    })();
    db.exec("COMMIT");
    if (scan.integrity.join() !== "ok") problems.push({ kind: "integrity", detail: { messages: scan.integrity } });
    for (const g of scan.gaps) problems.push({ kind: "eventSequenceGap", detail: { runId: g.run_id, ...g } });
    for (const g of scan.planGaps) problems.push({ kind: "planSequenceGap", detail: { planId: g.plan_id, ...g } });
    for (const row of scan.eventBodies) {
      const parsed = OrcaEventSchema.safeParse(JSON.parse(row.body));
      if (!parsed.success) problems.push({ kind: "invalidEvent", detail: { body: row.body.slice(0, 200) } });
    }
    for (const row of scan.planEventBodies) {
      const parsed = PlanEventSchema.safeParse(JSON.parse(row.body));
      if (!parsed.success) problems.push({ kind: "invalidPlanEvent", detail: { body: row.body.slice(0, 200) } });
    }
    const blobs = join(dir, "artifacts", "blobs");
    for (const row of scan.artifacts) {
      const parsed = ArtifactSchema.safeParse(JSON.parse(row.body));
      if (!parsed.success) {
        problems.push({ kind: "invalidArtifact", detail: { body: row.body.slice(0, 200) } });
        continue;
      }
      const artifact = parsed.data;
      const detail = { id: artifact.id, contentHash: artifact.contentHash };
      if (!/^[a-f0-9]{64}$/.test(artifact.contentHash)) {
        problems.push({ kind: "artifactInvalidHash", detail });
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(join(blobs, artifact.contentHash));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        problems.push({ kind: "artifactBlobMissing", detail });
        continue;
      }
      if (sha256(bytes) !== artifact.contentHash) problems.push({ kind: "artifactBlobMismatch", detail });
    }
    const referenced = new Set(
      scan.artifacts.map((row) => (JSON.parse(row.body) as { contentHash?: string }).contentHash),
    );
    let names: string[] = [];
    try {
      names = await readdir(blobs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const unreferencedBlobs = names.filter((n) => /^[a-f0-9]{64}$/.test(n) && !referenced.has(n)).sort();
    return {
      ok: problems.length === 0,
      integrity: scan.integrity,
      schema: scan.schema,
      documents: Object.fromEntries(scan.documents.map((d) => [d.collection, Number(d.n)])),
      runs: Number(scan.runs),
      events: Number(scan.events),
      plans: Number(scan.plans),
      planEvents: Number(scan.planEvents),
      artifacts: scan.artifacts.length,
      problems,
      unreferencedBlobs,
    };
  } finally {
    db.close();
  }
}
