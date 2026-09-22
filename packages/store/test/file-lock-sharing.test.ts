/** Windows delete-pending sharing failures remain an unknown/live lock, never a stale owner. */
import { mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { breakIfStale, withFileLock } from "../src/file-lock.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), mkdir: vi.fn(actual.mkdir) };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const dirs: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.mocked(open).mockClear();
  vi.mocked(mkdir).mockClear();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("Windows lock sharing windows", () => {
  it.each(["EPERM", "EACCES"])("retries %s under the bounded lock wait without removing the holder", async (code) => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const dir = await mkdtemp(join(tmpdir(), "orca-lock-sharing-"));
    dirs.push(dir);
    const path = join(dir, "mutation.lock");
    const contents = JSON.stringify({ pid: process.pid, at: Date.now() });
    await writeFile(path, contents);
    vi.mocked(mkdir).mockRejectedValueOnce(Object.assign(new Error("delete pending"), { code }));
    let wrote = false;
    await expect(
      withFileLock(
        path,
        async () => {
          wrote = true;
        },
        { timeoutMs: 0 },
      ),
    ).rejects.toMatchObject({ code: "STORE_LOCK_TIMEOUT" });
    expect(wrote).toBe(false);
    expect(await readFile(path, "utf8")).toBe(contents);
    // Once the actual holder releases, the same caller may proceed normally.
    await unlink(path);
    await withFileLock(path, async () => {
      wrote = true;
    });
    expect(wrote).toBe(true);
  });

  it("does not hide permission errors on other platforms", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EPERM" }));
    await expect(breakIfStale("unused", () => true)).rejects.toMatchObject({ code: "EPERM" });
  });
});
