/**
 * A lock holder can check, just before it commits, that its lock was not recovered by another
 * process; and a lock in provable mode is recovered only when its holder is provably gone.
 */
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILE_LOCK, livenessDomain, withFileLock } from "../src/file-lock.js";

it("stillHeld passes while the holder's token is there, and fails closed once it is gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-lock-held-"));
  const lock = join(dir, "x.lock");
  try {
    await withFileLock(lock, async (stillHeld) => {
      await stillHeld();
      // As if another process recovered the lock: this holder's token is gone.
      for (const name of await readdir(lock)) await unlink(join(lock, name));
      await expect(stillHeld()).rejects.toMatchObject({ code: "STORE_LOCK_LOST" });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("provable owner recovery (the config file's lock, #701 review)", () => {
  const DEAD = 2147483647;
  async function leftBy(holder: object): Promise<{ dir: string; lock: string }> {
    const dir = await mkdtemp(join(tmpdir(), "orca-lock-provable-"));
    const lock = join(dir, "x.lock");
    await mkdir(lock);
    await writeFile(
      join(lock, `owner.${DEAD}.dead-beef.json`),
      JSON.stringify({ pid: DEAD, at: 0, host: hostname(), ...holder }),
    );
    return { dir, lock };
  }

  it("leaves a dead holder's lock for a person unless it proves the same liveness domain", async () => {
    for (const holder of [{}, { domain: "linux:00000000-0000-0000-0000-000000000000:pid:[1]" }]) {
      const { dir, lock } = await leftBy(holder);
      try {
        await expect(
          withFileLock(lock, async () => "ran", { ...CONFIG_FILE_LOCK, timeoutMs: 100 }),
        ).rejects.toMatchObject({
          code: "STORE_LOCK_TIMEOUT",
        });
        // The default mode, by host name, still clears the same lock.
        expect(await withFileLock(lock, async () => "ran", { timeoutMs: 1_000 })).toBe("ran");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it.runIf(livenessDomain() !== null)("clears a dead holder's lock that names this domain", async () => {
    const { dir, lock } = await leftBy({ domain: livenessDomain() });
    try {
      expect(await withFileLock(lock, async () => "ran", { ...CONFIG_FILE_LOCK, timeoutMs: 1_000 })).toBe("ran");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
