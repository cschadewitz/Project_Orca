/** A lock holder can check, just before it commits, that its lock was not recovered by another process. */
import { mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withFileLock } from "../src/file-lock.js";

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
