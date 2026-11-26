/**
 * #1197: a lock left by a power loss. Every process of an earlier boot is gone, so its lock is
 * cleared even when its pid is reused after the reboot, its token was torn (zero bytes), or the
 * holder crashed before it published one. A lock from this boot keeps failing closed.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { livenessDomain, withFileLock } from "../src/file-lock.js";

const OTHER_BOOT = "linux:00000000-0000-4000-8000-000000001197:pid:[4026531836]";
const LONG_AGO = new Date("2020-01-01T00:00:00Z");
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function lockDir() {
  const dir = await mkdtemp(join(tmpdir(), "orca-lock-reboot-"));
  dirs.push(dir);
  const lock = join(dir, "catalog.lock");
  await mkdir(lock);
  return lock;
}
/** A token naming this test process: a pid that is alive here, as a reused pid is after a reboot. */
async function leftBy(holder: Record<string, unknown>, bytes = JSON.stringify(holder)) {
  const lock = await lockDir();
  const token = join(lock, `owner.${process.pid}.0b5e55ed-0000-4000-8000-000000001197.json`);
  await writeFile(token, bytes);
  return { lock, token };
}
const takes = (lock: string, recovery?: "provable") =>
  withFileLock(lock, async () => "written", { timeoutMs: 30, ...(recovery ? { recovery } : {}) });
const refused = { code: "STORE_LOCK_TIMEOUT" };

describe("a lock left by a power loss", () => {
  it.runIf(livenessDomain() !== null)("clears a token from another boot whose pid is alive again", async () => {
    const { lock } = await leftBy({ pid: process.pid, at: Date.now(), host: hostname(), domain: OTHER_BOOT });
    await expect(takes(lock)).resolves.toBe("written");
    await expect(readdir(join(lock, ".."))).resolves.toEqual([]);
  });

  it.runIf(livenessDomain() !== null)("keeps a live holder of this boot", async () => {
    const { lock } = await leftBy({ pid: process.pid, at: 0, host: hostname(), domain: livenessDomain() });
    await expect(takes(lock)).rejects.toMatchObject(refused);
  });

  it("clears a live-looking pid whose token predates this boot and names no domain", async () => {
    const { lock } = await leftBy({ pid: process.pid, at: LONG_AGO.getTime(), host: hostname() });
    await expect(takes(lock)).resolves.toBe("written");
  });

  it("keeps a live pid that took the lock during this boot", async () => {
    const { lock } = await leftBy({ pid: process.pid, at: Date.now(), host: hostname() });
    await expect(takes(lock)).rejects.toMatchObject(refused);
  });

  it("never clears another host's token, even from long before this boot", async () => {
    const { lock } = await leftBy({
      pid: process.pid,
      at: 0,
      host: "orca-test-other-host.invalid",
      domain: OTHER_BOOT,
    });
    await expect(takes(lock)).rejects.toMatchObject(refused);
  });

  it("clears a torn (zero-byte) token from before this boot, and keeps a fresh one", async () => {
    const old = await leftBy({}, "");
    await utimes(old.token, LONG_AGO, LONG_AGO);
    await expect(takes(old.lock)).resolves.toBe("written");
    const fresh = await leftBy({}, "");
    await expect(takes(fresh.lock)).rejects.toMatchObject(refused);
  });

  it("clears an empty lock directory from before this boot, and keeps a fresh one", async () => {
    const old = await lockDir();
    await utimes(old, LONG_AGO, LONG_AGO);
    await expect(takes(old)).resolves.toBe("written");
    await expect(takes(await lockDir())).rejects.toMatchObject(refused);
  });

  it("leaves all of these to a person under provable recovery", async () => {
    const reused = await leftBy({ pid: process.pid, at: 0, host: hostname(), domain: OTHER_BOOT });
    await expect(takes(reused.lock, "provable")).rejects.toMatchObject(refused);
    const torn = await leftBy({}, "");
    await utimes(torn.token, LONG_AGO, LONG_AGO);
    await expect(takes(torn.lock, "provable")).rejects.toMatchObject(refused);
    const empty = await lockDir();
    await utimes(empty, LONG_AGO, LONG_AGO);
    await expect(takes(empty, "provable")).rejects.toMatchObject(refused);
  });
});
