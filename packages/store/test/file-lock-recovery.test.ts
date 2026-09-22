/** Competing dead-owner recovery must never remove a newly acquired mutex. */
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { withFileLock } from "../src/file-lock.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});
const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

it("a delayed stale remover cannot unlink a successor after another remover won", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-lock-race-"));
  const lock = join(dir, "x.lock");
  const dead = join(lock, "owner.2147483647.dead-beef.json");
  await mkdir(lock);
  await writeFile(dead, JSON.stringify({ pid: 2147483647, at: 0, host: hostname() }));
  const bothRead = signal();
  const ownerEntered = signal();
  const releaseOwner = signal();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let removers = 0;
  vi.mocked(unlink).mockImplementation(async (path) => {
    if (path === dead) {
      if (++removers === 1) await bothRead.promise;
      else {
        bothRead.resolve();
        await ownerEntered.promise;
      }
    }
    return actual.unlink(path);
  });
  let inside = 0;
  const contender = () =>
    withFileLock(
      lock,
      async () => {
        expect(inside++).toBe(0);
        ownerEntered.resolve();
        await releaseOwner.promise;
        inside--;
      },
      { timeoutMs: 0 },
    );
  try {
    const first = contender();
    const second = contender();
    // Register both rejection handlers before releasing the delayed remover.
    const settled = Promise.allSettled([first, second]);
    await ownerEntered.promise;
    await expect(
      withFileLock(
        lock,
        async () => {
          throw new Error("overlap");
        },
        { timeoutMs: 0 },
      ),
    ).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
    // Both contenders saw the same obsolete token; its delayed unlink cannot touch
    // the successor's differently named token or remove its directory.
    expect(removers).toBe(2);
    expect(await readdir(lock)).toHaveLength(1);
    await expect(Promise.race([first, second])).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
    releaseOwner.resolve();
    const results = await settled;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  } finally {
    releaseOwner.resolve();
    vi.mocked(unlink).mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
