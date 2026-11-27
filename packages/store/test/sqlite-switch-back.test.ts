/**
 * The switch back from SQLite to files (#339): everything the database holds, including what was
 * written after the switch, comes back as the file backend's own files; the legacy fence is
 * taken down, the keys come back, and the database goes only once the marker records files.
 * Every refusal, and an interruption before the marker, leaves the store on SQLite as it was.
 */
import { spawn } from "node:child_process";
import { link, lstat, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RequestSchema, sha256 } from "@orca/core";
import { childBundle } from "@orca/testing/child-bundle";
import {
  backupSqliteMetadata,
  enterStoreFormat,
  fileStores,
  FileWorkflowVersionStore,
  holdStoreWriter,
  importFileMetadata,
  LEGACY_FENCES,
  readStoreFormat,
  recordedStoreBackend,
  restoreSqliteMetadata,
  SQLITE_KEY_FILE,
  SQLITE_METADATA_FILE,
  SQLITE_STORE_FORMAT_EPOCH,
  SQLITE_SWITCH_DIR,
  SqliteDatabase,
  sqliteStores,
  STORE_FORMAT_EPOCH,
  switchStoreToFiles,
  switchStoreToSqlite,
} from "@orca/store";
import { readPrivateJson, writePrivateJson } from "../src/protected-file.js";
import {
  contents,
  expectFenced,
  isMarker,
  oldWorkflow,
  populated,
  refusal,
  workflow,
} from "./fixtures/sqlite-store-fixture.js";

/** A store switched to SQLite, with work recorded on SQLite after the switch. */
async function onSqlite(): Promise<string> {
  const dir = await populated();
  expect(await switchStoreToSqlite(dir, { appVersion: "0.8.0" })).toMatchObject({ status: "switched" });
  const sqlite = sqliteStores(dir);
  try {
    await sqlite.events.append({
      type: "run.created",
      runId: "run_b",
      payload: { workflowId: "pinned", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} },
    });
    await sqlite.events.append({ type: "run.started", runId: "run_b", payload: {} });
    await sqlite.requests.put(
      RequestSchema.parse({
        id: "req_2",
        title: "After the switch",
        body: "",
        createdAt: "2026-11-23T01:00:00.000Z",
        updatedAt: "2026-11-23T01:00:00.000Z",
      }),
    );
    await sqlite.plan.journal.append({
      type: "request.linked",
      planId: "plan_a",
      origin: { kind: "api" },
      payload: { requestId: "req_2" },
    });
    await sqlite.artifacts.put(
      {
        id: "art_2",
        kind: "spec",
        name: "later",
        mediaType: "text/plain",
        contentHash: sha256("later"),
        size: 5,
        version: 1,
        producedBy: { runId: "run_b" },
        createdAt: "t",
      } as never,
      "later",
    );
    await sqlite.workflows.put({ ...workflow, version: "2" });
  } finally {
    sqlite.close?.();
  }
  await writePrivateJson(join(dir, "private-execution"), "later.json", { secret: 2 });
  return dir;
}

/** What {@link onSqlite} recorded, read back through the file backend. */
async function expectReadsOnFiles(dir: string): Promise<void> {
  expect(recordedStoreBackend(dir)).toBe("file");
  const files = fileStores(dir);
  expect((await files.events.read("run_a")).map((e) => e.type)).toEqual(["run.created", "run.started"]);
  expect((await files.events.read("run_b")).map((e) => [e.type, e.seq])).toEqual([
    ["run.created", 0],
    ["run.started", 1],
  ]);
  expect((await files.requests.list()).map((r) => r.id).sort()).toEqual(["req_1", "req_2"]);
  expect((await files.plan.journal.read("plan_a")).map((e) => e.seq)).toEqual([0, 1]);
  expect((await files.artifacts.list()).map((a) => a.id)).toEqual(["art_1", "art_2"]);
  expect(await files.artifacts.content("art_2")).toBe("later");
  expect(await files.workflows.get("pinned", workflow.version)).toEqual(workflow);
  expect(await files.workflows.get("pinned", "2")).toMatchObject({ id: "pinned", version: "2" });
  expect(await files.workflows.get("old", oldWorkflow.version)).toEqual(oldWorkflow);
  expect(await readPrivateJson(join(dir, "private-execution"), "record.json")).toEqual({ secret: 1 });
  expect(await readPrivateJson(join(dir, "private-execution"), "later.json")).toEqual({ secret: 2 });
  // And it keeps working on files: appends continue the sequence.
  expect((await files.events.append({ type: "run.started", runId: "run_a", payload: {} })).seq).toBe(2);
}

/** Nothing of SQLite or of the fence is left in a store switched back to files. */
async function expectPlainFiles(dir: string): Promise<void> {
  for (const fence of LEGACY_FENCES) expect(await isMarker(join(dir, fence.path)), fence.path).toBe(false);
  const names = await readdir(dir);
  expect(names.filter((n) => n.startsWith(SQLITE_METADATA_FILE))).toEqual([]);
  expect(names).not.toContain(SQLITE_SWITCH_DIR);
  expect(names).not.toContain("workflows.sqlite");
  for (const sub of ["private-execution", "private-workflows"]) {
    expect(await readdir(join(dir, sub))).not.toContain(SQLITE_KEY_FILE);
    expect((await lstat(join(dir, sub, ".execution-key"))).size).toBe(32);
  }
}

/** The store is on SQLite exactly as before a refused switch back. */
async function expectStillOnSqlite(dir: string, before: Record<string, string>): Promise<void> {
  expect(await contents(dir)).toEqual(before);
  expect(await readStoreFormat(dir)).toMatchObject({ epoch: SQLITE_STORE_FORMAT_EPOCH });
  await expectFenced(dir);
  const sqlite = sqliteStores(dir);
  try {
    expect((await sqlite.events.read("run_a")).length).toBe(2);
    expect((await sqlite.events.read("run_b")).length).toBe(2);
    expect((await sqlite.requests.list()).map((r) => r.id).sort()).toEqual(["req_1", "req_2"]);
    expect((await sqlite.plan.journal.read("plan_a")).length).toBe(2);
    expect((await sqlite.artifacts.list()).map((a) => a.id)).toEqual(["art_1", "art_2"]);
    expect(await sqlite.workflows.get("old", oldWorkflow.version)).toEqual(oldWorkflow);
    expect(await readPrivateJson(join(dir, "private-execution"), "later.json")).toEqual({ secret: 2 });
  } finally {
    sqlite.close?.();
  }
}

describe("switch back to files (#339)", () => {
  it("brings back everything the database holds, including work done on SQLite, and drops the database", async () => {
    const dir = await onSqlite();
    const outcome = await switchStoreToFiles(dir, { appVersion: "0.8.0" });
    expect(outcome).toMatchObject({ status: "switched", epoch: STORE_FORMAT_EPOCH });
    const marker = await readStoreFormat(dir);
    expect(marker).toMatchObject({ epoch: STORE_FORMAT_EPOCH });
    expect(marker?.sqliteId).toBeUndefined();
    // The backup it took holds the database as it was.
    const backup = (outcome as { backup: string }).backup;
    expect(marker?.backup).toBe(backup);
    expect(await readdir(backup)).toContain(SQLITE_METADATA_FILE);
    await expectPlainFiles(dir);
    await expectReadsOnFiles(dir);
    // A plain file store again: opening it changes nothing, and it can be switched once more.
    expect(await enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).toMatchObject({ backend: "file" });
    expect(await switchStoreToFiles(dir, { appVersion: "0.8.0" })).toEqual({
      status: "current",
      epoch: STORE_FORMAT_EPOCH,
    });
    expect(await switchStoreToSqlite(dir, { appVersion: "0.8.0" })).toMatchObject({ status: "switched" });
    const sqlite = sqliteStores(dir);
    try {
      expect((await sqlite.events.read("run_a")).map((e) => e.seq)).toEqual([0, 1, 2]);
      expect((await sqlite.requests.list()).length).toBe(2);
    } finally {
      sqlite.close?.();
    }
    expect((await switchStoreToFiles(dir, { appVersion: "0.8.0" })).status).toBe("switched");
    expect((await fileStores(dir).events.read("run_a")).length).toBe(3);
  });

  it("switches back under a writer fence only while it holds, and leaves the store on SQLite once it is lost", async () => {
    // Checked before anything changes, before the journal, before the marker is staged, and at
    // its rename (after the temporary marker was written and flushed).
    for (const lostAfter of [0, 1, 2, 3]) {
      const dir = await onSqlite();
      const before = await contents(dir);
      let checks = 0;
      const fence = { check: () => checks++ < lostAfter };
      await expect(switchStoreToFiles(dir, { appVersion: "0.8.0", fence })).rejects.toMatchObject(
        refusal("FENCE_LOST"),
      );
      expect(checks, String(lostAfter)).toBe(lostAfter + 1);
      await expectStillOnSqlite(dir, before);
      expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }
    const dir = await onSqlite();
    expect(await switchStoreToFiles(dir, { appVersion: "0.8.0", fence: { check: () => true } })).toMatchObject({
      status: "switched",
    });
    await expectReadsOnFiles(dir);
  });

  it("puts every marker back when it fails at any restore step", async () => {
    for (const fence of LEGACY_FENCES) {
      const dir = await onSqlite();
      const before = await contents(dir);
      await expect(
        switchStoreToFiles(dir, {
          appVersion: "0.8.0",
          afterRestoreStep: async (path) => {
            if (path === fence.path) throw new Error("disk full");
          },
        }),
      ).rejects.toThrow("disk full");
      await expectStillOnSqlite(dir, before);
    }
  });

  it("refuses on Windows, while another writer is registered, and for a store not on SQLite", async () => {
    const dir = await onSqlite();
    const before = await contents(dir);
    await expect(switchStoreToFiles(dir, { appVersion: "0.8.0", platform: "win32" })).rejects.toMatchObject(
      refusal("UNDURABLE"),
    );
    await expectStillOnSqlite(dir, before);

    const writer = holdStoreWriter(dir, { appVersion: "0.8.0", purpose: "orca serve" });
    try {
      await expect(switchStoreToFiles(dir, { appVersion: "0.8.0" })).rejects.toMatchObject(refusal("BUSY"));
    } finally {
      writer.release();
    }
    await expectStillOnSqlite(dir, before);

    const files = await populated();
    expect(await switchStoreToFiles(files, { appVersion: "0.8.0" })).toEqual({
      status: "current",
      epoch: STORE_FORMAT_EPOCH,
    });
  });

  it("refuses a database holding something it cannot write back, changing nothing", async () => {
    const dir = await onSqlite();
    const database = new SqliteDatabase(join(dir, SQLITE_METADATA_FILE));
    try {
      await database.write(() =>
        database
          .prepare("INSERT INTO documents (collection, id, sort_key, body) VALUES ('unknown', 'x', 'x', '{}')")
          .run(),
      );
    } finally {
      database.close();
    }
    const before = await contents(dir);
    await expect(switchStoreToFiles(dir, { appVersion: "0.8.0" })).rejects.toMatchObject(refusal("UNREADABLE"));
    await expectStillOnSqlite(dir, before);
  });

  it("refuses when the database changes after it was written out", async () => {
    const dir = await onSqlite();
    let before: Record<string, string> | undefined;
    await expect(
      switchStoreToFiles(dir, {
        appVersion: "0.8.0",
        afterExport: async () => {
          const sqlite = sqliteStores(dir);
          try {
            await sqlite.events.append({ type: "run.started", runId: "run_a", payload: {} });
          } finally {
            sqlite.close?.();
          }
          before = await contents(dir);
        },
      }),
    ).rejects.toMatchObject(refusal("BUSY"));
    expect(await contents(dir)).toEqual({
      // What the switch back itself had written then: its files, and its announcement.
      ...Object.fromEntries(
        Object.entries(before!).filter(
          ([path]) => !path.startsWith(SQLITE_SWITCH_DIR) && path !== ".store-switch.json",
        ),
      ),
    });
    await expectFenced(dir);
    const sqlite = sqliteStores(dir);
    try {
      expect((await sqlite.events.read("run_a")).length).toBe(3);
    } finally {
      sqlite.close?.();
    }
  });

  it("keeps the journal when the marker's flush fails after its rename, and the next start finishes", async () => {
    const dir = await onSqlite();
    await expect(
      switchStoreToFiles(dir, {
        appVersion: "0.8.0",
        afterMarkerRename: async () => {
          throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
        },
      }),
    ).rejects.toThrow("EIO");
    expect(await readStoreFormat(dir)).toMatchObject({ epoch: STORE_FORMAT_EPOCH });
    expect(await readdir(join(dir, SQLITE_SWITCH_DIR))).toContain("journal.json");
    await expect(enterStoreFormat(dir, { appVersion: "0.8.0", mode: "read" })).rejects.toMatchObject(
      refusal("INTERRUPTED"),
    );
    expect(await enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).toMatchObject({ backend: "file" });
    await expectPlainFiles(dir);
    await expectReadsOnFiles(dir);
  });

  describe("after the marker, the next start drops the database only for this switch", () => {
    /** A switch back whose marker is published, with the database and the journal still there. */
    const published = async () => {
      const dir = await onSqlite();
      await expect(
        switchStoreToFiles(dir, {
          appVersion: "0.8.0",
          afterMarker: async () => {
            throw new Error("killed");
          },
        }),
      ).rejects.toThrow("killed");
      expect(await readStoreFormat(dir)).toMatchObject({ epoch: STORE_FORMAT_EPOCH });
      expect(await readdir(dir)).toContain(SQLITE_METADATA_FILE);
      expect(await readdir(join(dir, SQLITE_SWITCH_DIR))).toContain("journal.json");
      return dir;
    };
    const keptForReview = async (dir: string) => {
      await expect(enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).rejects.toMatchObject(
        refusal("INTERRUPTED"),
      );
      expect(await readdir(dir)).toContain(SQLITE_METADATA_FILE);
      expect(await readdir(join(dir, SQLITE_SWITCH_DIR))).toContain("journal.json");
    };

    it("finishes when the marker and the database are this switch's", async () => {
      const dir = await published();
      expect(await enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).toMatchObject({ backend: "file" });
      await expectPlainFiles(dir);
      await expectReadsOnFiles(dir);
    });

    it("finishes when an earlier cleanup already removed the database", async () => {
      const dir = await published();
      await rm(join(dir, SQLITE_METADATA_FILE));
      expect(await enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).toMatchObject({ backend: "file" });
      await expectPlainFiles(dir);
      await expectReadsOnFiles(dir);
    });

    it("refuses, dropping nothing, when the marker is not this switch's", async () => {
      const dir = await published();
      const marker = JSON.parse(await readFile(join(dir, "store-format.json"), "utf8")) as Record<string, unknown>;
      await writeFile(join(dir, "store-format.json"), JSON.stringify({ ...marker, backup: "/elsewhere/backup" }));
      await keptForReview(dir);
      const { backup: _backup, ...unnamed } = marker;
      await writeFile(join(dir, "store-format.json"), JSON.stringify(unnamed));
      await keptForReview(dir);
    });

    it("refuses, dropping nothing, when the database left behind is another store's", async () => {
      const dir = await published();
      const other = await onSqlite();
      await rm(join(dir, SQLITE_METADATA_FILE));
      await writeFile(join(dir, SQLITE_METADATA_FILE), await readFile(join(other, SQLITE_METADATA_FILE)));
      await keptForReview(dir);
    });

    it("refuses, dropping nothing, when the database left behind is a replacement bound to this store", async () => {
      const dir = await published();
      // The same store's database, as a copy put in its place: bound to this store, another file.
      const file = join(dir, SQLITE_METADATA_FILE);
      await writeFile(`${file}.copy`, await readFile(file));
      await rename(`${file}.copy`, file);
      const replacement = await readFile(file);
      await keptForReview(dir);
      expect(await readFile(file)).toEqual(replacement);
    });

    it("refuses to restore or import into the store until the switch settles, and keeps a replacement intact", async () => {
      const dir = await published();
      const file = join(dir, SQLITE_METADATA_FILE);
      const backups = await mkdtemp(join(tmpdir(), "orca-switch-back-backup-"));
      const backup = join(backups, "metadata.sqlite");
      await backupSqliteMetadata(dir, backup);
      // An earlier cleanup removed the database; the journal is still pending. A link outside the
      // store keeps the removed file's inode in use, so the file put in by hand below cannot be
      // given the same inode number and pass for the database the switch journaled (#1342).
      await link(file, `${dir}.removed-database`);
      await rm(file);
      await expect(restoreSqliteMetadata(backup, dir)).rejects.toMatchObject(refusal("SWITCH_PENDING"));
      await expect(importFileMetadata(dir)).rejects.toMatchObject(refusal("SWITCH_PENDING"));
      expect(await readdir(dir)).not.toContain(SQLITE_METADATA_FILE);
      expect(await readdir(join(dir, SQLITE_SWITCH_DIR))).toContain("journal.json");
      // Put in by hand anyway: recovery does not take it for the database the switch started from.
      await writeFile(file, await readFile(backup));
      const replacement = await readFile(file);
      await keptForReview(dir);
      expect(await readFile(file)).toEqual(replacement);
      expect(await readFile(backup)).toEqual(replacement);
    });

    /** The switch's journal, as written to disk, changed by `change`. */
    const rewriteJournal = async (dir: string, change: (journal: { database: string }) => void) => {
      const path = join(dir, SQLITE_SWITCH_DIR, "journal.json");
      const journal = JSON.parse(await readFile(path, "utf8")) as { database: string };
      change(journal);
      await writeFile(path, JSON.stringify(journal) + "\n");
    };
    const identity = async (file: string) => {
      const info = await lstat(file, { bigint: true });
      return { dev: info.dev, ino: info.ino, birth: info.birthtimeNs };
    };

    it("journals the database with its birth time, so a file that later takes its inode is another file", async () => {
      const dir = await published();
      const { dev, ino, birth } = await identity(join(dir, SQLITE_METADATA_FILE));
      const journal = JSON.parse(await readFile(join(dir, SQLITE_SWITCH_DIR, "journal.json"), "utf8")) as {
        database: string;
      };
      expect(journal.database).toBe(birth > 0n ? `${dev}:${ino}:${birth}` : `${dev}:${ino}`);
    });

    it("refuses, dropping nothing, when a replacement has the journaled database's inode but not its birth time (#1344)", async () => {
      const dir = await published();
      const file = join(dir, SQLITE_METADATA_FILE);
      const original = await readFile(file);
      // A file system that hands the freed inode to the next file: the replacement then shows the
      // journaled device and inode, and only its birth time differs.
      await rm(file);
      await writeFile(file, original);
      const { dev, ino, birth } = await identity(file);
      await rewriteJournal(dir, (journal) => {
        journal.database = `${dev}:${ino}:${birth > 1n ? birth - 1n : birth + 1n}`;
      });
      await keptForReview(dir);
      expect(await readFile(file)).toEqual(original);
    });

    it("keeps the database and the journal when the journal records no birth time (an earlier build's) (#1344)", async () => {
      const dir = await published();
      const file = join(dir, SQLITE_METADATA_FILE);
      const before = await readFile(file);
      const { dev, ino } = await identity(file);
      await rewriteJournal(dir, (journal) => {
        journal.database = `${dev}:${ino}`;
      });
      await expect(enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).rejects.toThrow(
        /cannot confirm that metadata\.sqlite is the database the switch started from/,
      );
      await keptForReview(dir);
      expect(await readFile(file)).toEqual(before);
      // With the database already gone there is nothing to keep, and the switch back finishes.
      await rm(file);
      expect(await enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).toMatchObject({ backend: "file" });
      await expectPlainFiles(dir);
      await expectReadsOnFiles(dir);
    });
  });

  describe("interrupted by a kill", () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sqlite-switch-back-crasher.ts");
    const bundle = childBundle("sqlite-switch-back-crasher", { entries: { crasher: script } })?.crasher;
    const killedAt = (dir: string, point: string) =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, bundle ? [bundle, dir, point] : ["--import", "tsx", script, dir, point], {
          stdio: ["ignore", "ignore", "inherit"],
        });
        child.on("error", reject);
        child.on("exit", (code, signal) => resolve(signal === "SIGKILL" ? null : code));
      });

    for (const point of ["afterExport", "artifacts/index.jsonl", "runs", "requests.json", "beforeMarker"])
      it(`before the marker (${point}): nothing reads the store until the next start puts it back on SQLite`, async () => {
        const dir = await onSqlite();
        const before = await contents(dir);
        expect(await killedAt(dir, point)).toBeNull();
        if (point !== "afterExport")
          await expect(enterStoreFormat(dir, { appVersion: "0.8.0", mode: "read" })).rejects.toMatchObject(
            refusal("INTERRUPTED"),
          );
        expect(await enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).toMatchObject({
          backend: "sqlite",
        });
        await expectStillOnSqlite(dir, before);
        // And the switch back can simply be run again.
        expect(await switchStoreToFiles(dir, { appVersion: "0.8.0" })).toMatchObject({ status: "switched" });
        await expectPlainFiles(dir);
        await expectReadsOnFiles(dir);
      });

    it("before the marker, with a journal that records no birth time (an earlier build's): keeps the database and the journal (#1344)", async () => {
      const dir = await onSqlite();
      expect(await killedAt(dir, "beforeMarker")).toBeNull();
      const file = join(dir, SQLITE_METADATA_FILE);
      const database = await readFile(file);
      const info = await lstat(file, { bigint: true });
      const path = join(dir, SQLITE_SWITCH_DIR, "journal.json");
      const journal = JSON.parse(await readFile(path, "utf8")) as { database: string };
      await writeFile(path, JSON.stringify({ ...journal, database: `${info.dev}:${info.ino}` }) + "\n");
      await expect(enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).rejects.toMatchObject(
        refusal("INTERRUPTED"),
      );
      expect(await readStoreFormat(dir)).toMatchObject({ epoch: SQLITE_STORE_FORMAT_EPOCH });
      expect(await readFile(file)).toEqual(database);
      expect(await readdir(join(dir, SQLITE_SWITCH_DIR))).toContain("journal.json");
    });

    for (const point of ["afterMarkerRename", "afterMarker"])
      it(`after the marker (${point}): the store is on files, and the next start finishes`, async () => {
        const dir = await onSqlite();
        expect(await killedAt(dir, point)).toBeNull();
        expect(await readStoreFormat(dir)).toMatchObject({ epoch: STORE_FORMAT_EPOCH });
        expect(await enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).toMatchObject({
          backend: "file",
        });
        await expectPlainFiles(dir);
        await expectReadsOnFiles(dir);
      });
  });

  it("does not finish an interrupted switch to SQLite on a replacement database bound to the same store", async () => {
    const interrupted = async () => {
      const dir = await populated();
      await expect(
        switchStoreToSqlite(dir, {
          appVersion: "0.8.0",
          afterMarker: async () => {
            throw new Error("killed");
          },
        }),
      ).rejects.toThrow("killed");
      expect(await readdir(join(dir, SQLITE_SWITCH_DIR))).toContain("journal.json");
      return dir;
    };
    // Its own database: the next start finishes the switch.
    expect(await enterStoreFormat(await interrupted(), { appVersion: "0.8.0", mode: "write" })).toMatchObject({
      backend: "sqlite",
    });
    // A copy put in its place: refused, and the copy is left as it is.
    const dir = await interrupted();
    const file = join(dir, SQLITE_METADATA_FILE);
    await writeFile(`${file}.copy`, await readFile(file));
    await rename(`${file}.copy`, file);
    const replacement = await readFile(file);
    await expect(enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).rejects.toMatchObject(
      refusal("INTERRUPTED"),
    );
    expect(await readFile(file)).toEqual(replacement);
    expect(await readdir(join(dir, SQLITE_SWITCH_DIR))).toContain("journal.json");
  });

  it("refuses to settle an interrupted switch back whose database is not the one its journal names", async () => {
    const dir = await onSqlite();
    await expect(
      switchStoreToFiles(dir, {
        appVersion: "0.8.0",
        beforeMarker: async () => {
          // Stands for a crash: the marker still records SQLite, so the catch puts it back. Make
          // the marker name another database first, so the put-back is the next start's to judge.
          const marker = JSON.parse(await readFile(join(dir, "store-format.json"), "utf8")) as Record<string, unknown>;
          await writeFile(
            join(dir, "store-format.json"),
            JSON.stringify({ ...marker, sqliteId: "00000000-0000-4000-8000-000000000000" }),
          );
          throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    await expect(enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).rejects.toMatchObject(
      refusal("INTERRUPTED"),
    );
    expect(await readdir(join(dir, SQLITE_SWITCH_DIR))).toContain("journal.json");
  });

  it("finds the store's keys and pinned workflows where the file backend looks for them", async () => {
    const dir = await onSqlite();
    await switchStoreToFiles(dir, { appVersion: "0.8.0" });
    expect(await new FileWorkflowVersionStore(dir).versions("pinned")).toEqual([workflow.version, "2"]);
    await writePrivateJson(join(dir, "private-execution"), "after.json", { secret: 3 });
    expect(await readPrivateJson(join(dir, "private-execution"), "after.json")).toEqual({ secret: 3 });
    expect(await readdir(join(dir, "private-execution"))).not.toContain(SQLITE_KEY_FILE);
  });
});
