import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  enterStoreFormat,
  readStoreFormat,
  STORE_FORMAT_BACKUP_DIR,
  STORE_FORMAT_EPOCH,
  STORE_FORMAT_FILE,
  STORE_FORMAT_HISTORY,
  StoreFormatError,
  SUPPORTED_STORE_FORMATS,
} from "../src/index.js";

const store = async () => join(await mkdtemp(join(tmpdir(), "orca-store-format-")), ".orca");
const marker = (dir: string, epoch: string, writtenBy = "9.9.9") =>
  writeFile(
    join(dir, STORE_FORMAT_FILE),
    JSON.stringify({ format: 1, epoch, writtenBy, updatedAt: "2026-11-22T00:00:00.000Z" }),
  );
const legacy = async (dir: string) => {
  await mkdir(join(dir, "runs"), { recursive: true });
  await writeFile(join(dir, "runs", "r1.jsonl"), '{"type":"run.started"}\n');
  await writeFile(join(dir, ".workspace-identified"), "1\n");
  await mkdir(join(dir, "plan.lock"));
};
const clock = (iso: string) => () => new Date(iso);

describe("store format marker (#566)", () => {
  it("matches the release compatibility manifest", async () => {
    const manifest = JSON.parse(await readFile(join(__dirname, "../../../release-compatibility.json"), "utf8")) as {
      storeEpoch: string;
    };
    expect(STORE_FORMAT_EPOCH).toBe(manifest.storeEpoch);
    expect(SUPPORTED_STORE_FORMATS).toEqual(STORE_FORMAT_HISTORY.slice(-2).map((f) => f.epoch));
  });

  it("stamps a fresh store without a backup", async () => {
    const dir = await store();
    expect(await enterStoreFormat(dir, { appVersion: "0.7.1", mode: "write" })).toEqual({
      status: "fresh",
      epoch: STORE_FORMAT_EPOCH,
    });
    expect(await readStoreFormat(dir)).toMatchObject({ epoch: STORE_FORMAT_EPOCH, writtenBy: "0.7.1" });
    expect(await readdir(dir)).not.toContain(STORE_FORMAT_BACKUP_DIR);
  });

  it("opens a same-format store in place and records the newer writer", async () => {
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await marker(dir, STORE_FORMAT_EPOCH, "0.7.0");
    await legacy(dir);
    expect((await enterStoreFormat(dir, { appVersion: "0.7.1", mode: "write" })).status).toBe("current");
    expect((await readStoreFormat(dir))?.writtenBy).toBe("0.7.1");
    expect(await readdir(dir)).not.toContain(STORE_FORMAT_BACKUP_DIR);
  });

  it("backs up an unmarked store whole before carrying it forward", async () => {
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await legacy(dir);
    const outcome = await enterStoreFormat(dir, {
      appVersion: "0.7.1",
      mode: "write",
      now: clock("2026-11-22T01:02:03.004Z"),
    });
    expect(outcome).toMatchObject({ status: "carried", from: "unmarked" });
    if (outcome.status !== "carried" || !outcome.backup) throw new Error("no backup");
    expect(await readFile(join(outcome.backup, "runs", "r1.jsonl"), "utf8")).toBe('{"type":"run.started"}\n');
    expect(await readdir(outcome.backup)).toEqual(expect.arrayContaining(["runs", ".workspace-identified"]));
    expect(await readdir(outcome.backup)).not.toContain("plan.lock");
    expect(await readdir(outcome.backup)).not.toContain(STORE_FORMAT_FILE);
    expect(await readStoreFormat(dir)).toMatchObject({ epoch: STORE_FORMAT_EPOCH, backup: outcome.backup });
    // The next open is the same format: no second backup.
    expect((await enterStoreFormat(dir, { appVersion: "0.7.1", mode: "write" })).status).toBe("current");
    expect(await readdir(join(dir, STORE_FORMAT_BACKUP_DIR))).toHaveLength(1);
  });

  it("carries the previous format forward and keeps only the newest two backups", async () => {
    const previous = SUPPORTED_STORE_FORMATS[0]!;
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await legacy(dir);
    for (const [i, at] of ["2026-11-20", "2026-11-21", "2026-11-22"].entries()) {
      await marker(dir, previous, `0.6.${i}`);
      const outcome = await enterStoreFormat(dir, {
        appVersion: "0.7.1",
        mode: "write",
        now: clock(`${at}T00:00:00Z`),
      });
      expect(outcome).toMatchObject({ status: "carried", from: previous });
    }
    const kept = await readdir(join(dir, STORE_FORMAT_BACKUP_DIR));
    expect(kept.sort()).toEqual([
      `2026-11-21T00-00-00-000Z-from-${previous}`,
      `2026-11-22T00-00-00-000Z-from-${previous}`,
    ]);
  });

  it("refuses a store written by a newer format without changing it", async () => {
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await legacy(dir);
    await marker(dir, "future-format-v9", "0.9.0");
    const before = await readFile(join(dir, STORE_FORMAT_FILE), "utf8");
    for (const mode of ["write", "read"] as const) {
      const error = await enterStoreFormat(dir, { appVersion: "0.7.1", mode }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StoreFormatError);
      expect(error).toMatchObject({ code: "STORE_FORMAT", reason: "NEWER" });
      expect((error as Error).message).toContain("ORCA 0.9.0");
    }
    expect(await readFile(join(dir, STORE_FORMAT_FILE), "utf8")).toBe(before);
    expect(await readdir(dir)).not.toContain(STORE_FORMAT_BACKUP_DIR);
  });

  it("refuses a known format older than the supported window", async () => {
    if (STORE_FORMAT_HISTORY.length < 3) return; // Nothing has aged out yet.
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await marker(dir, STORE_FORMAT_HISTORY[0]!.epoch);
    await expect(enterStoreFormat(dir, { appVersion: "0.7.1", mode: "write" })).rejects.toMatchObject({
      code: "STORE_FORMAT",
      reason: "TOO_OLD",
    });
  });

  it("refuses a damaged marker", async () => {
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, STORE_FORMAT_FILE), "{not json");
    await expect(enterStoreFormat(dir, { appVersion: "0.7.1", mode: "write" })).rejects.toMatchObject({
      code: "STORE_FORMAT",
      reason: "DAMAGED",
    });
  });

  it("only checks in read mode", async () => {
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await legacy(dir);
    expect(await enterStoreFormat(dir, { appVersion: "0.7.1", mode: "read" })).toMatchObject({
      status: "carried",
      from: "unmarked",
    });
    expect(await readdir(dir)).not.toContain(STORE_FORMAT_FILE);
    expect(await readdir(dir)).not.toContain(STORE_FORMAT_BACKUP_DIR);
  });
});
