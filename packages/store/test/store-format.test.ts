/** Store format marker and the verified carryover of older stores (#566). */
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  carryStoreForward,
  enterStoreFormat,
  readStoreFormat,
  STORE_FORMAT_BACKUP_DIR,
  STORE_FORMAT_BACKUP_MANIFEST,
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
const RUN = [
  {
    id: "evt_0",
    seq: 0,
    runId: "run_old",
    at: "2026-01-02T03:04:00.000Z",
    type: "run.created",
    payload: { workflowId: "review", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} },
  },
  { id: "evt_1", seq: 1, runId: "run_old", at: "2026-01-02T03:04:01.000Z", type: "run.started", payload: {} },
];
const LOG = RUN.map((l) => JSON.stringify(l)).join("\n") + "\n";
/** A store as an earlier ORCA leaves it: a real run log, identity marker, a private dir and a lock. */
const legacy = async (dir: string) => {
  await mkdir(join(dir, "runs"), { recursive: true });
  await writeFile(join(dir, "runs", "run_old.jsonl"), LOG);
  await writeFile(join(dir, ".workspace-identified"), "1\n");
  await mkdir(join(dir, "private-execution"), { mode: 0o700 });
  await writeFile(join(dir, "private-execution", "payload"), "opaque", { mode: 0o600 });
  await mkdir(join(dir, "plan.lock"));
};
const clock = (iso: string) => () => new Date(iso);
const backups = (dir: string) => readdir(join(dir, STORE_FORMAT_BACKUP_DIR)).catch(() => [] as string[]);

describe("store format marker (#566)", () => {
  it("matches the release compatibility manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../../release-compatibility.json", import.meta.url), "utf8"),
    ) as { storeEpoch: string };
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
    expect(await backups(dir)).toEqual([]);
  });

  it("opens a same-format store in place and records the newer writer", async () => {
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await legacy(dir);
    await marker(dir, STORE_FORMAT_EPOCH, "0.7.0");
    expect((await enterStoreFormat(dir, { appVersion: "0.7.1", mode: "write" })).status).toBe("current");
    expect((await readStoreFormat(dir))?.writtenBy).toBe("0.7.1");
    expect(await backups(dir)).toEqual([]);
  });

  it("stamps an unmarked store its own format line wrote, without converting it", async () => {
    const dir = await store();
    await mkdir(join(dir, "workspace-identity"), { recursive: true });
    await legacy(dir);
    expect(await enterStoreFormat(dir, { appVersion: "0.7.1", mode: "read" })).toMatchObject({ status: "adopted" });
    expect(await readStoreFormat(dir)).toBeUndefined();
    expect(await enterStoreFormat(dir, { appVersion: "0.7.1", mode: "write" })).toMatchObject({ status: "adopted" });
    expect(await readStoreFormat(dir)).toMatchObject({ epoch: STORE_FORMAT_EPOCH, writtenBy: "0.7.1" });
    expect(await backups(dir)).toEqual([]);
  });

  it("never converts an older store during ordinary startup", async () => {
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await legacy(dir);
    for (const mode of ["write", "read"] as const)
      await expect(enterStoreFormat(dir, { appVersion: "0.7.1", mode })).rejects.toMatchObject({
        code: "STORE_FORMAT",
        reason: "CARRYOVER_REQUIRED",
      });
    await marker(dir, SUPPORTED_STORE_FORMATS[0]!, "0.6.0");
    await expect(enterStoreFormat(dir, { appVersion: "0.7.1", mode: "write" })).rejects.toMatchObject({
      reason: "CARRYOVER_REQUIRED",
    });
    expect((await readStoreFormat(dir))?.epoch).toBe(SUPPORTED_STORE_FORMATS[0]);
    expect(await backups(dir)).toEqual([]);
  });

  it("carry-forward backs up, verifies and reads an older store before stamping it", async () => {
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await legacy(dir);
    const outcome = await carryStoreForward(dir, {
      appVersion: "0.7.1",
      now: clock("2026-11-22T01:02:03.004Z"),
    });
    expect(outcome).toMatchObject({ status: "carried", from: "unmarked" });
    if (outcome.status !== "carried" || !outcome.backup) throw new Error("no backup");
    expect(await readFile(join(outcome.backup, "runs", "run_old.jsonl"), "utf8")).toBe(LOG);
    expect(await readFile(join(outcome.backup, "private-execution", "payload"), "utf8")).toBe("opaque");
    const listed = await readdir(outcome.backup);
    expect(listed).toEqual(expect.arrayContaining(["runs", ".workspace-identified", STORE_FORMAT_BACKUP_MANIFEST]));
    expect(listed).not.toContain("plan.lock");
    expect(listed).not.toContain(STORE_FORMAT_FILE);
    if (process.platform !== "win32") {
      expect((await lstat(join(dir, STORE_FORMAT_BACKUP_DIR))).mode & 0o777).toBe(0o700);
      expect((await lstat(join(outcome.backup, "private-execution"))).mode & 0o777).toBe(0o700);
      expect((await lstat(join(outcome.backup, "private-execution", "payload"))).mode & 0o777).toBe(0o600);
    }
    // The read check ran on a throwaway copy: the backup holds exactly the store's files.
    expect((await readdir(join(outcome.backup, "runs"))).sort()).toEqual(["run_old.jsonl"]);
    expect(await readStoreFormat(dir)).toMatchObject({ epoch: STORE_FORMAT_EPOCH, backup: outcome.backup });
    expect((await enterStoreFormat(dir, { appVersion: "0.7.1", mode: "write" })).status).toBe("current");
    expect((await carryStoreForward(dir, { appVersion: "0.7.1" })).status).toBe("current");
    expect(await backups(dir)).toHaveLength(1);
  });

  it("refuses and keeps the prior format when another writer changes the store during the copy", async () => {
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await legacy(dir);
    const error = await carryStoreForward(dir, {
      appVersion: "0.7.1",
      afterCopy: () => writeFile(join(dir, "runs", "run_old.jsonl"), LOG + LOG.split("\n")[1] + "\n"),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreFormatError);
    expect(error).toMatchObject({ code: "STORE_FORMAT", reason: "BUSY" });
    expect(await readStoreFormat(dir)).toBeUndefined();
    expect(await backups(dir)).toEqual([]);
    // Once the other writer is gone, the next start carries it forward.
    await writeFile(join(dir, "runs", "run_old.jsonl"), LOG);
    expect((await carryStoreForward(dir, { appVersion: "0.7.1" })).status).toBe("carried");
  });

  it("refuses while a run lease is live", async () => {
    const dir = await store();
    await mkdir(join(dir, "leases"), { recursive: true });
    await legacy(dir);
    await writeFile(
      join(dir, "leases", "run_old.json"),
      JSON.stringify({
        resource: "run_old",
        holder: "orca-serve@host:1",
        pid: 1,
        host: "host",
        acquiredAt: new Date().toISOString(),
        renewedAt: new Date().toISOString(),
        ttlMs: 600_000,
      }),
    );
    await expect(carryStoreForward(dir, { appVersion: "0.7.1" })).rejects.toMatchObject({ reason: "BUSY" });
    expect(await readStoreFormat(dir)).toBeUndefined();
  });

  it("refuses when run leases cannot be read", async () => {
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await legacy(dir);
    await writeFile(join(dir, "leases"), "not a directory");
    await expect(carryStoreForward(dir, { appVersion: "0.7.1" })).rejects.toMatchObject({ reason: "BUSY" });
    expect(await readStoreFormat(dir)).toBeUndefined();
  });

  it("refuses a store the current readers cannot read, leaving it unmarked", async () => {
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await legacy(dir);
    await writeFile(join(dir, "requests.json"), "{not json");
    await expect(carryStoreForward(dir, { appVersion: "0.7.1" })).rejects.toMatchObject({
      reason: "UNREADABLE",
    });
    expect(await readStoreFormat(dir)).toBeUndefined();
    expect(await backups(dir)).toEqual([]);
    expect(await readFile(join(dir, "requests.json"), "utf8")).toBe("{not json");
  });

  it("keeps the newest two verified backups and never touches anything else in the backups folder", async () => {
    const previous = SUPPORTED_STORE_FORMATS[0]!;
    const dir = await store();
    await mkdir(join(dir, STORE_FORMAT_BACKUP_DIR), { recursive: true, mode: 0o700 });
    await legacy(dir);
    // Looks like one of ours but carries no manifest: kept.
    await mkdir(join(dir, STORE_FORMAT_BACKUP_DIR, "2020-01-01T00-00-00-000Z-from-unmarked"));
    await writeFile(join(dir, STORE_FORMAT_BACKUP_DIR, "notes.txt"), "mine");
    // Left by an interrupted carryover: removed.
    await mkdir(join(dir, STORE_FORMAT_BACKUP_DIR, ".partial-00000000-0000-4000-8000-000000000000"));
    for (const [i, at] of ["2026-11-20", "2026-11-21", "2026-11-22"].entries()) {
      await marker(dir, previous, `0.6.${i}`);
      const outcome = await carryStoreForward(dir, { appVersion: "0.7.1", now: clock(`${at}T00:00:00Z`) });
      expect(outcome).toMatchObject({ status: "carried", from: previous });
    }
    expect((await backups(dir)).sort()).toEqual([
      "2020-01-01T00-00-00-000Z-from-unmarked",
      `2026-11-21T00-00-00-000Z-from-${previous}`,
      `2026-11-22T00-00-00-000Z-from-${previous}`,
      "notes.txt",
    ]);
  });

  it("refuses a backups folder that is not a private directory", async () => {
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await legacy(dir);
    await writeFile(join(dir, STORE_FORMAT_BACKUP_DIR), "not a directory");
    await expect(carryStoreForward(dir, { appVersion: "0.7.1" })).rejects.toMatchObject({
      reason: "BACKUPS_UNSAFE",
    });
    expect(await readStoreFormat(dir)).toBeUndefined();
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
    expect(await backups(dir)).toEqual([]);
  });

  it("refuses a known format older than the supported window", async () => {
    if (STORE_FORMAT_HISTORY.length < 3) return; // Nothing has aged out yet.
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await marker(dir, STORE_FORMAT_HISTORY[0]!.epoch);
    await expect(enterStoreFormat(dir, { appVersion: "0.7.1", mode: "write" })).rejects.toMatchObject({
      reason: "TOO_OLD",
    });
  });

  it("refuses a damaged marker", async () => {
    const dir = await store();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, STORE_FORMAT_FILE), "{not json");
    await expect(enterStoreFormat(dir, { appVersion: "0.7.1", mode: "write" })).rejects.toMatchObject({
      reason: "DAMAGED",
    });
  });

  it("only checks in read mode", async () => {
    const dir = await store();
    await mkdir(join(dir, "workspace-identity"), { recursive: true });
    await legacy(dir);
    expect(await enterStoreFormat(dir, { appVersion: "0.7.1", mode: "read" })).toMatchObject({ status: "adopted" });
    expect(await readdir(dir)).not.toContain(STORE_FORMAT_FILE);
    expect(await backups(dir)).toEqual([]);
  });
});
