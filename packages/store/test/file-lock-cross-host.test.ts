/**
 * #103 (narrow scope): sharing one store's lock directories between hosts over a
 * shared volume is unsupported. A lock whose owner token records a different hostname is never
 * judged dead, however old it is and whatever its pid looks like here: contenders wait
 * out their deadline and fail with STORE_LOCK_TIMEOUT, and the holder's token is kept
 * byte for byte. See docs/storage/file-locks.md.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFileLock } from "../src/file-lock.js";

vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, hostname: vi.fn(actual.hostname) };
});

const DEAD_PID = 2147483647;
const OTHER_HOST = "orca-test-other-host.invalid";
const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(hostname).mockReset();
  vi.mocked(hostname).mockImplementation((await vi.importActual<typeof import("node:os")>("node:os")).hostname);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function lockWithToken(owner: { pid: number; at: number; host?: string }) {
  const dir = await mkdtemp(join(tmpdir(), "orca-lock-cross-host-"));
  dirs.push(dir);
  const lock = join(dir, "events.lock");
  const token = join(lock, `owner.${owner.pid}.0b5e55ed-0000-4000-8000-000000000103.json`);
  const bytes = JSON.stringify(owner);
  await mkdir(lock);
  await writeFile(token, bytes);
  return { lock, token, bytes };
}

describe("cross-host shared-volume locks fail closed", () => {
  it.each([
    ["a pid that is dead here", DEAD_PID],
    ["a pid that happens to be alive here", process.pid],
  ])("never breaks another host's lock with %s, even an ancient one", async (_name, pid) => {
    const { lock, token, bytes } = await lockWithToken({ pid, at: 0, host: OTHER_HOST });
    const onBroken = vi.fn();
    const entered = vi.fn();
    await expect(
      withFileLock(lock, async () => entered(), { staleMs: 1, timeoutMs: 50, onBroken }),
    ).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT", details: { path: lock, timeoutMs: 50 } });
    expect(entered).not.toHaveBeenCalled();
    expect(onBroken).not.toHaveBeenCalled();
    expect(await readdir(lock)).toEqual([token.slice(lock.length + 1)]);
    expect(await readFile(token, "utf8")).toBe(bytes);
  });

  it("never breaks a lock whose token names no host", async () => {
    const { lock, token, bytes } = await lockWithToken({ pid: DEAD_PID, at: 0 });
    await expect(withFileLock(lock, async () => undefined, { timeoutMs: 0 })).rejects.toMatchObject({
      code: "STORE_LOCK_TIMEOUT",
    });
    expect(await readFile(token, "utf8")).toBe(bytes);
  });

  it("a holder on one host shuts out a writer on another until it releases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-lock-cross-host-"));
    dirs.push(dir);
    const lock = join(dir, "events.lock");
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const holding = new Promise<void>((r) => (entered = r));

    // Host B takes the lock through the real protocol and holds it.
    vi.mocked(hostname).mockReturnValue("host-b");
    const holder = withFileLock(lock, async () => {
      entered();
      await released;
    });
    const wrote = vi.fn();
    try {
      await holding;
      const [name] = await readdir(lock);
      expect(JSON.parse(await readFile(join(lock, name!), "utf8"))).toMatchObject({ host: "host-b" });

      // Host A sees a token recording a different hostname and refuses to judge it.
      vi.mocked(hostname).mockReturnValue("host-a");
      await expect(withFileLock(lock, async () => wrote(), { staleMs: 1, timeoutMs: 50 })).rejects.toMatchObject({
        code: "STORE_LOCK_TIMEOUT",
      });
      expect(wrote).not.toHaveBeenCalled();
      expect(await readdir(lock)).toEqual([name]);
    } finally {
      // Always let host B finish, so a failed assertion cannot strand the holder.
      vi.mocked(hostname).mockReturnValue("host-b");
      release();
      await holder;
    }
    vi.mocked(hostname).mockReturnValue("host-a");
    await withFileLock(lock, async () => wrote());
    expect(wrote).toHaveBeenCalledOnce();
  });

  it("recovers only once an operator removes the abandoned lock by hand", async () => {
    const { lock } = await lockWithToken({ pid: DEAD_PID, at: 0, host: OTHER_HOST });
    await expect(withFileLock(lock, async () => undefined, { timeoutMs: 0 })).rejects.toMatchObject({
      code: "STORE_LOCK_TIMEOUT",
    });
    await rm(lock, { recursive: true });
    await expect(withFileLock(lock, async () => "written", { timeoutMs: 0 })).resolves.toBe("written");
  });

  it("still recovers a dead owner recorded by this host (the contrast case)", async () => {
    const { lock } = await lockWithToken({ pid: DEAD_PID, at: 0, host: hostname() });
    const onBroken = vi.fn();
    await expect(withFileLock(lock, async () => "written", { timeoutMs: 0, onBroken })).resolves.toBe("written");
    expect(onBroken).toHaveBeenCalledWith({ pid: DEAD_PID, at: 0 });
  });
});
