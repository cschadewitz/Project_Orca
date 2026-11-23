/**
 * What the SQLite metadata backend (#339) promises beyond the shared conformance suite: real
 * processes racing on one database, durability across reopen, schema versioning, bounded busy
 * handling, code-unit id order, and the optimistic unit of work.
 */
import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { isOrcaError, PlanSchema, sha256, type Plan } from "@orca/core";
import {
  asVersionedDocumentStore,
  runUnitOfWork,
  SQLITE_METADATA_FILE,
  sqliteCollection,
  SqliteDatabase,
  SqliteEventStore,
  sqliteStores,
  type Stores,
} from "@orca/store";
import { SQLITE_MIGRATIONS } from "../src/sqlite/schema.js";
import { childBundle } from "@orca/testing/child-bundle";

const run = promisify(execFile);

const dirs: string[] = [];
const open: { close(): void }[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) handle.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const makeDir = async () => {
  const d = await mkdtemp(join(tmpdir(), "orca-sqlite-"));
  dirs.push(d);
  return d;
};
const stores = (dir: string): Stores => {
  const s = sqliteStores(dir);
  open.push({ close: () => s.close?.() });
  return s;
};
const plan = (id: string, name = "P"): Plan =>
  PlanSchema.parse({ id, key: id.replace(/_/g, "-"), name, createdAt: "t", updatedAt: "t" });
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("SQLite metadata backend", () => {
  it("keeps every CAS increment, event and journal entry two real child processes write", async () => {
    const dir = await makeDir();
    await stores(dir).plan.plans.put({
      id: "plan_counter",
      key: "counter",
      name: "0",
      createdAt: "t",
      updatedAt: "t",
    } as never);
    const script = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sqlite-writer.ts");
    const bundle = childBundle("sqlite-writer", { entries: { writer: script } })?.writer;
    const child = (prefix: string) =>
      run(process.execPath, bundle ? [bundle, dir, prefix, "15"] : ["--import", "tsx", script, dir, prefix, "15"]);
    await Promise.all([child("a"), child("b")]);

    const s = stores(dir);
    expect((await s.plan.plans.get("plan_counter"))?.name).toBe("30");
    expect((await s.events.read("run_shared")).map((e) => e.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect((await s.plan.journal.read("plan_shared")).map((e) => e.seq)).toEqual(
      Array.from({ length: 30 }, (_, i) => i),
    );
  }, 60_000);

  it("reads back everything after the connection closes and the database is reopened", async () => {
    const dir = await makeDir();
    const first = sqliteStores(dir);
    await first.plan.plans.putMany([plan("plan_a"), plan("plan_b")]);
    await first.events.append({ type: "run.started", runId: "run_1", payload: {} });
    await first.plan.journal.append({
      type: "request.linked",
      planId: "plan_a",
      origin: { kind: "api" },
      payload: { requestId: "req_1" },
    });
    const body = "kept";
    await first.artifacts.put(
      {
        id: "art_1",
        kind: "spec",
        name: "spec",
        mediaType: "text/plain",
        contentHash: sha256(body),
        size: body.length,
        version: 1,
        producedBy: { runId: "run_1" },
        createdAt: "t",
      } as never,
      body,
    );
    first.close?.();

    const again = stores(dir);
    expect((await again.plan.plans.list()).map((p) => p.id)).toEqual(["plan_a", "plan_b"]);
    expect((await again.events.read("run_1")).map((e) => e.type)).toEqual(["run.started"]);
    expect(await again.events.listRuns()).toEqual(["run_1"]);
    expect(await again.plan.journal.listPlans()).toEqual(["plan_a"]);
    expect(await again.artifacts.content("art_1")).toBe("kept");
    expect((await again.artifacts.list({ runId: "run_1" })).map((a) => a.id)).toEqual(["art_1"]);
  });

  it("refuses a database written by a newer schema, and names both versions", async () => {
    const dir = await makeDir();
    stores(dir);
    const raw = new DatabaseSync(join(dir, SQLITE_METADATA_FILE));
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    let error: unknown;
    try {
      sqliteStores(dir);
    } catch (e) {
      error = e;
    }
    expect(isOrcaError(error, "STORE_FORMAT")).toBe(true);
    expect((error as { details?: Record<string, unknown> }).details).toMatchObject({
      reason: "NEWER",
      schema: 99,
      supported: SQLITE_MIGRATIONS.length,
    });
  });

  it("refuses a newer database before changing anything about it, journal mode included", async () => {
    const dir = await makeDir();
    const file = join(dir, SQLITE_METADATA_FILE);
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE t (x); PRAGMA user_version = 99");
    raw.close();
    expect(() => new SqliteDatabase(file)).toThrow(expect.objectContaining({ code: "STORE_FORMAT" }));
    const after = new DatabaseSync(file, { readOnly: true });
    expect((after.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
    after.close();
    await expect(access(`${file}-wal`)).rejects.toThrow();
  });

  it("bounds an event observation in SQL before reading any event body", async () => {
    const dir = await makeDir();
    const db = new SqliteDatabase(join(dir, SQLITE_METADATA_FILE));
    open.push(db);
    const events = new SqliteEventStore(db);
    for (let i = 0; i < 5; i++) await events.append({ type: "run.started", runId: "run_big", payload: {} });
    const prepared: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      prepared.push(sql);
      return prepare(sql);
    });
    for (const limits of [
      { maxEvents: 4, maxBytes: 1_000_000 },
      { maxEvents: 100, maxBytes: 200 },
    ]) {
      prepared.length = 0;
      const error = await rejection(events.readObservation("run_big", limits));
      expect(isOrcaError(error, "RUN_STATE")).toBe(true);
      expect(prepared).toHaveLength(1);
      expect(prepared[0]).toContain("COUNT(*)");
    }
    spy.mockRestore();
    expect((await events.readObservation("run_big", { maxEvents: 5, maxBytes: 1_000_000 })).events).toHaveLength(5);
  });

  it("a write blocked by another connection's lock times out as STORE_LOCK_TIMEOUT, and succeeds after", async () => {
    const dir = await makeDir();
    const file = join(dir, SQLITE_METADATA_FILE);
    const db = new SqliteDatabase(file, { busyDeadlineMs: 150 });
    open.push(db);
    const holder = new DatabaseSync(file);
    holder.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    const error = await rejection(db.write(() => db.prepare("INSERT INTO runs (run_id) VALUES ('r')").run()));
    expect(isOrcaError(error, "STORE_LOCK_TIMEOUT")).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    holder.exec("ROLLBACK");
    holder.close();
    await db.write(() => db.prepare("INSERT INTO runs (run_id) VALUES ('r')").run());
  });

  it("a closed store refuses work instead of reopening behind the caller's back", async () => {
    const s = sqliteStores(await makeDir());
    s.close?.();
    expect(isOrcaError(await rejection(s.plan.plans.get("x")), "STORE_WRITE")).toBe(true);
  });

  it("orders ids by UTF-16 code unit, not by UTF-8 byte, in queries and cursors", async () => {
    const dir = await makeDir();
    const docs = sqliteCollection(dir, "ids", z.object({ id: z.string() }));
    open.push(docs.collection.db);
    const ids = ["￿", "\u{10000}", "a", ""];
    await docs.putMany(ids.map((id) => ({ id })));
    const expected = [...ids].sort();
    expect((await docs.query()).items.map((d) => d.id)).toEqual(expected);
    expect((await docs.query({ after: "" })).items.map((d) => d.id)).toEqual(
      expected.slice(expected.indexOf("") + 1),
    );
  });

  it("typed queries match JSON types exactly: true is not 1, null is not missing", async () => {
    const dir = await makeDir();
    const Doc = z.object({
      id: z.string(),
      flag: z.union([z.boolean(), z.number()]).optional(),
      v: z.null().optional(),
    });
    const docs = sqliteCollection(dir, "typed", Doc);
    open.push(docs.collection.db);
    await docs.putMany([
      { id: "a", flag: true, v: null },
      { id: "b", flag: 1 },
      { id: "c", flag: false },
    ]);
    const ids = async (where: object) => (await docs.query({ where })).items.map((d) => d.id);
    expect(await ids({ flag: true })).toEqual(["a"]);
    expect(await ids({ flag: 1 })).toEqual(["b"]);
    expect(await ids({ flag: false })).toEqual(["c"]);
    expect(await ids({ v: null })).toEqual(["a"]);
  });

  describe("unit of work", () => {
    it("reads its own staged writes, and nothing is visible outside until it commits", async () => {
      const dir = await makeDir();
      const s = stores(dir);
      const outside = stores(dir);
      await runUnitOfWork(s, async (tx) => {
        await tx.plans.put(plan("plan_1"));
        expect(await tx.plans.get("plan_1")).toEqual(plan("plan_1"));
        expect((await tx.plans.list()).map((p) => p.id)).toEqual(["plan_1"]);
        expect(await outside.plan.plans.get("plan_1")).toBeUndefined();
        await tx.decisions.put({ id: "dec_1" } as never);
      }).catch(() => undefined);
      // The decision does not parse, so the commit fails and nothing is written.
      expect(await outside.plan.plans.get("plan_1")).toBeUndefined();
      await runUnitOfWork(s, async (tx) => tx.plans.put(plan("plan_1")));
      expect(await outside.plan.plans.get("plan_1")).toEqual(plan("plan_1"));
    });

    it("refuses to commit over a document it read that another writer changed", async () => {
      const dir = await makeDir();
      const s = stores(dir);
      const other = stores(dir);
      await s.plan.plans.put(plan("plan_1", "before"));
      const error = await rejection(
        runUnitOfWork(s, async (tx) => {
          const current = await tx.plans.get("plan_1");
          await other.plan.plans.put(plan("plan_1", "concurrent"));
          await tx.plans.put({ ...current!, name: "derived" });
          await tx.risks.put({ ...plan("risk_1") } as never);
        }),
      );
      expect(isOrcaError(error, "REVISION_STALE")).toBe(true);
      expect((error as { details?: unknown }).details).toEqual({
        unitOfWork: true,
        collection: "plans",
        id: "plan_1",
      });
      expect((await s.plan.plans.get("plan_1"))?.name).toBe("concurrent");
    });

    it("refuses to commit after a list it made was changed by another writer", async () => {
      const dir = await makeDir();
      const s = stores(dir);
      const other = stores(dir);
      const error = await rejection(
        runUnitOfWork(s, async (tx) => {
          const existing = await tx.plans.list();
          await other.plan.plans.put(plan("plan_new"));
          await tx.plans.put(plan(`plan_${existing.length}`));
        }),
      );
      expect(isOrcaError(error, "REVISION_STALE")).toBe(true);
      expect((await s.plan.plans.list()).map((p) => p.id)).toEqual(["plan_new"]);
    });

    it("a list sees rows and the write counter in one snapshot, even when another connection commits between them", async () => {
      const dir = await makeDir();
      const s = stores(dir);
      const other = new DatabaseSync(join(dir, SQLITE_METADATA_FILE));
      const plans = (s.plan.plans as unknown as { collection: { listSync(): unknown[] } }).collection;
      const listSync = plans.listSync.bind(plans);
      // Another process commits a plan right after this connection has read the rows and
      // before it reads the counter: the two reads must still describe one state.
      plans.listSync = () => {
        const rows = listSync();
        plans.listSync = listSync;
        const body = JSON.stringify(plan("plan_other"));
        other.exec("BEGIN IMMEDIATE");
        other
          .prepare("INSERT INTO documents (collection, id, sort_key, body) VALUES ('plans', 'plan_other', 'x', ?)")
          .run(body);
        other.exec(
          "INSERT INTO collection_versions (collection, counter) VALUES ('plans', 1) " +
            "ON CONFLICT (collection) DO UPDATE SET counter = counter + 1",
        );
        other.exec("COMMIT");
        return rows;
      };
      const error = await rejection(
        runUnitOfWork(s, async (tx) => {
          const existing = await tx.plans.list();
          expect(existing).toEqual([]);
          await tx.plans.put(plan("plan_first"));
        }),
      );
      other.close();
      expect(isOrcaError(error, "REVISION_STALE")).toBe(true);
      expect((await s.plan.plans.list()).map((p) => p.id)).toEqual(["plan_other"]);
    });

    it("compare-and-swap inside the unit sees staged state and commits with it", async () => {
      const dir = await makeDir();
      const s = stores(dir);
      await s.plan.plans.put(plan("plan_1", "0"));
      await runUnitOfWork(s, async (tx) => {
        const plans = asVersionedDocumentStore(tx.plans);
        const v0 = await plans.getVersioned("plan_1");
        expect((await plans.putIfVersion(plan("plan_1", "1"), v0!.version)).ok).toBe(true);
        expect((await plans.putIfVersion(plan("plan_1", "x"), v0!.version)).ok).toBe(false);
        expect((await plans.putIfVersion(plan("plan_2"), null)).ok).toBe(true);
      });
      expect((await s.plan.plans.list()).map((p) => [p.id, p.name])).toEqual([
        ["plan_1", "1"],
        ["plan_2", "P"],
      ]);
    });
  });
});
