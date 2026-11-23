/**
 * The way back from SQLite to files (#339): the metadata a store keeps in its database, written
 * out as the file backend's own files, and checked by reading them back with the file backend.
 *
 * - {@link readSqliteMetadataExport} reads everything the database holds in one read snapshot of a
 *   read-only connection, bound to the store it belongs to. Every row is parsed with its schema
 *   first, so a row this build cannot read refuses the export instead of being dropped; a
 *   collection this build does not know refuses it too.
 * - {@link writeFileMetadata} writes it into an empty staging directory, as the file backend
 *   writes them: one JSON array per collection, one JSONL log per run and per plan journal, and
 *   the artifact index. Every file is flushed. Rows are written as the database stored them.
 * - {@link checkFileMetadata} reads the staging directory with the file backend's readers (the
 *   import's own reader, `readFileMetadata`) and refuses unless it holds exactly what the database
 *   holds: every document, every run's events in order, every plan journal, every artifact record.
 *
 * Artifact blobs, encrypted records, claims, leases and pinned workflow versions are files on
 * both backends and are not part of this.
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ArtifactSchema,
  DecisionSchema,
  DependencySchema,
  OrcaError,
  OrcaEventSchema,
  PlanEventSchema,
  PlanSchema,
  RequestSchema,
  RiskSchema,
  WorkItemSchema,
} from "@orca/core";
import type { ZodType } from "zod";
import { createDurable, syncDirectory } from "../durable-file.js";
import { checkBoundSqliteMetadata, sqlite } from "./database.js";
import { readFileMetadata, type SourceSnapshot } from "./maintenance.js";
import { SQLITE_METADATA_FILE } from "./stores.js";

/** Each SQLite collection, the file the file backend keeps it in, and its schema. */
const COLLECTIONS: readonly { name: string; file: string; schema: ZodType<{ id: string }> }[] = [
  { name: "requests", file: "requests.json", schema: RequestSchema },
  { name: "workItems", file: "work-items.json", schema: WorkItemSchema },
  { name: "plans", file: "plans.json", schema: PlanSchema },
  { name: "dependencies", file: "dependencies.json", schema: DependencySchema },
  { name: "risks", file: "risks.json", schema: RiskSchema },
  { name: "decisions", file: "decisions.json", schema: DecisionSchema },
];

/** What a switched store's database holds, as raw rows (each already parsed once with its schema). */
export interface SqliteMetadataExport {
  /** Every known collection, in order, with its documents' bodies in insertion order. */
  collections: { name: string; file: string; bodies: string[] }[];
  /** Every run the database knows, with its events' bodies in `seq` order (possibly none). */
  runs: { id: string; bodies: string[] }[];
  plans: { id: string; bodies: string[] }[];
  /** The artifact index, first written first. */
  artifacts: string[];
}

const refused = (message: string, details: Record<string, unknown> = {}) =>
  new OrcaError("STORE_FORMAT", message, { reason: "EXPORT_REFUSED", ...details });

/** A key the file backend can name a log after: no path separators, nothing hidden. */
const LOG_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,199}$/;
function logKey(kind: string, id: string): string {
  if (!LOG_KEY.test(id) || id.endsWith(".jsonl"))
    throw refused(`The ${kind} id ${JSON.stringify(id)} cannot be written as a file, so the store stays on SQLite.`, {
      kind,
      id,
    });
  return id;
}

/**
 * Everything `<storeDir>/metadata.sqlite` holds, from one read snapshot of a read-only
 * connection, after checking it is the database bound to the store as `storeId`.
 */
export function readSqliteMetadataExport(storeDir: string, storeId: string | undefined): SqliteMetadataExport {
  const file = join(storeDir, SQLITE_METADATA_FILE);
  checkBoundSqliteMetadata(file, storeDir, storeId);
  const db = new (sqlite().DatabaseSync)(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    db.exec("BEGIN");
    try {
      const all = <R>(sql: string, ...args: string[]) => db.prepare(sql).all(...args) as unknown as R[];
      const known = new Set(COLLECTIONS.map((c) => c.name));
      for (const { collection } of all<{ collection: string }>("SELECT DISTINCT collection FROM documents"))
        if (!known.has(collection))
          throw refused(
            `The database holds a collection this ORCA does not know (${collection}), so the store stays on SQLite.`,
            { collection },
          );
      const parsed = (schema: ZodType, body: string, what: Record<string, unknown>) => {
        try {
          schema.parse(JSON.parse(body));
        } catch (error) {
          throw refused(`A record in the database could not be read, so the store stays on SQLite.`, {
            ...what,
            cause: (error as Error).message.slice(0, 200),
          });
        }
        return body;
      };
      const collections = COLLECTIONS.map(({ name, file, schema }) => ({
        name,
        file,
        bodies: all<{ id: string; body: string }>(
          "SELECT id, body FROM documents WHERE collection = ? ORDER BY rowid",
          name,
        ).map((row) => parsed(schema, row.body, { collection: name, id: row.id })),
      }));
      const runs = all<{ run_id: string }>("SELECT run_id FROM runs ORDER BY rowid").map(({ run_id: id }) => ({
        id: logKey("run", id),
        bodies: all<{ seq: number; body: string }>(
          "SELECT seq, body FROM events WHERE run_id = ? ORDER BY seq",
          id,
        ).map((row) => parsed(OrcaEventSchema, row.body, { runId: id, seq: Number(row.seq) })),
      }));
      const plans = all<{ plan_id: string }>("SELECT plan_id FROM plan_journals ORDER BY rowid").map(
        ({ plan_id: id }) => ({
          id: logKey("plan", id),
          bodies: all<{ seq: number; body: string }>(
            "SELECT seq, body FROM plan_events WHERE plan_id = ? ORDER BY seq",
            id,
          ).map((row) => parsed(PlanEventSchema, row.body, { planId: id, seq: Number(row.seq) })),
        }),
      );
      // Events of a run (or plan) with no row in `runs` would be lost; the writers always add both.
      const orphan = all<{ n: number }>(
        "SELECT (SELECT COUNT(*) FROM events WHERE run_id NOT IN (SELECT run_id FROM runs)) + " +
          "(SELECT COUNT(*) FROM plan_events WHERE plan_id NOT IN (SELECT plan_id FROM plan_journals)) AS n",
      )[0]!.n;
      if (Number(orphan))
        throw refused("The database holds events of a run or plan it does not list, so the store stays on SQLite.");
      const artifacts = all<{ id: string; body: string }>("SELECT id, body FROM artifacts ORDER BY rowid").map((row) =>
        parsed(ArtifactSchema, row.body, { artifactId: row.id }),
      );
      return { collections, runs, plans, artifacts };
    } finally {
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
}

const jsonl = (bodies: readonly string[]) => bodies.map((body) => `${body}\n`).join("");

/**
 * Write `exported` into `stagedDir` (created; it must not exist yet) as the file backend's own
 * files, each flushed, then the directories. A collection with no documents gets no file, as on
 * a store that never wrote one; `runs/` and `plans/` are always there.
 */
export async function writeFileMetadata(stagedDir: string, exported: SqliteMetadataExport): Promise<void> {
  await mkdir(stagedDir, { mode: 0o700 });
  for (const { file, bodies } of exported.collections)
    if (bodies.length)
      await createDurable(
        join(stagedDir, file),
        JSON.stringify(
          bodies.map((body) => JSON.parse(body) as unknown),
          null,
          2,
        ),
      );
  for (const [dir, logs] of [
    ["runs", exported.runs],
    ["plans", exported.plans],
  ] as const) {
    await mkdir(join(stagedDir, dir), { mode: 0o700 });
    for (const { id, bodies } of logs) await createDurable(join(stagedDir, dir, `${id}.jsonl`), jsonl(bodies));
    await syncDirectory(join(stagedDir, dir));
  }
  if (exported.artifacts.length) {
    await mkdir(join(stagedDir, "artifacts"), { mode: 0o700 });
    await createDurable(join(stagedDir, "artifacts", "index.jsonl"), jsonl(exported.artifacts));
    await syncDirectory(join(stagedDir, "artifacts"));
  }
  await syncDirectory(stagedDir);
}

/** `exported`, parsed as the file backend's readers return it, for comparing with them. */
function expected(exported: SqliteMetadataExport): SourceSnapshot {
  return {
    collections: exported.collections.map(({ name, bodies }) => {
      const schema = COLLECTIONS.find((c) => c.name === name)!.schema;
      return [name, bodies.map((body) => schema.parse(JSON.parse(body)))];
    }),
    runs: exported.runs.map(({ id, bodies }) => [id, bodies.map((body) => OrcaEventSchema.parse(JSON.parse(body)))]),
    plans: exported.plans.map(({ id, bodies }) => [id, bodies.map((body) => PlanEventSchema.parse(JSON.parse(body)))]),
    artifacts: exported.artifacts.map((body) => ArtifactSchema.parse(JSON.parse(body))),
  };
}

/** Order-free form: collections by name and document id, logs by id, artifacts by id. */
function normalized(snapshot: SourceSnapshot) {
  const byId = <T extends { id: string }>(docs: readonly T[]) => [...docs].sort((a, b) => (a.id < b.id ? -1 : 1));
  const byKey = <T>(entries: readonly [string, T][]) => [...entries].sort(([a], [b]) => (a < b ? -1 : 1));
  return {
    collections: byKey(snapshot.collections.map(([name, docs]) => [name, byId(docs)] as [string, { id: string }[]])),
    runs: byKey(snapshot.runs),
    plans: byKey(snapshot.plans),
    artifacts: byId(snapshot.artifacts),
  };
}

/**
 * Read `stagedDir` back with the file backend's readers and refuse (`STORE_FORMAT`,
 * `EXPORT_MISMATCH`) unless it is exactly `exported`: the same documents, the same runs and plan
 * journals with the same events in the same order, the same artifact records. Each log must also
 * be whole: a line the reader would skip (not JSON) shows up as a missing event.
 */
export async function checkFileMetadata(stagedDir: string, exported: SqliteMetadataExport): Promise<void> {
  const read = await readFileMetadata(stagedDir);
  const want = normalized(expected(exported));
  const got = normalized(read);
  for (const part of ["collections", "runs", "plans", "artifacts"] as const)
    if (!isDeepStrictEqual(got[part], want[part]))
      throw new OrcaError(
        "STORE_FORMAT",
        `The files written from the database do not read back as what it holds (${part}), so the store stays on SQLite.`,
        { reason: "EXPORT_MISMATCH", part },
      );
  // Nothing beside what was written: the readers above only see what they look for.
  const top = (await readdir(stagedDir)).sort();
  const allowed = new Set(["runs", "plans", "artifacts", ...COLLECTIONS.map((c) => c.file)]);
  const extra = top.filter((name) => !allowed.has(name));
  if (extra.length)
    throw new OrcaError("STORE_FORMAT", `Unexpected files were written from the database (${extra.join(", ")}).`, {
      reason: "EXPORT_MISMATCH",
      part: "files",
    });
}
