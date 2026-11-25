/**
 * Windows store format carryover (#910): the backup goes into a slot file that survived a Windows
 * restart (bound by file ID and BootId), rewritten in place and flushed before the marker is
 * created; the archive is the durable record of the conversion across a lost marker. Runs on any
 * platform with `platform: "win32"`, the switch on, and Windows' BootId chosen by the test.
 */
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readArchive, writeArchiveSlot } from "../src/backup-archive.js";
import { chooseBackupSlot } from "../src/store-format-carryover.js";
import {
  carryStoreForward,
  enterStoreFormat,
  posixPrivateCopy,
  readStoreFormat,
  STORE_FORMAT_BACKUP_DIR,
  STORE_FORMAT_BACKUP_MANIFEST,
  STORE_FORMAT_BACKUP_SLOTS,
  STORE_FORMAT_EPOCH,
  STORE_FORMAT_FILE,
  STORE_FORMAT_HISTORY,
  WINDOWS_STORE_CARRYOVER,
} from "../src/index.js";

const store = async () => join(await mkdtemp(join(tmpdir(), "orca-store-slots-")), ".orca");
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
const legacy = async (dir: string) => {
  await mkdir(join(dir, "runs"), { recursive: true });
  await writeFile(join(dir, "runs", "run_old.jsonl"), LOG);
  await writeFile(join(dir, ".workspace-identified"), "1\n");
  await mkdir(join(dir, "private-execution"), { mode: 0o700 });
  await writeFile(join(dir, "private-execution", "payload"), "opaque", { mode: 0o600 });
  await mkdir(join(dir, "empty-dir"));
};
const contents = async (dir: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const walk = async (path: string, prefix: string) => {
    for (const name of (await readdir(path)).sort()) {
      if (!prefix && name === STORE_FORMAT_BACKUP_DIR) continue;
      const info = await lstat(join(path, name));
      if (info.isDirectory()) await walk(join(path, name), `${prefix}${name}/`);
      else out[`${prefix}${name}`] = (await readFile(join(path, name))).toString("base64");
    }
  };
  await walk(dir, "");
  return out;
};
const slot = (dir: string, n: 0 | 1) => join(dir, STORE_FORMAT_BACKUP_DIR, STORE_FORMAT_BACKUP_SLOTS[n]);
/** Windows' BootId in the session that created the slots, and after a restart. */
const first = () => 41;
const restarted = () => 42;
const windows = { appVersion: "0.8.0", platform: "win32" as const, privacy: posixPrivateCopy, windowsCarryover: true };
const identityOf = async (path: string) => JSON.parse(await readFile(path, "utf8")) as { createdBoot: number };
/** Slots created in boot 41, then a carryover after Windows restarted. */
const carriedOnce = async (dir: string) => {
  await expect(carryStoreForward(dir, { ...windows, bootId: first })).rejects.toMatchObject({ reason: "UNDURABLE" });
  return carryStoreForward(dir, { ...windows, bootId: restarted });
};

/** An independent ZIP reader: Python's zipfile, which also checks every CRC. */
function pythonUnzip(archive: string): Record<string, string> {
  const script = [
    "import base64, json, sys, zipfile",
    "z = zipfile.ZipFile(sys.argv[1])",
    "assert z.testzip() is None",
    "print(json.dumps({i.filename: base64.b64encode(z.read(i)).decode() for i in z.infolist() if not i.is_dir()}))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-I", "-c", script, archive], { encoding: "utf8" })) as Record<
    string,
    string
  >;
}
const hasPython = (() => {
  try {
    execFileSync("python3", ["-I", "-c", "import zipfile"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("Windows format carryover into a pre-boot backup slot (#910)", () => {
  it("stays refused on Windows unless switched on, touching nothing", async () => {
    expect(WINDOWS_STORE_CARRYOVER).toBe(false);
    const dir = await store();
    await legacy(dir);
    const before = await contents(dir);
    await expect(
      carryStoreForward(dir, { appVersion: "0.8.0", platform: "win32", privacy: posixPrivateCopy, bootId: restarted }),
    ).rejects.toMatchObject({ reason: "UNDURABLE", message: expect.stringContaining("does not yet change") });
    expect(await contents(dir)).toEqual(before);
    await expect(readdir(join(dir, STORE_FORMAT_BACKUP_DIR))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the slots, each recording its file and boot, and refuses (UNDURABLE) until Windows restarts", async () => {
    const dir = await store();
    await legacy(dir);
    const before = await contents(dir);
    for (let i = 0; i < 2; i++)
      await expect(carryStoreForward(dir, { ...windows, bootId: first })).rejects.toMatchObject({
        reason: "UNDURABLE",
      });
    expect(await contents(dir)).toEqual(before);
    expect(await readStoreFormat(dir)).toBeUndefined();
    expect((await readdir(join(dir, STORE_FORMAT_BACKUP_DIR))).sort()).toEqual([...STORE_FORMAT_BACKUP_SLOTS]);
    for (const n of [0, 1] as const) {
      const info = await lstat(slot(dir, n), { bigint: true });
      expect(await identityOf(slot(dir, n))).toEqual({
        format: 1,
        tool: "orca-backup-slot", // rename-keep: persisted name kept on purpose
        slot: STORE_FORMAT_BACKUP_SLOTS[n],
        volume: info.dev.toString(),
        file: info.ino.toString(),
        createdBoot: 41,
      });
    }
    // An unreadable BootId never makes a slot usable.
    await expect(carryStoreForward(dir, { ...windows, bootId: () => undefined })).rejects.toMatchObject({
      reason: "UNDURABLE",
    });
  });

  it("archives the whole store into a slot, flushed, before the marker names it", async () => {
    const dir = await store();
    await legacy(dir);
    const before = await contents(dir);
    const outcome = await carriedOnce(dir);
    expect(outcome).toMatchObject({ status: "carried", from: "unmarked", backup: slot(dir, 0) });
    expect(await readStoreFormat(dir)).toMatchObject({ epoch: STORE_FORMAT_EPOCH, backup: slot(dir, 0) });
    // No published backup directory and no scratch left: just the slots.
    expect((await readdir(join(dir, STORE_FORMAT_BACKUP_DIR))).sort()).toEqual([...STORE_FORMAT_BACKUP_SLOTS]);
    expect(await identityOf(slot(dir, 1))).toMatchObject({ createdBoot: 41 });

    const listing = await readArchive(slot(dir, 0));
    expect([...listing.entries.keys()].sort()).toEqual(
      [
        ".workspace-identified",
        "empty-dir/",
        "private-execution/",
        "private-execution/payload",
        "runs/",
        "runs/run_old.jsonl",
        STORE_FORMAT_BACKUP_MANIFEST,
      ].sort(),
    );
    if (hasPython) {
      const unzipped = pythonUnzip(slot(dir, 0));
      const manifest = JSON.parse(Buffer.from(unzipped[STORE_FORMAT_BACKUP_MANIFEST]!, "base64").toString("utf8"));
      // The archive names its conversion and the very slot it was written into.
      expect(manifest).toMatchObject({
        format: 1,
        tool: "orca-store-format", // rename-keep: persisted name kept on purpose
        from: "unmarked",
        to: STORE_FORMAT_EPOCH,
        files: 3,
        slot: { slot: STORE_FORMAT_BACKUP_SLOTS[0], createdBoot: 41 },
      });
      delete unzipped[STORE_FORMAT_BACKUP_MANIFEST];
      expect(unzipped).toEqual(before);
    }
  });

  it("a copied or replaced slot is not the file that survived the restart: stamped anew, usable after the next one", async () => {
    const dir = await store();
    await legacy(dir);
    await expect(carryStoreForward(dir, { ...windows, bootId: first })).rejects.toMatchObject({ reason: "UNDURABLE" });
    // Both slots replaced by copies carrying the old identity (a new file ID each).
    for (const n of [0, 1] as const) {
      // Written beside the original, then renamed over it, so the copy cannot reuse its inode.
      await writeFile(`${slot(dir, n)}.copy`, await readFile(slot(dir, n)));
      await rename(`${slot(dir, n)}.copy`, slot(dir, n));
    }
    await expect(carryStoreForward(dir, { ...windows, bootId: restarted })).rejects.toMatchObject({
      reason: "UNDURABLE",
    });
    expect(await identityOf(slot(dir, 0))).toMatchObject({ createdBoot: 42 });
    expect(await carryStoreForward(dir, { ...windows, bootId: () => 43 })).toMatchObject({ backup: slot(dir, 0) });
  });

  it("a lost marker over an unchanged store: the slot archive finishes the conversion, overwriting nothing", async () => {
    const dir = await store();
    await legacy(dir);
    await carriedOnce(dir);
    const archived = await readFile(slot(dir, 0));
    const spare = await readFile(slot(dir, 1));
    // Power cut: the marker's rename did not reach the disk.
    await rm(join(dir, STORE_FORMAT_FILE));
    const outcome = await carryStoreForward(dir, { ...windows, bootId: () => 43 });
    expect(outcome).toMatchObject({ status: "carried", from: "unmarked", backup: slot(dir, 0) });
    expect(await readStoreFormat(dir)).toMatchObject({ epoch: STORE_FORMAT_EPOCH, backup: slot(dir, 0) });
    expect(await readFile(slot(dir, 0))).toEqual(archived);
    expect(await readFile(slot(dir, 1))).toEqual(spare);
  });

  it("a lost marker after new-format writes: refused (INTERRUPTED), and the only pre-upgrade backup is never reused", async () => {
    const dir = await store();
    await legacy(dir);
    await carriedOnce(dir);
    const archived = await readFile(slot(dir, 0));
    await rm(join(dir, STORE_FORMAT_FILE));
    await writeFile(join(dir, "runs", "run_new.jsonl"), LOG.replaceAll("run_old", "run_new"));
    const settle = vi.fn();
    const carryover = () => Promise.resolve({ fence: { check: () => true }, settle });
    for (let i = 0; i < 2; i++)
      await expect(
        enterStoreFormat(dir, { ...windows, mode: "write", carryover, bootId: () => 43 }),
      ).rejects.toMatchObject({ reason: "INTERRUPTED", message: expect.stringContaining(slot(dir, 0)) });
    expect(settle).toHaveBeenCalledWith("refused");
    expect(await readStoreFormat(dir)).toBeUndefined();
    expect(await readFile(slot(dir, 0))).toEqual(archived);
    // Restoring that archive returns the store as it was before the conversion.
    if (hasPython) expect(Object.keys(pythonUnzip(slot(dir, 0)))).not.toContain("runs/run_new.jsonl");
  });

  it("a slot archive recording a newer format than this ORCA's is refused (NEWER) even with the marker gone", async () => {
    const dir = await store();
    await legacy(dir);
    await carriedOnce(dir);
    const { texts } = await readArchive(slot(dir, 0), { keep: [STORE_FORMAT_BACKUP_MANIFEST] });
    const manifest = JSON.parse(texts.get(STORE_FORMAT_BACKUP_MANIFEST)!.toString("utf8"));
    await writeArchiveSlot(
      slot(dir, 0),
      dir,
      [],
      [{ path: STORE_FORMAT_BACKUP_MANIFEST, text: JSON.stringify({ ...manifest, to: "future-format-v9" }) }],
    );
    await expect(enterStoreFormat(dir, { ...windows, mode: "write", bootId: () => 43 })).rejects.toMatchObject({
      reason: "NEWER",
    });
    await rm(join(dir, STORE_FORMAT_FILE));
    await expect(carryStoreForward(dir, { ...windows, bootId: () => 43 })).rejects.toMatchObject({ reason: "NEWER" });
  });

  /** Slots created in boot 41, each then holding a record of the conversion `from` → `to`. */
  const withRecords = async (dir: string, records: [string, string][]) => {
    await expect(carryStoreForward(dir, { ...windows, bootId: first })).rejects.toMatchObject({ reason: "UNDURABLE" });
    for (const [n, [from, to]] of records.entries()) {
      const path = slot(dir, n as 0 | 1);
      const manifest = {
        format: 1,
        tool: "orca-store-format", // rename-keep: persisted name kept on purpose
        from,
        to,
        createdAt: new Date(Date.UTC(2026, 10, 22, 0, n)).toISOString(),
        files: 0,
        signature: "0".repeat(64),
        slot: await identityOf(path),
      };
      await writeArchiveSlot(path, dir, [], [{ path: STORE_FORMAT_BACKUP_MANIFEST, text: JSON.stringify(manifest) }]);
    }
  };

  it.each([
    [
      "slot 1 pending, slot 2 newer",
      [
        ["unmarked", STORE_FORMAT_EPOCH],
        ["unmarked", "future-format-v9"],
      ],
    ],
    [
      "slot 1 newer, slot 2 pending",
      [
        ["unmarked", "future-format-v9"],
        ["unmarked", STORE_FORMAT_EPOCH],
      ],
    ],
  ] as [string, [string, string][]][])(
    "a newer record is never masked by a pending one (%s): NEWER, switched off or on",
    async (_, records) => {
      const dir = await store();
      await legacy(dir);
      await withRecords(dir, records);
      const before = await Promise.all([readFile(slot(dir, 0)), readFile(slot(dir, 1))]);
      // Every Windows open checks, even with carryover switched off.
      const off = { appVersion: "0.8.0", platform: "win32" as const, privacy: posixPrivateCopy, bootId: restarted };
      await expect(enterStoreFormat(dir, { ...off, mode: "write" })).rejects.toMatchObject({ reason: "NEWER" });
      await expect(enterStoreFormat(dir, { ...off, mode: "read" })).rejects.toMatchObject({ reason: "NEWER" });
      await expect(carryStoreForward(dir, { ...windows, bootId: restarted })).rejects.toMatchObject({
        reason: "NEWER",
        message: expect.stringContaining("future-format-v9"),
      });
      expect(await readStoreFormat(dir)).toBeUndefined();
      expect(await Promise.all([readFile(slot(dir, 0)), readFile(slot(dir, 1))])).toEqual(before);
    },
  );

  it("two pending records are ambiguous: refused (INTERRUPTED), both kept", async () => {
    const dir = await store();
    await legacy(dir);
    await withRecords(dir, [
      ["unmarked", STORE_FORMAT_EPOCH],
      ["unmarked", STORE_FORMAT_EPOCH],
    ]);
    const before = await Promise.all([readFile(slot(dir, 0)), readFile(slot(dir, 1))]);
    await expect(carryStoreForward(dir, { ...windows, bootId: restarted })).rejects.toMatchObject({
      reason: "INTERRUPTED",
      message: expect.stringContaining("Both backups"),
    });
    expect(await readStoreFormat(dir)).toBeUndefined();
    expect(await Promise.all([readFile(slot(dir, 0)), readFile(slot(dir, 1))])).toEqual(before);
  });

  it("no refusal recommends extracting a backup by hand", async () => {
    const dir = await store();
    await legacy(dir);
    await carriedOnce(dir);
    await rm(join(dir, STORE_FORMAT_FILE));
    await writeFile(join(dir, "runs", "run_new.jsonl"), LOG.replaceAll("run_old", "run_new"));
    const refusal = await carryStoreForward(dir, { ...windows, bootId: () => 43 }).catch((error: Error) => error);
    expect((refusal as Error).message).toMatch(/Do not extract that backup/);
    expect((refusal as Error).message).not.toMatch(/Expand-Archive|Extract all/);
  });

  it("chooses an identity-only slot first, then a settled archive, never the marker's own backup", async () => {
    const dir = await store();
    await legacy(dir);
    await carriedOnce(dir);
    const history = [...STORE_FORMAT_HISTORY.map((f) => f.epoch), "next-format"];
    const choose = (keep: string | undefined, markerEpoch: string | undefined) =>
      chooseBackupSlot(dir, posixPrivateCopy, { keep, boot: 43, markerEpoch, history });
    expect(await choose(slot(dir, 0), STORE_FORMAT_EPOCH)).toMatchObject({ path: slot(dir, 1) });
    // Slot 2 used too: slot 1's archive converted to the marker's own format, so it is settled.
    await writeArchiveSlot(
      slot(dir, 1),
      dir,
      [],
      [
        {
          path: STORE_FORMAT_BACKUP_MANIFEST,
          text: JSON.stringify({
            format: 1,
            tool: "orca-store-format", // rename-keep: persisted name kept on purpose
            from: STORE_FORMAT_EPOCH,
            to: "next-format",
            createdAt: new Date().toISOString(),
            files: 0,
            signature: "0".repeat(64),
            slot: await identityOf(slot(dir, 1)),
          }),
        },
      ],
    );
    expect(await choose(slot(dir, 1), "next-format")).toMatchObject({ path: slot(dir, 0) });
    // While the marker is still on the earlier format, neither archive is settled.
    expect(await choose(undefined, STORE_FORMAT_HISTORY.at(-2)!.epoch)).toBeUndefined();
    // In the boot that created them, nothing is usable.
    expect(
      await chooseBackupSlot(dir, posixPrivateCopy, { keep: undefined, boot: 41, markerEpoch: "next-format", history }),
    ).toBeUndefined();
  });

  it("a half-written slot is kept, never stamped over, and the retry uses the other slot", async () => {
    const dir = await store();
    await legacy(dir);
    await expect(carryStoreForward(dir, { ...windows, bootId: first })).rejects.toMatchObject({ reason: "UNDURABLE" });
    const torn = Buffer.concat([Buffer.from("PK\x03\x04 torn"), Buffer.alloc(8192)]);
    await writeFile(slot(dir, 1), torn);
    expect(await carryStoreForward(dir, { ...windows, bootId: restarted })).toMatchObject({ backup: slot(dir, 0) });
    expect(await readFile(slot(dir, 1))).toEqual(torn);
  });

  it("a slot that is not private, or not a file, is never used", async () => {
    const dir = await store();
    await legacy(dir);
    await expect(carryStoreForward(dir, { ...windows, bootId: first })).rejects.toMatchObject({ reason: "UNDURABLE" });
    const refusing = { ...posixPrivateCopy, privateEntry: (path: string) => Promise.resolve(!path.endsWith(".zip")) };
    await expect(carryStoreForward(dir, { ...windows, privacy: refusing, bootId: restarted })).rejects.toMatchObject({
      reason: "BACKUPS_UNSAFE",
    });
    expect(await readStoreFormat(dir)).toBeUndefined();
  });

  it("an ordinary Windows open creates the slots, so a later carryover need not wait", async () => {
    const dir = await store();
    await enterStoreFormat(dir, { ...windows, mode: "write", bootId: first });
    for (const n of [0, 1] as const) expect(await identityOf(slot(dir, n))).toMatchObject({ createdBoot: 41 });
    // Without a privacy backend, nothing is created.
    const other = await store();
    await enterStoreFormat(other, { appVersion: "0.8.0", mode: "write", platform: "win32", bootId: first });
    await expect(readdir(join(other, STORE_FORMAT_BACKUP_DIR))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("the automatic carryover keeps the update handoff while it waits for a restart", async () => {
    const dir = await store();
    await legacy(dir);
    const settle = vi.fn();
    const carryover = () => Promise.resolve({ fence: { check: () => true }, settle });
    await expect(enterStoreFormat(dir, { ...windows, mode: "write", carryover, bootId: first })).rejects.toMatchObject({
      reason: "UNDURABLE",
    });
    expect(settle).not.toHaveBeenCalled();
    expect(await enterStoreFormat(dir, { ...windows, mode: "write", carryover, bootId: restarted })).toMatchObject({
      status: "carried",
      backup: slot(dir, 0),
    });
    expect(settle).toHaveBeenCalledWith("carried");
  });

  it("a lost fence before the slots are touched changes nothing", async () => {
    const dir = await store();
    await legacy(dir);
    await expect(
      carryStoreForward(dir, { ...windows, bootId: restarted, fence: { check: () => false } }),
    ).rejects.toMatchObject({ reason: "FENCE_LOST" });
    await expect(readdir(join(dir, STORE_FORMAT_BACKUP_DIR))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("backup archive (#910)", () => {
  it("rewrites an existing slot in place and detects a damaged entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-archive-"));
    await mkdir(join(root, "src", "a"), { recursive: true });
    await writeFile(join(root, "src", "a", "x.bin"), Buffer.alloc(200_000, 7));
    const target = join(root, "slot.zip");
    // Longer old content: the rewrite must truncate it.
    await writeFile(target, Buffer.alloc(500_000, 1));
    await writeArchiveSlot(
      target,
      join(root, "src"),
      [
        { path: "a", type: "dir" },
        { path: "a/x.bin", type: "file" },
      ],
      [{ path: "note.txt", text: "héllo" }],
    );
    const listing = await readArchive(target);
    expect([...listing.entries.keys()]).toEqual(["a/", "a/x.bin", "note.txt"]);
    if (hasPython) expect(Buffer.from(pythonUnzip(target)["note.txt"]!, "base64").toString()).toBe("héllo");
    // Flip one stored byte: the checksum catches it.
    const handle = await open(target, "r+");
    await handle.write(Buffer.from([9]), 0, 1, 100);
    await handle.close();
    await expect(readArchive(target)).rejects.toThrow(/checksum/);
    // The slot must already exist: it is never created here.
    await expect(writeArchiveSlot(join(root, "missing.zip"), root, [], [])).rejects.toMatchObject({ code: "ENOENT" });
  });
});
