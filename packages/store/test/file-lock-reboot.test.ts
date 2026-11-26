/**
 * #1197: a lock left by a power loss. Every process of an earlier boot is gone, so its lock is
 * cleared, even when its pid is reused after the reboot or its token was torn (zero bytes), but
 * only on positive boot identity: the kernel boot id recorded in the token or in its name. A
 * wall clock proves nothing (Cal's review: a clock corrected forward moves the computed boot
 * time past a live holder), so without boot ids the lock fails closed as before.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { livenessDomain, withFileLock } from "../src/file-lock.js";

const OTHER_BOOT_ID = "00000000-0000-4000-8000-000000001197";
const OTHER_BOOT = `linux:${OTHER_BOOT_ID}:pid:[4026531836]`;
const THIS_BOOT_ID = /^linux:([0-9a-f-]{36}):/i.exec(livenessDomain() ?? "")?.[1]?.toLowerCase();
const hex = (id: string) => id.replace(/-/g, "");
const LONG_AGO = new Date("2020-01-01T00:00:00Z");
const linux = livenessDomain() !== null;
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
async function leftBy(holder: Record<string, unknown>, bytes = JSON.stringify(holder), boot?: string) {
  const lock = await lockDir();
  const token = join(
    lock,
    `owner.${process.pid}.${boot ? `${hex(boot)}-` : ""}0b5e55ed-0000-4000-8000-000000001197.json`,
  );
  await writeFile(token, bytes);
  return { lock, token };
}
const takes = (lock: string, recovery?: "provable") =>
  withFileLock(lock, async () => "written", { timeoutMs: 30, ...(recovery ? { recovery } : {}) });
const refused = { code: "STORE_LOCK_TIMEOUT" };

describe("a lock left by a power loss", () => {
  it.runIf(linux)("clears a token from another boot whose pid is alive again", async () => {
    const { lock } = await leftBy({ pid: process.pid, at: Date.now(), host: hostname(), domain: OTHER_BOOT });
    await expect(takes(lock)).resolves.toBe("written");
    await expect(readdir(join(lock, ".."))).resolves.toEqual([]);
  });

  it.runIf(linux)("keeps a live holder of this boot, however old its timestamps", async () => {
    const { lock, token } = await leftBy({ pid: process.pid, at: 0, host: hostname(), domain: livenessDomain() });
    await utimes(token, LONG_AGO, LONG_AGO);
    await utimes(lock, LONG_AGO, LONG_AGO);
    await expect(takes(lock)).rejects.toMatchObject(refused);
  });

  it("keeps a live holder after the wall clock is corrected forward, with or without a domain", async () => {
    // Taken now; then the clock jumps a year ahead, so "now - uptime" is long after `at`.
    const plain = await leftBy({ pid: process.pid, at: Date.now(), host: hostname() });
    const domained = await leftBy({ pid: process.pid, at: Date.now(), host: hostname(), domain: livenessDomain() });
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 365 * 24 * 3600_000);
    await expect(takes(plain.lock)).rejects.toMatchObject(refused);
    await expect(takes(domained.lock)).rejects.toMatchObject(refused);
    expect(await readFile(plain.token, "utf8")).toContain(`"pid":${process.pid}`);
  });

  it("never clears another host's token, even from another boot", async () => {
    const { lock } = await leftBy({
      pid: process.pid,
      at: 0,
      host: "orca-test-other-host.invalid",
      domain: OTHER_BOOT,
    });
    await expect(takes(lock)).rejects.toMatchObject(refused);
  });

  it.runIf(linux)("clears a torn token whose name records another boot", async () => {
    const { lock } = await leftBy({}, "", OTHER_BOOT_ID);
    await expect(takes(lock)).resolves.toBe("written");
  });

  it("keeps a torn token whose name records this boot or no boot, however old its mtime", async () => {
    for (const boot of [THIS_BOOT_ID, undefined]) {
      const torn = await leftBy({}, "", boot);
      await utimes(torn.token, LONG_AGO, LONG_AGO);
      await expect(takes(torn.lock)).rejects.toMatchObject(refused);
    }
  });

  it("keeps an empty lock directory, however old: nothing in it proves a boot", async () => {
    const empty = await lockDir();
    await utimes(empty, LONG_AGO, LONG_AGO);
    await expect(takes(empty)).rejects.toMatchObject(refused);
  });

  it.runIf(linux)("names this boot in every new token", async () => {
    const lock = join(await mkdtemp(join(tmpdir(), "orca-lock-reboot-")), "x.lock");
    dirs.push(join(lock, ".."));
    await withFileLock(lock, async () => {
      expect(await readdir(lock)).toEqual([
        expect.stringMatching(new RegExp(`^owner\\.${process.pid}\\.${hex(THIS_BOOT_ID!)}-`)),
      ]);
    });
  });

  it("leaves all of these to a person under provable recovery", async () => {
    const reused = await leftBy({ pid: process.pid, at: 0, host: hostname(), domain: OTHER_BOOT });
    await expect(takes(reused.lock, "provable")).rejects.toMatchObject(refused);
    const torn = await leftBy({}, "", OTHER_BOOT_ID);
    await expect(takes(torn.lock, "provable")).rejects.toMatchObject(refused);
  });
});
