/**
 * #1284: on Windows a rename that loses a race with another open handle (a reader of the target,
 * an antivirus scan of the file just written) fails with EPERM, EACCES or EBUSY for a moment.
 * The store's write-then-rename publications try again for a bounded time there, and only there.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPLACE_RETRY_DELAYS_MS, replaceFile } from "../src/durable-file.js";

const sharing = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

/** A rename that fails with `codes` in turn, then succeeds; it records every attempt. */
function flaky(codes: string[]) {
  const attempts: [string, string][] = [];
  return {
    attempts,
    rename: async (from: string, to: string) => {
      attempts.push([from, to]);
      const code = codes.shift();
      if (code) throw sharing(code);
    },
  };
}

const quick = [0, 0, 0];

describe("replaceFile (#1284)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  it("on Windows, tries a rename again through EPERM, EACCES and EBUSY", async () => {
    const move = flaky(["EPERM", "EACCES", "EBUSY"]);
    await replaceFile("a.tmp", "a.json", { platform: "win32", rename: move.rename, delaysMs: quick });
    expect(move.attempts).toHaveLength(4);
  });

  it("gives up after its bounded attempts, with the last error", async () => {
    const move = flaky(["EPERM", "EPERM", "EPERM", "EPERM", "EPERM"]);
    await expect(
      replaceFile("a.tmp", "a.json", { platform: "win32", rename: move.rename, delaysMs: quick }),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(move.attempts).toHaveLength(quick.length + 1);
  });

  it("fails at once off Windows, and on any other error", async () => {
    const linux = flaky(["EPERM"]);
    await expect(
      replaceFile("a.tmp", "a.json", { platform: "linux", rename: linux.rename, delaysMs: quick }),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(linux.attempts).toHaveLength(1);

    const missing = flaky(["ENOENT"]);
    await expect(
      replaceFile("a.tmp", "a.json", { platform: "win32", rename: missing.rename, delaysMs: quick }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(missing.attempts).toHaveLength(1);
  });

  it("waits about a second and a half at most by default", () => {
    const total = REPLACE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThan(1_000);
    expect(total).toBeLessThan(2_000);
  });

  it("replaces the target with the real file system", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-replace-"));
    dirs.push(dir);
    await writeFile(join(dir, "a.json"), "old");
    await writeFile(join(dir, "a.tmp"), "new");
    await replaceFile(join(dir, "a.tmp"), join(dir, "a.json"));
    expect(await readFile(join(dir, "a.json"), "utf8")).toBe("new");
  });
});
