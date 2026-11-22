/**
 * WAL checkpointing on the SQLite metadata backend (#339): the settings every connection gets,
 * the idle checkpoint that copies the log back once writes stop (seen through its own observer
 * and the database file, never by running another checkpoint first), what the log file keeps
 * after it starts over, that a pinned reader lets it grow past every setting, and that none of
 * it outlives the store or fails a write that has committed.
 */
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SQLITE_CHECKPOINT,
  SQLITE_METADATA_FILE,
  SqliteDatabase,
  sqliteCollection,
  type SqliteCheckpointEvent,
} from "@orca/store";

const dirs: string[] = [];
const open: { close(): void }[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) handle.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function database(options: ConstructorParameters<typeof SqliteDatabase>[1] = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orca-sqlite-checkpoint-"));
  dirs.push(dir);
  const file = join(dir, SQLITE_METADATA_FILE);
  const db = new SqliteDatabase(file, options);
  open.push(db);
  return { db, file, wal: () => (existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0) };
}

const pragma = (db: SqliteDatabase, name: string) =>
  Number(Object.values(db.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[0]);

/** Writes ~`kib` KiB of documents in transactions of `perTx` rows. */
async function fill(db: SqliteDatabase, kib: number, perTx = 16): Promise<void> {
  const body = JSON.stringify({ text: "x".repeat(1000) });
  const insert = db.prepare("INSERT OR REPLACE INTO documents (collection, id, sort_key, body) VALUES (?, ?, ?, ?)");
  for (let i = 0; i < kib; i += perTx)
    await db.write(() => {
      for (let j = i; j < Math.min(kib, i + perTx); j++) insert.run("fill", `d${j}`, `d${j}`, body);
    });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SQLite checkpoints", () => {
  it("applies the default settings, and the ones it is given", async () => {
    const { db } = await database();
    expect(pragma(db, "wal_autocheckpoint")).toBe(SQLITE_CHECKPOINT.autoPages);
    expect(pragma(db, "journal_size_limit")).toBe(SQLITE_CHECKPOINT.walLimitBytes);
    const custom = await database({ checkpoint: { autoPages: 0, walLimitBytes: 1 << 20, idleMs: 0 } });
    expect(pragma(custom.db, "wal_autocheckpoint")).toBe(0);
    expect(pragma(custom.db, "journal_size_limit")).toBe(1 << 20);
  });

  it("copies the log back into the database once writes stop", async () => {
    // No automatic checkpoint: only the idle one can move pages out of the log.
    const events: SqliteCheckpointEvent[] = [];
    const { db, file } = await database({ checkpoint: { autoPages: 0, idleMs: 30, observe: (e) => events.push(e) } });
    await fill(db, 512);
    // The rows are in the log, not yet in the database file.
    expect(statSync(file).size).toBeLessThan(256 * 1024);
    expect(events).toEqual([]);
    await sleep(150);
    // The timer's own checkpoint did the copy: it reports the whole log copied, and the database
    // file now holds the rows. Nothing else has checkpointed this database.
    expect(events).toHaveLength(1);
    const [idle] = events;
    expect(idle).toMatchObject({ trigger: "idle", busy: false });
    expect("logPages" in idle! && idle.logPages).toBeGreaterThan(100);
    expect("logPages" in idle! && idle.checkpointedPages === idle.logPages).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(512 * 1024);
  });

  it("runs no checkpoint of its own when the idle checkpoint is off", async () => {
    const events: SqliteCheckpointEvent[] = [];
    const { db, file } = await database({ checkpoint: { autoPages: 0, idleMs: 0, observe: (e) => events.push(e) } });
    await fill(db, 512);
    const size = statSync(file).size;
    await sleep(150);
    expect(events).toEqual([]);
    expect(statSync(file).size).toBe(size);
  });

  it("waits for a burst to end rather than checkpointing after every write", async () => {
    const events: SqliteCheckpointEvent[] = [];
    const { db, file } = await database({ checkpoint: { autoPages: 0, idleMs: 200, observe: (e) => events.push(e) } });
    const start = statSync(file).size;
    // Writes keep coming more often than the idle window: no checkpoint runs between them.
    for (let i = 0; i < 6; i++) {
      await fill(db, 32);
      await sleep(40);
    }
    expect(events).toEqual([]);
    expect(statSync(file).size).toBe(start);
    await sleep(400);
    expect(events).toHaveLength(1);
    expect(statSync(file).size).toBeGreaterThan(start);
  });

  it("lets the log grow past every setting while a reader holds a snapshot", async () => {
    const limit = 256 * 1024;
    const events: SqliteCheckpointEvent[] = [];
    const { db, file, wal } = await database({
      checkpoint: { autoPages: 16, idleMs: 30, walLimitBytes: limit, observe: (e) => events.push(e) },
    });
    await fill(db, 8);
    const reader = new SqliteDatabase(file, { checkpoint: { idleMs: 0 } });
    open.push(reader);
    reader.db.exec("BEGIN");
    reader.db.prepare("SELECT COUNT(*) FROM documents").get();
    await fill(db, 1024);
    // Neither the automatic trigger (16 pages) nor the retention limit bounds growth here.
    expect(wal()).toBeGreaterThan(4 * limit);
    await sleep(120);
    // The idle checkpoint ran but could not copy past the reader's snapshot.
    const idle = events.at(-1)!;
    expect("logPages" in idle && idle.checkpointedPages < idle.logPages).toBe(true);
    expect(wal()).toBeGreaterThan(4 * limit);
    // Once the reader lets go, a checkpoint copies everything, and the next write starts the
    // log over and cuts the file back to what it may keep.
    reader.db.exec("COMMIT");
    const done = db.checkpoint("passive");
    expect(done.checkpointedPages).toBe(done.logPages);
    await fill(db, 1);
    expect(wal()).toBeLessThanOrEqual(limit);
  });

  it("keeps no more than its limit once the log starts over after a burst", async () => {
    const limit = 256 * 1024;
    const { db, wal } = await database({ checkpoint: { autoPages: 0, idleMs: 0, walLimitBytes: limit } });
    await fill(db, 2048);
    expect(wal()).toBeGreaterThan(2 * limit);
    expect(db.checkpoint("passive").busy).toBe(false);
    // The next write starts the log over, and the file is truncated to the limit.
    await fill(db, 1);
    expect(wal()).toBeLessThanOrEqual(limit);
    // A truncating checkpoint empties it.
    db.checkpoint("truncate");
    expect(wal()).toBe(0);
  });

  it("keeps the log near the automatic trigger for a connection that never goes idle, with no readers", async () => {
    const { db, wal } = await database({ checkpoint: { autoPages: 64, idleMs: 0 } });
    await fill(db, 2048);
    // 64 pages of 4 KiB, plus the one transaction that crossed it: observed here, not promised.
    expect(wal()).toBeLessThan(64 * 4096 + 128 * 1024);
  });

  it("does not outlive a closed store, and a write never fails because of a checkpoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-sqlite-checkpoint-"));
    dirs.push(dir);
    const docs = sqliteCollection(dir, "docs", z.object({ id: z.string(), n: z.number() }), {
      checkpoint: { idleMs: 20 },
    });
    await docs.put({ id: "a", n: 1 });
    // Closed before the idle checkpoint is due: the timer is cancelled, nothing throws later.
    docs.collection.db.close();
    await sleep(80);
    // A second connection holding a read snapshot makes the idle checkpoint stop early; the
    // write that armed it has already committed and stays committed.
    const writer = sqliteCollection(dir, "docs", z.object({ id: z.string(), n: z.number() }), {
      checkpoint: { idleMs: 20 },
    });
    open.push(writer.collection.db);
    const reader = new SqliteDatabase(join(dir, SQLITE_METADATA_FILE));
    open.push(reader);
    reader.db.exec("BEGIN");
    reader.db.prepare("SELECT COUNT(*) FROM documents").get();
    await writer.put({ id: "b", n: 2 });
    await sleep(80);
    reader.db.exec("COMMIT");
    expect((await writer.get("b"))?.n).toBe(2);
  });
});
