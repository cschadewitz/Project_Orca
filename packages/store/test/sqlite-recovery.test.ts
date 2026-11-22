/**
 * Recovery for the SQLite metadata backend (#339): import from a file-backed store (rerunnable,
 * never over history it does not know), backup and restore into a fresh instance, verification
 * as the diagnosable repair state, and a process killed mid-write at random commit boundaries.
 */
import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, isOrcaError, PlanSchema, sha256, type Artifact, type Plan } from "@orca/core";
import {
  backupSqliteMetadata,
  fileStores,
  importFileMetadata,
  restoreSqliteMetadata,
  SQLITE_METADATA_FILE,
  sqliteStores,
  verifySqliteMetadata,
  type Stores,
} from "@orca/store";
import { childBundle } from "@orca/testing/child-bundle";

const dirs: string[] = [];
const open: Stores[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) s.close?.();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const makeDir = async () => {
  const d = await mkdtemp(join(tmpdir(), "orca-sqlite-recovery-"));
  dirs.push(d);
  return d;
};
const sqlite = (dir: string) => {
  const s = sqliteStores(dir);
  open.push(s);
  return s;
};
const plan = (n: number, name = "P"): Plan =>
  PlanSchema.parse({ id: `plan_${n}`, key: `plan-${n}`, name, createdAt: "t", updatedAt: "t" });
const artifact = (id: string, body: string): Artifact =>
  ({
    id,
    kind: "spec",
    name: id,
    mediaType: "text/plain",
    contentHash: sha256(body),
    size: Buffer.byteLength(body),
    version: 1,
    producedBy: { runId: "run_1" },
    createdAt: "t",
  }) as never;
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

/** A file-backed store with something in every seam the import moves. */
async function seedFileStore(dir: string): Promise<Stores> {
  const files = fileStores(dir, new FakeClock());
  await files.plan.plans.putMany([plan(1), plan(2)]);
  for (let i = 0; i < 12; i++) await files.events.append({ type: "run.started", runId: "run_1", payload: {} });
  await files.events.append({ type: "run.started", runId: "run_2", payload: {} });
  for (let i = 0; i < 3; i++)
    await files.plan.journal.append({
      type: "request.linked",
      planId: "plan_1",
      origin: { kind: "api" },
      payload: { requestId: `req_${i}` },
    });
  await files.artifacts.put(artifact("art_1", "one"), "one");
  await files.artifacts.put(artifact("art_2", "two"), "two");
  return files;
}

describe("SQLite import from a file-backed store", () => {
  it("copies ids, order and timestamps exactly, and a rerun imports only what is new", async () => {
    const dir = await makeDir();
    const files = await seedFileStore(dir);
    const first = await importFileMetadata(dir);
    expect(first).toMatchObject({ runs: 2, eventsImported: 13, plans: 1, planEventsImported: 3, artifacts: 2 });
    expect(first.documents.plans).toBe(2);

    const s = sqlite(dir);
    expect(await s.plan.plans.list()).toEqual(await files.plan.plans.list());
    for (const runId of ["run_1", "run_2"]) expect(await s.events.read(runId)).toEqual(await files.events.read(runId));
    expect(await s.events.listRuns()).toEqual(await files.events.listRuns());
    expect(await s.plan.journal.read("plan_1")).toEqual(await files.plan.journal.read("plan_1"));
    expect(await s.artifacts.list()).toEqual(await files.artifacts.list());
    expect(await s.artifacts.content("art_2")).toBe("two");

    expect(await importFileMetadata(dir)).toMatchObject({ eventsImported: 0, planEventsImported: 0 });
    await files.events.append({ type: "run.started", runId: "run_1", payload: {} });
    await files.plan.plans.delete("plan_2");
    expect(await importFileMetadata(dir)).toMatchObject({ eventsImported: 1, documents: { plans: 1 } });
    expect((await s.events.read("run_1")).length).toBe(13);
    expect((await s.plan.plans.list()).map((p) => p.id)).toEqual(["plan_1"]);
  });

  it("an interrupted import is finished by a rerun", async () => {
    const dir = await makeDir();
    const files = await seedFileStore(dir);
    await importFileMetadata(dir);
    // What a kill between transactions leaves: a run with only its first events.
    const raw = new DatabaseSync(join(dir, SQLITE_METADATA_FILE));
    raw.exec("DELETE FROM events WHERE run_id = 'run_1' AND seq >= 5; DELETE FROM plan_events");
    raw.close();
    expect(await importFileMetadata(dir)).toMatchObject({ eventsImported: 7, planEventsImported: 3 });
    expect(await sqlite(dir).events.read("run_1")).toEqual(await files.events.read("run_1"));
    expect((await verifySqliteMetadata(dir)).ok).toBe(true);
  });

  it("refuses to import over history the database has and the files do not", async () => {
    const dir = await makeDir();
    await seedFileStore(dir);
    await importFileMetadata(dir);
    await sqlite(dir).events.append({ type: "run.started", runId: "run_2", payload: {} });
    // The file store has also changed in ways the import would apply before reaching run_2.
    const files = fileStores(dir);
    await files.plan.plans.delete("plan_2");
    await files.events.append({ type: "run.started", runId: "run_1", payload: {} });
    const before = await verifySqliteMetadata(dir);
    const error = await rejection(importFileMetadata(dir));
    expect(isOrcaError(error, "STORE_FORMAT")).toBe(true);
    expect((error as { details?: unknown }).details).toMatchObject({ reason: "IMPORT_CONFLICT", runId: "run_2" });
    // Refused before any write: nothing the import would have changed has changed.
    const after = await verifySqliteMetadata(dir);
    expect(after).toEqual(before);
    expect((await sqlite(dir).plan.plans.list()).map((p) => p.id)).toEqual(["plan_1", "plan_2"]);
    expect((await sqlite(dir).events.read("run_1")).length).toBe(12);
  });

  it("refuses a source that changes while it is read, and changes nothing", async () => {
    const dir = await makeDir();
    const files = await seedFileStore(dir);
    await importFileMetadata(dir);
    const before = await verifySqliteMetadata(dir);
    const error = await rejection(
      importFileMetadata(dir, {
        betweenSourceReads: async () => {
          await files.events.append({ type: "run.started", runId: "run_1", payload: {} });
        },
      }),
    );
    expect(isOrcaError(error, "STORE_WRITE")).toBe(true);
    expect((error as { details?: unknown }).details).toMatchObject({ reason: "SOURCE_CHANGED" });
    expect(await verifySqliteMetadata(dir)).toEqual(before);
  });
});

describe("SQLite backup, restore and verify", () => {
  it("a backup restored into a fresh instance has the same metadata, and verify names missing blobs", async () => {
    const dir = await makeDir();
    await seedFileStore(dir);
    await importFileMetadata(dir);
    const backup = join(await makeDir(), "metadata-backup.sqlite");
    expect((await backupSqliteMetadata(dir, backup)).bytes).toBeGreaterThan(0);
    expect(isOrcaError(await rejection(backupSqliteMetadata(dir, backup)), "STORE_WRITE")).toBe(true);

    const fresh = await makeDir();
    await restoreSqliteMetadata(backup, fresh);
    expect(isOrcaError(await rejection(restoreSqliteMetadata(backup, fresh)), "STORE_WRITE")).toBe(true);
    const original = await verifySqliteMetadata(dir);
    const restored = await verifySqliteMetadata(fresh);
    for (const key of ["documents", "runs", "events", "plans", "planEvents", "artifacts"] as const)
      expect(restored[key]).toEqual(original[key]);
    expect(await sqlite(fresh).events.read("run_1")).toEqual(await sqlite(dir).events.read("run_1"));

    // The database came back without the blob files: every reference is reported, nothing is guessed.
    expect(restored.ok).toBe(false);
    expect(restored.problems.map((p) => [p.kind, p.detail.id])).toEqual([
      ["artifactBlobMissing", "art_1"],
      ["artifactBlobMissing", "art_2"],
    ]);
    await cp(join(dir, "artifacts"), join(fresh, "artifacts"), { recursive: true });
    expect((await verifySqliteMetadata(fresh)).ok).toBe(true);
    expect(await sqlite(fresh).artifacts.content("art_1")).toBe("one");
  });

  it("restore refuses a damaged or newer database and leaves the store without one", async () => {
    const source = await makeDir();
    await seedFileStore(source);
    await importFileMetadata(source);
    const newer = join(await makeDir(), "newer.sqlite");
    await backupSqliteMetadata(source, newer);
    const raw = new DatabaseSync(newer);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    const garbage = join(await makeDir(), "garbage.sqlite");
    await writeFile(garbage, "not a database");
    const target = await makeDir();
    for (const bad of [newer, garbage]) expect(await rejection(restoreSqliteMetadata(bad, target))).toBeDefined();
    expect(isOrcaError(await rejection(verifySqliteMetadata(target)), "STORE_FORMAT")).toBe(true);
  });

  it("restore never replaces a database that appears while it runs, and leaves no staging file", async () => {
    const source = await makeDir();
    await seedFileStore(source);
    await importFileMetadata(source);
    const backup = join(await makeDir(), "backup.sqlite");
    await backupSqliteMetadata(source, backup);
    const target = await makeDir();
    const error = await rejection(
      restoreSqliteMetadata(backup, target, {
        beforePublish: async () => {
          // Another process creates and writes a database at the target meanwhile.
          const other = sqliteStores(target);
          await other.plan.plans.put(plan(9, "concurrent"));
          other.close?.();
        },
      }),
    );
    expect(isOrcaError(error, "STORE_WRITE")).toBe(true);
    expect((error as { details?: unknown }).details).toMatchObject({ reason: "EXISTS" });
    expect((await sqlite(target).plan.plans.list()).map((p) => p.name)).toEqual(["concurrent"]);
    expect((await readdir(target)).filter((n) => n.includes(".restore"))).toEqual([]);
  });

  it("restore refuses a live WAL-mode database that is not a sealed backup", async () => {
    const source = await makeDir();
    await seedFileStore(source);
    await importFileMetadata(source);
    const live = sqlite(source);
    await live.plan.plans.put(plan(7));
    const error = await rejection(restoreSqliteMetadata(join(source, SQLITE_METADATA_FILE), await makeDir()));
    expect(isOrcaError(error, "STORE_FORMAT")).toBe(true);
    expect((error as { details?: unknown }).details).toMatchObject({ reason: "NOT_SEALED" });
  });

  it("verify reports a blob whose bytes no longer match its hash", async () => {
    const dir = await makeDir();
    await seedFileStore(dir);
    await importFileMetadata(dir);
    await writeFile(join(dir, "artifacts", "blobs", sha256("one")), "tampered");
    const report = await verifySqliteMetadata(dir);
    expect(report.problems).toEqual([
      { kind: "artifactBlobMismatch", detail: { id: "art_1", contentHash: sha256("one") } },
    ]);
  });
});

describe("SQLite across kills", () => {
  it("keeps every acknowledged write, with no duplicate or dangling one, across repeated SIGKILLs", async () => {
    const dir = await makeDir();
    const seed = sqliteStores(dir);
    await seed.plan.plans.put({ ...plan(0, "0"), id: "plan_counter" });
    seed.close?.();
    const script = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sqlite-crasher.ts");
    const bundle = childBundle("sqlite-crasher", { entries: { crasher: script } })?.crasher;
    const acked = { counter: 0, journal: [] as string[], events: -1, artifacts: [] as string[] };

    for (let round = 0; round < 4; round++) {
      const after = 15 + Math.floor(Math.random() * 40);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          bundle ? [bundle, dir, `r${round}`] : ["--import", "tsx", script, dir, `r${round}`],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        let lines = 0;
        let buffered = "";
        child.stdout.on("data", (chunk: Buffer) => {
          buffered += chunk.toString("utf8");
          const parts = buffered.split("\n");
          buffered = parts.pop()!;
          for (const line of parts) {
            const [kind, value] = line.split(" ") as [string, string];
            if (kind === "counter") acked.counter = Number(value);
            else if (kind === "journal") acked.journal.push(value);
            else if (kind === "event") acked.events = Number(value);
            else if (kind === "artifact") acked.artifacts.push(value);
            if (++lines === after) child.kill("SIGKILL");
          }
        });
        child.on("error", reject);
        child.on("exit", () => resolve());
      });
    }

    const s = sqlite(dir);
    const counter = Number((await s.plan.plans.get("plan_counter"))!.name);
    // The kill can land after a commit and before its acknowledgement: at most one more.
    expect(counter - acked.counter).toBeGreaterThanOrEqual(0);
    expect(counter - acked.counter).toBeLessThanOrEqual(1);
    const ops = (await s.plan.journal.read("plan_ops")).map((e) => (e.payload as { requestId: string }).requestId);
    expect(new Set(ops).size).toBe(ops.length);
    for (const op of acked.journal) expect(ops).toContain(op);
    const events = await s.events.read("run_crash");
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.length - 1).toBeGreaterThanOrEqual(acked.events);
    for (const id of acked.artifacts) expect(await s.artifacts.content(id)).toBe(`artifact ${id.slice(4)}`);
    const report = await verifySqliteMetadata(dir);
    expect(report.problems).toEqual([]);
    // A kill between a blob and its index row leaves at most an unreferenced blob per round, never a dangling row.
    expect(report.unreferencedBlobs.length).toBeLessThanOrEqual(4);
  }, 120_000);
});
