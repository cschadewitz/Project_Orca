/**
 * Which metadata backend a store runs on (#339): the SQLite store format, the offline switch
 * from files (backup, import, verify, then the marker), and the refusals that keep one
 * populated store from ever being opened by both backends.
 */
import { lstat, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  enterStoreFormat,
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
    const outcome = await switchStoreToSqlite(dir, { appVersion: "0.8.0" });
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
    expect(await switchStoreToSqlite(dir, { appVersion: "0.8.1" })).toEqual({
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
    await switchStoreToSqlite(dir, { appVersion: "0.8.0" });
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
    await expect(switchStoreToSqlite(dir, { appVersion: "0.8.0", platform: "win32" })).rejects.toMatchObject(
      refusal("UNDURABLE"),
    );
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
    await expect(switchStoreToSqlite(old, { appVersion: "0.8.0" })).rejects.toMatchObject(refusal("SWITCH_REFUSED"));
    expect(await contents(old)).toEqual(before);

    const unmarked = await store();
    const events = fileStores(unmarked).events;
    await events.append({
      type: "run.created",
      runId: "run_a",
      payload: { workflowId: "review", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} },
    });
    await expect(switchStoreToSqlite(unmarked, { appVersion: "0.8.0" })).rejects.toMatchObject(
      refusal("SWITCH_REFUSED"),
    );
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
});
