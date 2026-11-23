/**
 * The legacy fence of a switch to SQLite (#339): released ORCA versions that never read the
 * format marker are kept out by markers in place of every path they open first, every step can
 * be undone until the marker is written, an interrupted switch is finished or undone by the next
 * start, and a SQLite store takes back only its own database. The released binaries themselves
 * are run against a fenced store in `tools/legacy-fence` (CI: legacy-fence workflow).
 */
import { spawn } from "node:child_process";
import { appendFile, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { childBundle } from "@orca/testing/child-bundle";
import {
  backupSqliteMetadata,
  enterStoreFormat,
  fileStores,
  FileWorkflowVersionStore,
  LEGACY_FENCES,
  readStoreFormat,
  recordedStoreBackend,
  restoreSqliteMetadata,
  SQLITE_KEY_FILE,
  SQLITE_METADATA_FILE,
  SQLITE_STORE_FORMAT_EPOCH,
  SQLITE_SWITCH_DIR,
  sqliteStores,
  STORE_FORMAT_EPOCH,
  switchStoreToSqlite,
} from "@orca/store";
import { writePrivateJson } from "../src/protected-file.js";
import {
  contents,
  expectFenced,
  expectReadsOnSqlite,
  isMarker,
  populated,
  refusal,
  workflow,
} from "./fixtures/sqlite-store-fixture.js";

describe("legacy fence (#339)", () => {
  it("replaces every path a released ORCA opens first with a marker, and runs on SQLite with nothing lost", async () => {
    const dir = await populated();
    expect(await switchStoreToSqlite(dir, { appVersion: "0.8.0" })).toMatchObject({ status: "switched" });
    await expectFenced(dir);
    // The keys moved to where only this ORCA looks; the originals are no longer anywhere live.
    for (const sub of ["private-execution", "private-workflows"])
      expect((await lstat(join(dir, sub, SQLITE_KEY_FILE))).size).toBe(32);
    expect((await readdir(join(dir, "workflows.sqlite"))).sort()).toEqual(["old@v1.json"]);
    await expectReadsOnSqlite(dir);
    // Writing works too, through the moved keys.
    const sqlite = sqliteStores(dir);
    try {
      await sqlite.workflows.put({ ...workflow, version: "2" });
      expect(await new FileWorkflowVersionStore(dir).versions("pinned")).toEqual([workflow.version, "2"]);
    } finally {
      sqlite.close?.();
    }
  });

  it("undoes every step when the switch fails at any point of the fence, leaving the files exactly as they were", async () => {
    for (const fence of LEGACY_FENCES) {
      const dir = await populated();
      const before = await contents(dir);
      await expect(
        switchStoreToSqlite(dir, {
          appVersion: "0.8.0",
          afterFenceStep: async (path) => {
            if (path === fence.path) throw new Error("disk full");
          },
        }),
      ).rejects.toThrow("disk full");
      expect(await contents(dir), fence.path).toEqual(before);
      expect(recordedStoreBackend(dir)).toBe("file");
      expect((await fileStores(dir).events.read("run_a")).length).toBe(2);
    }
  });

  it("switches under a writer fence only while it holds, and undoes everything once it is lost", async () => {
    // The fence is checked before anything changes, before the journal, and before the marker.
    for (const lostAfter of [0, 1, 2]) {
      const dir = await populated();
      const before = await contents(dir);
      let checks = 0;
      const fence = { check: () => checks++ < lostAfter };
      await expect(switchStoreToSqlite(dir, { appVersion: "0.8.0", fence })).rejects.toMatchObject(
        refusal("FENCE_LOST"),
      );
      expect(checks, String(lostAfter)).toBe(lostAfter + 1);
      expect(await contents(dir), String(lostAfter)).toEqual(before);
      expect(recordedStoreBackend(dir)).toBe("file");
      expect(await readdir(dir)).not.toContain(SQLITE_SWITCH_DIR);
    }
    const dir = await populated();
    expect(await switchStoreToSqlite(dir, { appVersion: "0.8.0", fence: { check: () => true } })).toMatchObject({
      status: "switched",
    });
    await expectFenced(dir);
    await expectReadsOnSqlite(dir);
  });

  it("refuses, and puts everything back, when a released ORCA writes while the fence goes in", async () => {
    const dir = await populated();
    await expect(
      switchStoreToSqlite(dir, {
        appVersion: "0.8.0",
        // The keys are fenced, the run logs not yet: a legacy append that was already under way.
        afterFenceStep: async (path) => {
          if (path === "private-workflows/.execution-key") await appendFile(join(dir, "runs", "run_a.jsonl"), "");
          if (path === "decisions.json")
            await appendFile(
              join(dir, "runs", "run_a.jsonl"),
              JSON.stringify({ seq: 2, type: "run.completed", runId: "run_a", payload: {} }) + "\n",
            );
        },
      }),
    ).rejects.toMatchObject(refusal("BUSY"));
    expect(recordedStoreBackend(dir)).toBe("file");
    expect(await readFile(join(dir, "runs", "run_a.jsonl"), "utf8")).toContain("run.completed");
    expect(await readdir(dir)).not.toContain(SQLITE_SWITCH_DIR);
  });

  describe("interrupted by a kill", () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sqlite-switch-crasher.ts");
    const bundle = childBundle("sqlite-switch-crasher", { entries: { crasher: script } })?.crasher;
    const killedAt = (dir: string, point: string) =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, bundle ? [bundle, dir, point] : ["--import", "tsx", script, dir, point], {
          stdio: ["ignore", "ignore", "inherit"],
        });
        child.on("error", reject);
        child.on("exit", (code, signal) => resolve(signal === "SIGKILL" ? null : code));
      });

    for (const point of ["private-execution/.execution-key", "requests.json", "runs", "beforeMarker"])
      it(`before the marker (${point}): keeps released ORCA out meanwhile, and the next start undoes it`, async () => {
        const dir = await populated();
        const before = await contents(dir);
        expect(await killedAt(dir, point)).toBeNull();
        // Until then: the first key is fenced, and nothing reads the store.
        expect(await isMarker(join(dir, "private-execution", ".execution-key"))).toBe(true);
        await expect(enterStoreFormat(dir, { appVersion: "0.8.0", mode: "read" })).rejects.toMatchObject(
          refusal("INTERRUPTED"),
        );
        expect(await enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).toMatchObject({
          epoch: STORE_FORMAT_EPOCH,
          backend: "file",
        });
        expect(await contents(dir)).toEqual(before);
        expect((await fileStores(dir).events.read("run_a")).length).toBe(2);
        // And the switch can simply be run again.
        expect(await switchStoreToSqlite(dir, { appVersion: "0.8.0" })).toMatchObject({ status: "switched" });
        await expectFenced(dir);
        await expectReadsOnSqlite(dir);
      });

    for (const point of ["afterMarkerRename", "afterMarker"])
      it(`after the marker (${point}): the store is on SQLite, and the next start finishes`, async () => {
        const dir = await populated();
        expect(await killedAt(dir, point)).toBeNull();
        expect(await readStoreFormat(dir)).toMatchObject({ epoch: SQLITE_STORE_FORMAT_EPOCH });
        expect(await enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).toMatchObject({
          backend: "sqlite",
        });
        await expectFenced(dir);
        await expectReadsOnSqlite(dir);
      });
  });

  it("keeps the journal when the marker's flush fails after its rename, and the next start finishes", async () => {
    const dir = await populated();
    await expect(
      switchStoreToSqlite(dir, {
        appVersion: "0.8.0",
        afterMarkerRename: async () => {
          throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
        },
      }),
    ).rejects.toThrow("EIO");
    // The marker may be published, so nothing was rolled back: fenced, with the journal kept.
    expect(await readStoreFormat(dir)).toMatchObject({ epoch: SQLITE_STORE_FORMAT_EPOCH });
    for (const fence of LEGACY_FENCES) expect(await isMarker(join(dir, fence.path)), fence.path).toBe(true);
    expect(await readdir(join(dir, SQLITE_SWITCH_DIR))).toContain("journal.json");
    await expect(enterStoreFormat(dir, { appVersion: "0.8.0", mode: "read" })).rejects.toMatchObject(
      refusal("INTERRUPTED"),
    );
    expect(await enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).toMatchObject({ backend: "sqlite" });
    expect(await readdir(dir)).not.toContain(SQLITE_SWITCH_DIR);
    await expectFenced(dir);
    await expectReadsOnSqlite(dir);
  });

  it("finishes an interrupted switch only when the database is bound to the switch the journal names", async () => {
    const dir = await populated();
    await expect(
      switchStoreToSqlite(dir, {
        appVersion: "0.8.0",
        afterMarkerRename: async () => {
          throw new Error("EIO");
        },
      }),
    ).rejects.toThrow("EIO");
    // Another store's database in its place: neither finished nor rolled back.
    const other = await populated();
    await switchStoreToSqlite(other, { appVersion: "0.8.0" });
    await rm(join(dir, SQLITE_METADATA_FILE), { force: true });
    await writeFile(join(dir, SQLITE_METADATA_FILE), await readFile(join(other, SQLITE_METADATA_FILE)));
    await expect(enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write" })).rejects.toMatchObject(
      refusal("INTERRUPTED"),
    );
    expect(await readdir(join(dir, SQLITE_SWITCH_DIR))).toContain("journal.json");
  });

  it("restores only the store's own database, checked before anything is published", async () => {
    const dir = await populated();
    await switchStoreToSqlite(dir, { appVersion: "0.8.0" });
    const other = await populated();
    await switchStoreToSqlite(other, { appVersion: "0.8.0" });
    const backups = await mkdtemp(join(tmpdir(), "orca-legacy-fence-backups-"));
    await backupSqliteMetadata(dir, join(backups, "own"));
    await backupSqliteMetadata(other, join(backups, "other"));
    // A mirror built beside the files before any switch: bound to no store.
    const unswitched = await populated();
    sqliteStores(unswitched, { unselected: true }).close?.();
    await backupSqliteMetadata(unswitched, join(backups, "unbound"));

    for (const name of await readdir(dir)) if (name.startsWith(SQLITE_METADATA_FILE)) await rm(join(dir, name));
    for (const [backup, reason] of [
      ["other", "METADATA_MISMATCH"],
      ["unbound", "METADATA_MISMATCH"],
    ] as const) {
      await expect(restoreSqliteMetadata(join(backups, backup), dir)).rejects.toMatchObject(refusal(reason));
      expect((await readdir(dir)).filter((n) => n.startsWith(SQLITE_METADATA_FILE))).toEqual([]);
    }
    await restoreSqliteMetadata(join(backups, "own"), dir);
    await expectReadsOnSqlite(dir);
  });

  it("never makes a new key for a switched store whose key went missing", async () => {
    const dir = await populated();
    await switchStoreToSqlite(dir, { appVersion: "0.8.0" });
    await rm(join(dir, "private-execution", SQLITE_KEY_FILE));
    await expect(writePrivateJson(join(dir, "private-execution"), "new.json", { a: 1 })).rejects.toThrow();
    expect(await readdir(join(dir, "private-execution"))).not.toContain(SQLITE_KEY_FILE);
  });
});
