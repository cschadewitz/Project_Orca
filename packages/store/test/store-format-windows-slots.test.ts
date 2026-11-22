/**
 * Windows store format carryover (#910): the backup goes into a slot file that existed before
 * Windows last started, rewritten in place and flushed before the marker is created. Runs on any
 * platform with `platform: "win32"` injected and the boot time chosen by the test.
 */
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readArchive, writeArchiveSlot } from "../src/backup-archive.js";
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
/** A boot time after the slots were created: they predate it by more than the margin. */
const later = () => Date.now() + 60 * 60_000;
/** A boot time before the slots were created. */
const earlier = () => Date.now() - 60 * 60_000;
const windows = { appVersion: "0.8.0", platform: "win32" as const, privacy: posixPrivateCopy };

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
  it("creates the slots and refuses (UNDURABLE) until they predate the current boot, copying nothing", async () => {
    const dir = await store();
    await legacy(dir);
    const before = await contents(dir);
    for (let i = 0; i < 2; i++)
      await expect(carryStoreForward(dir, { ...windows, bootTime: earlier })).rejects.toMatchObject({
        reason: "UNDURABLE",
      });
    expect(await contents(dir)).toEqual(before);
    expect(await readStoreFormat(dir)).toBeUndefined();
    // Only the two empty slots: no staged copy, no backup.
    expect((await readdir(join(dir, STORE_FORMAT_BACKUP_DIR))).sort()).toEqual([...STORE_FORMAT_BACKUP_SLOTS]);
    for (const n of [0, 1] as const) expect((await lstat(slot(dir, n))).size).toBe(0);
  });

  it("archives the whole store into a slot, flushed, before the marker names it", async () => {
    const dir = await store();
    await legacy(dir);
    const before = await contents(dir);
    await expect(carryStoreForward(dir, { ...windows, bootTime: earlier })).rejects.toMatchObject({
      reason: "UNDURABLE",
    });
    const outcome = await carryStoreForward(dir, { ...windows, bootTime: later });
    expect(outcome).toMatchObject({ status: "carried", from: "unmarked", backup: slot(dir, 0) });
    expect(await readStoreFormat(dir)).toMatchObject({ epoch: STORE_FORMAT_EPOCH, backup: slot(dir, 0) });
    // No published backup directory and no scratch left: just the slots.
    expect((await readdir(join(dir, STORE_FORMAT_BACKUP_DIR))).sort()).toEqual([...STORE_FORMAT_BACKUP_SLOTS]);
    expect((await lstat(slot(dir, 1))).size).toBe(0);

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
      expect(manifest).toMatchObject({ format: 1, tool: "orca-store-format", from: "unmarked", files: 3 });
      delete unzipped[STORE_FORMAT_BACKUP_MANIFEST];
      expect(unzipped).toEqual(before);
    }
  });

  it("never overwrites the slot the marker names: the next carryover takes the other one", async () => {
    const dir = await store();
    await legacy(dir);
    await expect(carryStoreForward(dir, { ...windows, bootTime: earlier })).rejects.toMatchObject({
      reason: "UNDURABLE",
    });
    await carryStoreForward(dir, { ...windows, bootTime: later });
    const first = await readFile(slot(dir, 0));
    // The store is now on the previous format again, its marker naming the first backup.
    const previous = STORE_FORMAT_HISTORY.at(-2)!.epoch;
    const marker = JSON.parse(await readFile(join(dir, STORE_FORMAT_FILE), "utf8"));
    await writeFile(join(dir, STORE_FORMAT_FILE), JSON.stringify({ ...marker, epoch: previous }));
    await writeFile(join(dir, "runs", "run_new.jsonl"), LOG.replaceAll("run_old", "run_new"));
    const outcome = await carryStoreForward(dir, { ...windows, bootTime: later });
    expect(outcome).toMatchObject({ status: "carried", from: previous, backup: slot(dir, 1) });
    expect(await readFile(slot(dir, 0))).toEqual(first);
    expect([...(await readArchive(slot(dir, 1))).entries.keys()]).toContain("runs/run_new.jsonl");
    // A third: the marker names slot 2, so slot 1 (the oldest) is reused.
    await writeFile(join(dir, STORE_FORMAT_FILE), JSON.stringify({ ...(await readStoreFormat(dir)), epoch: previous }));
    const second = await readFile(slot(dir, 1));
    expect(await carryStoreForward(dir, { ...windows, bootTime: later })).toMatchObject({ backup: slot(dir, 0) });
    expect(await readFile(slot(dir, 1))).toEqual(second);
  });

  it("an interrupted archive leaves the prior format in charge, and the retry uses the empty slot", async () => {
    const dir = await store();
    await legacy(dir);
    await expect(carryStoreForward(dir, { ...windows, bootTime: earlier })).rejects.toMatchObject({
      reason: "UNDURABLE",
    });
    // A slot left half-written by a crash: not a valid archive.
    await writeFile(slot(dir, 1), "PK\x03\x04 torn");
    const outcome = await carryStoreForward(dir, { ...windows, bootTime: later });
    expect(outcome).toMatchObject({ backup: slot(dir, 0) });
  });

  it("a slot that is not private, or not a file, is never used", async () => {
    const dir = await store();
    await legacy(dir);
    await expect(carryStoreForward(dir, { ...windows, bootTime: earlier })).rejects.toMatchObject({
      reason: "UNDURABLE",
    });
    const refusing = { ...posixPrivateCopy, privateEntry: (path: string) => Promise.resolve(!path.endsWith(".zip")) };
    await expect(carryStoreForward(dir, { ...windows, privacy: refusing, bootTime: later })).rejects.toMatchObject({
      reason: "BACKUPS_UNSAFE",
    });
    expect(await readStoreFormat(dir)).toBeUndefined();
  });

  it("an ordinary Windows open creates the slots, so a later carryover need not wait", async () => {
    const dir = await store();
    await enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write", platform: "win32", privacy: posixPrivateCopy });
    for (const n of [0, 1] as const) expect((await lstat(slot(dir, n))).isFile()).toBe(true);
    // Without a privacy backend, or off Windows, nothing is created.
    const other = await store();
    await enterStoreFormat(other, { appVersion: "0.8.0", mode: "write", platform: "win32" });
    await expect(readdir(join(other, STORE_FORMAT_BACKUP_DIR))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("the automatic carryover keeps the update handoff while it waits for a restart", async () => {
    const dir = await store();
    await legacy(dir);
    const settle = vi.fn();
    const carryover = () => Promise.resolve({ fence: { check: () => true }, settle });
    await expect(
      enterStoreFormat(dir, { ...windows, mode: "write", carryover, bootTime: earlier }),
    ).rejects.toMatchObject({ reason: "UNDURABLE" });
    expect(settle).not.toHaveBeenCalled();
    expect(await enterStoreFormat(dir, { ...windows, mode: "write", carryover, bootTime: later })).toMatchObject({
      status: "carried",
      backup: slot(dir, 0),
    });
    expect(settle).toHaveBeenCalledWith("carried");
  });

  it("a lost fence before the slots are touched changes nothing", async () => {
    const dir = await store();
    await legacy(dir);
    await expect(
      carryStoreForward(dir, { ...windows, bootTime: later, fence: { check: () => false } }),
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
