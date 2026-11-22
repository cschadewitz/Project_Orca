/**
 * Import, backup, restore and verification for the SQLite metadata backend (#339).
 *
 * - `importFileMetadata(dir)` copies a file-backed store's metadata into `<dir>/metadata.sqlite`,
 *   beside the files it came from. The file store stays the authority until a workspace is
 *   switched to SQLite, so the import *mirrors* it: collections are replaced, runs and plan
 *   journals are extended with the events the database does not have yet. Every collection,
 *   run and journal is its own transaction, so an interrupted import leaves whole units and a
 *   rerun finishes the rest. Ids, sequence numbers and timestamps are copied, never reassigned.
 *   History the database has that the files do not is a conflict, never overwritten.
 * - `backupSqliteMetadata(dir, target)` writes a consistent copy with `VACUUM INTO` while the
 *   database stays open to other connections. Artifact blobs, encrypted records, claims and
 *   leases are files and are backed up as files.
 * - `restoreSqliteMetadata(backup, dir)` checks the copy and puts it in place in a store that has
 *   no database; it never replaces one.
 * - `verifySqliteMetadata(dir)` is the diagnosable repair state: integrity, per-run sequence
 *   gaps, artifact rows whose blob is missing or wrong, and blobs no row references.
 */
import { copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ArtifactSchema, OrcaError, OrcaEventSchema, PlanEventSchema, sha256 } from "@orca/core";
import { FileArtifactStore } from "../artifact-store.js";
import { fileStores } from "../document-store.js";
import { JsonlEventStore } from "../jsonl-event-store.js";
import { JsonlPlanJournal } from "../plan-store.js";
import { sqlite, SqliteDatabase, type SqliteOptions } from "./database.js";
import type { SqliteCollection } from "./documents.js";
import { insertEvent } from "./events.js";
import { SQLITE_MIGRATIONS } from "./schema.js";
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

/** Mirror the file-backed metadata under `dir` into `<dir>/metadata.sqlite`. Safe to rerun. */
export async function importFileMetadata(dir: string, options: SqliteOptions = {}): Promise<SqliteImportReport> {
  const files = fileStores(dir);
  const target = sqliteStores(dir, options);
  const db = (target.requests as unknown as { collection: SqliteCollection<never> }).collection.db;
  try {
    const report: SqliteImportReport = {
      documents: {},
      runs: 0,
      eventsImported: 0,
      plans: 0,
      planEventsImported: 0,
      artifacts: 0,
    };
    const pairs = [
      [files.requests, target.requests],
      [files.workItems, target.workItems],
      [files.plan.plans, target.plan.plans],
      [files.plan.dependencies, target.plan.dependencies],
      [files.plan.risks, target.plan.risks],
      [files.plan.decisions, target.plan.decisions],
    ] as const;
    for (const [source, sink] of pairs) {
      const docs = await source.list();
      const collection = (sink as unknown as { collection: SqliteCollection<never> }).collection;
      await db.write(() => {
        db.prepare("DELETE FROM documents WHERE collection = ?").run(collection.name);
        for (const doc of docs) collection.putSync(doc as never);
        collection.bumpSync();
      });
      report.documents[collection.name] = docs.length;
    }

    const events = new JsonlEventStore(dir);
    for (const runId of await events.listRuns()) {
      const history = await events.read(runId);
      report.eventsImported += await db.write(() => {
        const present = db
          .prepare("SELECT seq, id FROM events WHERE run_id = ? ORDER BY seq")
          .all(runId) as unknown as { seq: number; id: string }[];
        if (present.length > history.length) throw conflict("more events in a run", { runId });
        for (const row of present) {
          const source = history[Number(row.seq)];
          if (!source || source.id !== row.id) throw conflict("different events in a run", { runId, seq: row.seq });
        }
        for (const event of history.slice(present.length)) insertEvent(db, event);
        if (history.length === 0) db.prepare("INSERT OR IGNORE INTO runs (run_id) VALUES (?)").run(runId);
        return history.length - present.length;
      });
      report.runs++;
    }

    const journal = new JsonlPlanJournal(dir);
    for (const planId of await journal.listPlans()) {
      const history = await journal.read(planId);
      report.planEventsImported += await db.write(() => {
        const present = db
          .prepare("SELECT seq, body FROM plan_events WHERE plan_id = ? ORDER BY seq")
          .all(planId) as unknown as { seq: number; body: string }[];
        if (present.length > history.length) throw conflict("more plan journal events", { planId });
        for (const row of present) {
          const source = history[Number(row.seq)];
          if (!source || source.id !== (JSON.parse(row.body) as { id: string }).id)
            throw conflict("different plan journal events", { planId, seq: row.seq });
        }
        db.prepare("INSERT OR IGNORE INTO plan_journals (plan_id) VALUES (?)").run(planId);
        for (const event of history.slice(present.length))
          db.prepare("INSERT INTO plan_events (plan_id, seq, body) VALUES (?, ?, ?)").run(
            planId,
            event.seq,
            JSON.stringify(event),
          );
        return history.length - present.length;
      });
      report.plans++;
    }

    // Blobs are already where SqliteArtifactStore reads them; only the index moves.
    const artifacts = await new FileArtifactStore(dir).list();
    await db.write(() => {
      for (const artifact of artifacts)
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
    });
    report.artifacts = artifacts.length;
    return report;
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

/** Integrity and schema of a database file, opened read-only; throws when it is not usable. */
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
    const schema = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (schema > SQLITE_MIGRATIONS.length)
      throw new OrcaError("STORE_FORMAT", `${file} has SQLite metadata schema ${schema}, newer than this build`, {
        reason: "NEWER",
        file,
        schema,
        supported: SQLITE_MIGRATIONS.length,
      });
    return { schema };
  } finally {
    db.close();
  }
}

/** A consistent copy of `<dir>/metadata.sqlite` at `target`, taken while the database stays in use. */
export async function backupSqliteMetadata(dir: string, target: string): Promise<{ file: string; bytes: number }> {
  if (await exists(target))
    throw new OrcaError("STORE_WRITE", `${target} already exists; a backup never overwrites a file`, {
      file: target,
      reason: "EXISTS",
    });
  const db = new SqliteDatabase(join(dir, SQLITE_METADATA_FILE));
  try {
    await db.statement(() => db.prepare("VACUUM INTO ?").run(target));
  } finally {
    db.close();
  }
  const handle = await open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  checkDatabaseFile(target);
  return { file: target, bytes: (await stat(target)).size };
}

/**
 * Put a backup in place as `<dir>/metadata.sqlite`. Refuses when the store already has a
 * database: restoring over live metadata is a decision for an operator who has moved it aside.
 * The copy is checked, synced and renamed into place, so a crash leaves either no database or
 * the whole backup; the open that follows applies any migration an older backup needs.
 */
export async function restoreSqliteMetadata(backup: string, dir: string): Promise<{ file: string; schema: number }> {
  const file = join(dir, SQLITE_METADATA_FILE);
  for (const existing of [file, `${file}-wal`])
    if (await exists(existing))
      throw new OrcaError("STORE_WRITE", `${existing} exists; move it aside before restoring`, {
        file: existing,
        reason: "EXISTS",
      });
  checkDatabaseFile(backup);
  await mkdir(dir, { recursive: true });
  const scratch = `${file}.${randomUUID()}.restore`;
  try {
    await copyFile(backup, scratch);
    const handle = await open(scratch, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(scratch, file);
  } finally {
    await unlink(scratch).catch(() => undefined);
  }
  new SqliteDatabase(file).close();
  return { file, schema: checkDatabaseFile(file).schema };
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
  const stores = sqliteStores(dir);
  const db = (stores.requests as unknown as { collection: SqliteCollection<never> }).collection.db;
  try {
    const problems: SqliteVerifyReport["problems"] = [];
    const scan = await db.read(() => {
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
    });
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
    const unreferencedBlobs = await (stores.artifacts as FileArtifactStore).unreferencedBlobs();
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
    stores.close?.();
  }
}
