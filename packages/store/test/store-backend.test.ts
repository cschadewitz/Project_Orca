/**
 * Which metadata backend a store runs on (#339): the SQLite store format, the offline switch
 * from files (backup, import, verify, then the marker), and the refusals that keep one
 * populated store from ever being opened by both backends.
 */
import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  backupSqliteMetadata,
  enterStoreFormat,
  holdStoreWriter,
  restoreSqliteMetadata,
  SQLITE_METADATA_FILE,
  STORE_SWITCH_FILE,
  STORE_WRITERS_DIR,
  fileStores,
  readStoreFormat,
  recordedStoreBackend,
  SQLITE_STORE_CAPABILITIES,
  SQLITE_STORE_FORMAT_EPOCH,
  sqliteStores,
  STORE_FORMAT_BACKUP_DIR,
  STORE_FORMAT_BACKUP_MANIFEST,
  STORE_FORMAT_EPOCH,
  STORE_FORMAT_FILE,
  STORE_FORMAT_HISTORY,
  switchStoreToSqlite,
} from "../src/index.js";

const store = async () => join(await mkdtemp(join(tmpdir(), "orca-store-backend-")), ".orca");

/** A store this ORCA opened on files, holding one run with a few events. */
async function populated(): Promise<string> {
  const dir = await store();
  await enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" });
  const events = fileStores(dir).events;
  await events.append({
    type: "run.created",
    runId: "run_a",
    payload: { workflowId: "review", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} },
  });
  for (let i = 0; i < 5; i++)
    await events.append({
      type: "step.started",
      runId: "run_a",
      payload: { stepRunId: `step_${i}`, inputArtifactIds: [] },
    });
  return dir;
}

/** Every file's bytes except lock files, for "nothing was changed" checks. */
async function contents(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (path: string, prefix: string) => {
    for (const name of (await readdir(path)).sort()) {
      if (name.endsWith(".lock")) continue;
      const info = await lstat(join(path, name));
      if (info.isDirectory()) await walk(join(path, name), `${prefix}${name}/`);
      else out[`${prefix}${name}`] = (await readFile(join(path, name))).toString("base64");
    }
  };
  await walk(dir, "");
  return out;
}

const refusal = (reason: string) => ({ code: "STORE_FORMAT", details: expect.objectContaining({ reason }) });

describe("store metadata backend (#339)", () => {
  it("gives SQLite stores a format of their own that no released ORCA opens", () => {
    expect(SQLITE_STORE_FORMAT_EPOCH).toBe(`${STORE_FORMAT_EPOCH}-sqlite`);
    expect(SQLITE_STORE_FORMAT_EPOCH).toMatch(/^[a-z0-9-]{1,64}$/);
    // Every release so far opens only the epochs in its history; this one is in none of them,
    // so each refuses it as newer than it can open, rather than reading the stale files.
    expect(STORE_FORMAT_HISTORY.map((f) => f.epoch)).not.toContain(SQLITE_STORE_FORMAT_EPOCH);
  });

  it("switches a populated store to SQLite after a backup, and opens it on SQLite from then on", async () => {
    const dir = await populated();
    const before = await fileStores(dir).events.read("run_a");
    const outcome = await switchStoreToSqlite(dir, {
      appVersion: "0.8.0",
    });
    expect(outcome).toMatchObject({ status: "switched", epoch: SQLITE_STORE_FORMAT_EPOCH });
    if (outcome.status !== "switched") throw new Error("not switched");
    // The backup is the whole store as it was on files.
    expect(outcome.backup.startsWith(join(dir, STORE_FORMAT_BACKUP_DIR))).toBe(true);
    expect(JSON.parse(await readFile(join(outcome.backup, STORE_FORMAT_BACKUP_MANIFEST), "utf8"))).toMatchObject({
      from: STORE_FORMAT_EPOCH,
      to: SQLITE_STORE_FORMAT_EPOCH,
    });
    expect((await readdir(join(outcome.backup, "runs"))).length).toBeGreaterThan(0);
    expect(await readStoreFormat(dir)).toMatchObject({ epoch: SQLITE_STORE_FORMAT_EPOCH, backup: outcome.backup });
    expect(recordedStoreBackend(dir)).toBe("sqlite");

    // Startup keeps the SQLite format, recording the newer writer, and says which backend.
    expect(await enterStoreFormat(dir, { appVersion: "0.8.1", mode: "write" })).toEqual({
      status: "current",
      epoch: SQLITE_STORE_FORMAT_EPOCH,
      backend: "sqlite",
    });
    expect(await readStoreFormat(dir)).toMatchObject({ epoch: SQLITE_STORE_FORMAT_EPOCH, writtenBy: "0.8.1" });
    expect(await enterStoreFormat(dir, { appVersion: "0.8.1", mode: "read" })).toMatchObject({ backend: "sqlite" });

    const sqlite = sqliteStores(dir);
    try {
      expect(sqlite.capabilities).toBe(SQLITE_STORE_CAPABILITIES);
      expect(await sqlite.events.read("run_a")).toEqual(before);
    } finally {
      sqlite.close?.();
    }
    // The file metadata left beside the database is no longer current, and is never opened.
    expect(() => fileStores(dir)).toThrow(expect.objectContaining(refusal("OTHER_BACKEND")));
    // A second switch has nothing to do.
    expect(
      await switchStoreToSqlite(dir, {
        appVersion: "0.8.1",
      }),
    ).toEqual({
      status: "current",
      epoch: SQLITE_STORE_FORMAT_EPOCH,
    });
  });

  it("never runs a workspace on a database its store has not switched to", async () => {
    const dir = await populated();
    expect(() => sqliteStores(dir)).toThrow(expect.objectContaining(refusal("OTHER_BACKEND")));
    // Maintenance that builds a database beside the files says so.
    const mirror = sqliteStores(dir, { unselected: true });
    mirror.close?.();
    expect(recordedStoreBackend(dir)).toBe("file");
  });

  it("opens a switched store read-only for checks that must change nothing", async () => {
    const dir = await populated();
    await switchStoreToSqlite(dir, {
      appVersion: "0.8.0",
    });
    const readOnly = sqliteStores(dir, { readOnly: true });
    try {
      expect((await readOnly.events.read("run_a")).length).toBe(6);
      await expect(readOnly.events.append({ type: "run.started", runId: "run_a", payload: {} })).rejects.toThrow();
    } finally {
      readOnly.close?.();
    }
  });

  it("refuses on Windows while store format changes are refused there, changing nothing", async () => {
    const dir = await populated();
    const before = await contents(dir);
    await expect(
      switchStoreToSqlite(dir, {
        appVersion: "0.8.0",
        platform: "win32",
      }),
    ).rejects.toMatchObject(refusal("UNDURABLE"));
    expect(await contents(dir)).toEqual(before);
    expect(recordedStoreBackend(dir)).toBe("file");
  });

  it("switches only a store in this ORCA's file format", async () => {
    const old = await populated();
    await writeFile(
      join(old, STORE_FORMAT_FILE),
      JSON.stringify({ format: 1, epoch: STORE_FORMAT_HISTORY[0]!.epoch, writtenBy: "0.6.0", updatedAt: "x" }),
    );
    const before = await contents(old);
    await expect(
      switchStoreToSqlite(old, {
        appVersion: "0.8.0",
      }),
    ).rejects.toMatchObject(refusal("SWITCH_REFUSED"));
    expect(await contents(old)).toEqual(before);

    const unmarked = await store();
    const events = fileStores(unmarked).events;
    await events.append({
      type: "run.created",
      runId: "run_a",
      payload: { workflowId: "review", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} },
    });
    await expect(
      switchStoreToSqlite(unmarked, {
        appVersion: "0.8.0",
      }),
    ).rejects.toMatchObject(refusal("SWITCH_REFUSED"));
    expect(await readStoreFormat(unmarked)).toBeUndefined();
  });

  it("stays on files when the store is written during the switch", async () => {
    const dir = await populated();
    await expect(
      switchStoreToSqlite(dir, {
        appVersion: "0.8.0",
        // Another writer lands after the import: the database would be missing it.
        afterImport: async () => {
          await fileStores(dir).events.append({ type: "run.started", runId: "run_a", payload: {} });
        },
      }),
    ).rejects.toMatchObject(refusal("BUSY"));
    expect(await readStoreFormat(dir)).toMatchObject({ epoch: STORE_FORMAT_EPOCH });
    expect((await fileStores(dir).events.read("run_a")).length).toBe(7);
  });

  describe("no writer beside a switch", () => {
    /** A pid no process has any more: a child that has already exited. */
    const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
    const entry = (pid: number, host = hostname()) =>
      JSON.stringify({ pid, host, appVersion: "0.8.0", purpose: "orca", since: "x" });

    it("is refused while a writer has the store open, even an idle one, and changes nothing", async () => {
      const dir = await populated();
      // Open and idle: no run, no lease, nothing written since it opened.
      const idle = holdStoreWriter(dir, { appVersion: "0.8.0", purpose: "orca serve" });
      const before = await contents(dir);
      await expect(
        switchStoreToSqlite(dir, {
          appVersion: "0.8.0",
        }),
      ).rejects.toMatchObject(refusal("BUSY"));
      expect(await contents(dir)).toEqual(before);
      expect(recordedStoreBackend(dir)).toBe("file");
      // Once it lets go, the switch goes ahead.
      idle.release();
      expect(
        await switchStoreToSqlite(dir, {
          appVersion: "0.8.0",
        }),
      ).toMatchObject({ status: "switched" });
    });

    it("is refused for a writer it cannot check (another host), and ignores one whose process is gone", async () => {
      const dir = await populated();
      await mkdir(join(dir, STORE_WRITERS_DIR), { recursive: true });
      await writeFile(join(dir, STORE_WRITERS_DIR, "1.remote.json"), entry(1, "another-host"));
      await expect(
        switchStoreToSqlite(dir, {
          appVersion: "0.8.0",
        }),
      ).rejects.toMatchObject(refusal("BUSY"));
      await rm(join(dir, STORE_WRITERS_DIR, "1.remote.json"));
      await writeFile(join(dir, STORE_WRITERS_DIR, "dead.json"), entry(deadPid()));
      expect(
        await switchStoreToSqlite(dir, {
          appVersion: "0.8.0",
        }),
      ).toMatchObject({ status: "switched" });
      expect(await readdir(join(dir, STORE_WRITERS_DIR))).toEqual([]);
    });

    it("turns away a writer that opens during the switch, up to the marker, and leaves it nothing to write to", async () => {
      const dir = await populated();
      const late = (): unknown => {
        try {
          return holdStoreWriter(dir, { appVersion: "0.8.0", purpose: "orca" });
        } catch (error) {
          return error;
        }
      };
      const attempts: unknown[] = [];
      const outcome = await switchStoreToSqlite(dir, {
        appVersion: "0.8.0",
        afterImport: async () => void attempts.push(late()),
        // The last moment before the marker: after the final checks.
        beforeMarker: async () => void attempts.push(late()),
      });
      expect(outcome).toMatchObject({ status: "switched" });
      for (const attempt of attempts) expect(attempt).toMatchObject(refusal("SWITCHING"));
      // The announcement ends with the switch; a writer starting now finds a SQLite store.
      expect(await readdir(dir)).not.toContain(STORE_SWITCH_FILE);
      const after = holdStoreWriter(dir, { appVersion: "0.8.0", purpose: "orca" });
      expect(() => fileStores(dir)).toThrow(expect.objectContaining(refusal("OTHER_BACKEND")));
      after.release();
    });

    it("honours a live switch's announcement and ignores a dead one's", async () => {
      const dir = await populated();
      await writeFile(join(dir, STORE_SWITCH_FILE), entry(process.pid));
      expect(() => holdStoreWriter(dir, { appVersion: "0.8.0", purpose: "orca" })).toThrow(
        expect.objectContaining(refusal("SWITCHING")),
      );
      expect(await readdir(join(dir, STORE_WRITERS_DIR))).toEqual([]);
      await writeFile(join(dir, STORE_SWITCH_FILE), entry(deadPid()));
      holdStoreWriter(dir, { appVersion: "0.8.0", purpose: "orca" }).release();
      // A dead switch's file is replaced by the next switch, which removes it when done.
      expect(
        await switchStoreToSqlite(dir, {
          appVersion: "0.8.0",
        }),
      ).toMatchObject({ status: "switched" });
      expect(await readdir(dir)).not.toContain(STORE_SWITCH_FILE);
    });
  });

  describe("a store on SQLite opens only its own database", () => {
    const switched = async () => {
      const dir = await populated();
      await switchStoreToSqlite(dir, {
        appVersion: "0.8.0",
      });
      return dir;
    };

    it("refuses a missing database instead of creating an empty one, and creates nothing", async () => {
      const dir = await switched();
      for (const name of await readdir(dir)) if (name.startsWith(SQLITE_METADATA_FILE)) await rm(join(dir, name));
      const before = await contents(dir);
      expect(() => sqliteStores(dir)).toThrow(expect.objectContaining(refusal("METADATA_MISSING")));
      expect(() => sqliteStores(dir, { readOnly: true })).toThrow(expect.objectContaining(refusal("METADATA_MISSING")));
      expect(await contents(dir)).toEqual(before);
    });

    it("refuses an empty or foreign file, and another store's database, changing neither", async () => {
      const dir = await switched();
      const file = join(dir, SQLITE_METADATA_FILE);
      const sqlite = sqliteStores(dir);
      sqlite.close?.();
      const own = await readFile(file);

      await rm(file);
      await writeFile(file, "");
      expect(() => sqliteStores(dir)).toThrow(expect.objectContaining(refusal("METADATA_MISMATCH")));
      expect((await readFile(file)).length).toBe(0);

      const other = await switched();
      const theirs = sqliteStores(other);
      theirs.close?.();
      await copyFile(join(other, SQLITE_METADATA_FILE), file);
      const copied = await readFile(file);
      expect(() => sqliteStores(dir)).toThrow(expect.objectContaining(refusal("METADATA_MISMATCH")));
      expect(await readFile(file)).toEqual(copied);

      // Its own database, put back, opens again.
      await writeFile(file, own);
      const back = sqliteStores(dir);
      try {
        expect((await back.events.read("run_a")).length).toBe(6);
      } finally {
        back.close?.();
      }
    });

    it("opens again once its own database is restored from a backup", async () => {
      const dir = await switched();
      const copy = join(await mkdtemp(join(tmpdir(), "orca-store-backend-backup-")), "metadata.backup");
      await backupSqliteMetadata(dir, copy);
      for (const name of await readdir(dir)) if (name.startsWith(SQLITE_METADATA_FILE)) await rm(join(dir, name));
      expect(() => sqliteStores(dir)).toThrow(expect.objectContaining(refusal("METADATA_MISSING")));
      await restoreSqliteMetadata(copy, dir);
      const restored = sqliteStores(dir);
      try {
        expect((await restored.events.read("run_a")).length).toBe(6);
      } finally {
        restored.close?.();
      }
    });
  });
});
