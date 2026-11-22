/** Automatic store carryover under a held writer fence, and verified private copies (#897). */
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  carryStoreForward,
  enterStoreFormat,
  posixPrivateCopy,
  readStoreFormat,
  STORE_FORMAT_BACKUP_DIR,
  STORE_FORMAT_EPOCH,
  STORE_UPDATE_HANDOFF_FILE,
  type CarryoverAuthority,
  type PrivateCopyBackend,
} from "../src/index.js";

const store = async () => join(await mkdtemp(join(tmpdir(), "orca-store-fenced-")), ".orca");
const LOG =
  [
    {
      id: "evt_0",
      seq: 0,
      runId: "run_old",
      at: "2026-01-02T03:04:00.000Z",
      type: "run.created",
      payload: { workflowId: "review", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} },
    },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n") + "\n";
/** An unmarked store from before the marker, without 0.7 evidence: ordinary startup refuses it. */
const legacy = async (dir: string) => {
  await mkdir(join(dir, "runs"), { recursive: true });
  await writeFile(join(dir, "runs", "run_old.jsonl"), LOG);
  await writeFile(join(dir, ".workspace-identified"), "1\n");
  await mkdir(join(dir, "private-execution"), { mode: 0o700 });
  await writeFile(join(dir, "private-execution", "payload"), "opaque", { mode: 0o600 });
};
/** Every file's bytes outside the backups folder, for "the store did not change" checks. */
const contents = async (dir: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  const walk = async (path: string, prefix: string) => {
    for (const name of (await readdir(path)).sort()) {
      if (!prefix && (name === STORE_FORMAT_BACKUP_DIR || name.endsWith(".lock"))) continue;
      const info = await lstat(join(path, name));
      if (info.isDirectory()) await walk(join(path, name), `${prefix}${name}/`);
      else out[`${prefix}${name}`] = (await readFile(join(path, name))).toString("base64");
    }
  };
  await walk(dir, "");
  return out;
};
const backups = (dir: string) => readdir(join(dir, STORE_FORMAT_BACKUP_DIR)).catch(() => [] as string[]);
/** A fence that holds for the first `holds` checks, then is lost. */
const fence = (holds = Infinity) => {
  let checks = 0;
  return {
    check: vi.fn(() => ++checks <= holds),
    get checks() {
      return checks;
    },
  };
};
const authority = (
  overrides: Partial<CarryoverAuthority> = {},
): CarryoverAuthority & { settle: ReturnType<typeof vi.fn> } =>
  ({
    fence: fence(),
    settle: vi.fn(),
    ...overrides,
  }) as CarryoverAuthority & { settle: ReturnType<typeof vi.fn> };
const start = (dir: string, carryover?: CarryoverAuthority) =>
  enterStoreFormat(dir, {
    appVersion: "0.8.0",
    mode: "write",
    ...(carryover ? { carryover: () => Promise.resolve(carryover) } : {}),
  });

describe("automatic carryover under the writer fence (#897)", () => {
  it("carries the store forward on startup only with an authority, and settles it", async () => {
    const dir = await store();
    await legacy(dir);
    const before = await contents(dir);
    // No authority: exactly the ordinary refusal, nothing changed.
    await expect(
      enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write", carryover: () => Promise.resolve(undefined) }),
    ).rejects.toMatchObject({ reason: "CARRYOVER_REQUIRED" });
    expect(await contents(dir)).toEqual(before);
    expect(await backups(dir)).toEqual([]);

    const granted = authority();
    expect(await start(dir, granted)).toMatchObject({ status: "carried", from: "unmarked", epoch: STORE_FORMAT_EPOCH });
    expect(granted.settle).toHaveBeenCalledExactlyOnceWith("carried");
    expect(await readStoreFormat(dir)).toMatchObject({ epoch: STORE_FORMAT_EPOCH, writtenBy: "0.8.0" });
    expect(await backups(dir)).toHaveLength(1);
    // Checked before the copy, after it, after the read check, before publishing, before the marker.
    expect((granted.fence as ReturnType<typeof fence>).checks).toBe(5);
    // The next start opens it in place and never asks again.
    const asked = vi.fn(() => Promise.resolve(authority()));
    expect(await enterStoreFormat(dir, { appVersion: "0.8.0", mode: "write", carryover: asked })).toMatchObject({
      status: "current",
    });
    expect(asked).not.toHaveBeenCalled();
  });

  it("refuses when the fence is already lost, copying nothing", async () => {
    const dir = await store();
    await legacy(dir);
    const before = await contents(dir);
    const granted = authority({ fence: fence(0) });
    await expect(start(dir, granted)).rejects.toMatchObject({ code: "STORE_FORMAT", reason: "FENCE_LOST" });
    expect(granted.settle).toHaveBeenCalledExactlyOnceWith("refused");
    expect(await contents(dir)).toEqual(before);
    expect(await backups(dir)).toEqual([]);
  });

  it("refuses when the fence is lost mid-copy, discarding the copy", async () => {
    const dir = await store();
    await legacy(dir);
    const before = await contents(dir);
    const granted = authority({ fence: fence(1) });
    await expect(start(dir, granted)).rejects.toMatchObject({ reason: "FENCE_LOST" });
    expect(granted.settle).toHaveBeenCalledExactlyOnceWith("refused");
    expect(await readStoreFormat(dir)).toBeUndefined();
    expect(await contents(dir)).toEqual(before);
    expect(await backups(dir)).toEqual([]);
  });

  it("leaves the prior format in charge when the fence is lost after the backup, before the marker", async () => {
    const dir = await store();
    await legacy(dir);
    const before = await contents(dir);
    await expect(start(dir, authority({ fence: fence(4) }))).rejects.toMatchObject({ reason: "FENCE_LOST" });
    expect(await readStoreFormat(dir)).toBeUndefined();
    expect(await contents(dir)).toEqual(before);
    // A published backup is a complete, verified one; it changes nothing about the store.
    expect(await backups(dir)).toHaveLength(1);
  });

  it("refuses when a second writer changes the store during the copy, even with the fence held", async () => {
    const dir = await store();
    await legacy(dir);
    const granted = authority({
      afterCopy: () => writeFile(join(dir, "runs", "run_new.jsonl"), LOG),
    });
    await expect(start(dir, granted)).rejects.toMatchObject({ reason: "BUSY" });
    expect(granted.settle).toHaveBeenCalledExactlyOnceWith("refused");
    expect(await readStoreFormat(dir)).toBeUndefined();
    expect(await backups(dir)).toEqual([]);
  });

  it("retries an interrupted carryover on the next start and clears what the interruption left", async () => {
    const dir = await store();
    await legacy(dir);
    const before = await contents(dir);
    const interrupted = authority({
      afterCopy: () => Promise.reject(new Error("process ended mid-copy")),
    });
    await expect(start(dir, interrupted)).rejects.toThrow("process ended mid-copy");
    // Not a refusal: the handoff stays for the next start to retry under the same proof.
    expect(interrupted.settle).not.toHaveBeenCalled();
    expect(await readStoreFormat(dir)).toBeUndefined();
    expect(await contents(dir)).toEqual(before);
    // A process that really died leaves its scratch copy behind.
    const scratch = ".partial-00000000-0000-4000-8000-000000000001";
    await mkdir(join(dir, STORE_FORMAT_BACKUP_DIR, scratch), { recursive: true });
    await writeFile(join(dir, STORE_FORMAT_BACKUP_DIR, scratch, "half"), "x");
    const retry = authority();
    expect(await start(dir, retry)).toMatchObject({ status: "carried" });
    expect(retry.settle).toHaveBeenCalledExactlyOnceWith("carried");
    expect((await backups(dir)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it("neither copies nor compares the updater's handoff record", async () => {
    const dir = await store();
    await legacy(dir);
    await writeFile(join(dir, STORE_UPDATE_HANDOFF_FILE), "{}\n", { mode: 0o600 });
    const granted = authority({
      // The carrying daemon rewrites the handoff before it copies; a rewrite must not read as a writer.
      afterCopy: () => writeFile(join(dir, STORE_UPDATE_HANDOFF_FILE), '{"moved":true}\n'),
    });
    const outcome = await start(dir, granted);
    expect(outcome.status).toBe("carried");
    const backup = (outcome as { backup: string }).backup;
    expect(await readdir(backup)).not.toContain(STORE_UPDATE_HANDOFF_FILE);
  });
});

describe("verified private copies (#897)", () => {
  /** A stand-in for the Windows ACL backend: every directory created and every entry verified. */
  const recording = (refuse?: (path: string, kind: "dir" | "file") => boolean) => {
    const created: string[] = [];
    const verified: string[] = [];
    const backend: PrivateCopyBackend = {
      async mkdir(path) {
        created.push(path);
        await posixPrivateCopy.mkdir(path);
      },
      privateRoot: (path) => posixPrivateCopy.privateRoot(path),
      privateEntry(path, kind) {
        verified.push(`${kind}:${path}`);
        return Promise.resolve(!refuse?.(path, kind));
      },
    };
    return { backend, created, verified };
  };

  it("carries forward through a backend that creates and verifies every copy", async () => {
    const dir = await store();
    await legacy(dir);
    const rig = recording();
    const outcome = await carryStoreForward(dir, { appVersion: "0.8.0", privacy: rig.backend });
    expect(outcome.status).toBe("carried");
    expect(rig.created[0]).toBe(join(dir, STORE_FORMAT_BACKUP_DIR));
    // Both the backup and the throwaway read copy: each private directory and file verified.
    for (const leaf of ["private-execution", "runs"])
      expect(rig.verified.filter((v) => v.startsWith("dir:") && v.endsWith(leaf))).toHaveLength(2);
    for (const leaf of ["payload", "run_old.jsonl"])
      expect(rig.verified.filter((v) => v.startsWith("file:") && v.endsWith(leaf))).toHaveLength(2);
  });

  it("refuses, publishing nothing, when a copied file cannot be verified private", async () => {
    const dir = await store();
    await legacy(dir);
    const before = await contents(dir);
    const rig = recording((path, kind) => kind === "file" && path.endsWith("payload"));
    await expect(carryStoreForward(dir, { appVersion: "0.8.0", privacy: rig.backend })).rejects.toMatchObject({
      reason: "BACKUPS_UNSAFE",
    });
    expect(await readStoreFormat(dir)).toBeUndefined();
    expect(await contents(dir)).toEqual(before);
    expect(await backups(dir)).toEqual([]);
  });

  it("refuses an existing backups folder the backend cannot verify private", async () => {
    const dir = await store();
    await legacy(dir);
    await mkdir(join(dir, STORE_FORMAT_BACKUP_DIR), { mode: 0o700 });
    const backend: PrivateCopyBackend = { ...posixPrivateCopy, privateRoot: () => Promise.resolve(false) };
    await expect(carryStoreForward(dir, { appVersion: "0.8.0", privacy: backend })).rejects.toMatchObject({
      reason: "BACKUPS_UNSAFE",
    });
    expect(await readStoreFormat(dir)).toBeUndefined();
  });
});
