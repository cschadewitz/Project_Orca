/** The local I/O of ORCA's own file executor is bound to the file it was authorized for (#703 review). */
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { bindOwnedFs, isHostFileMissing, OwnedFsNotDispatched, readBound, stillBound, writeBound } from "@orca/agents";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function dir(): Promise<string> {
  const d = realpathSync(await mkdtemp(join(tmpdir(), "orca-owned-io-")));
  dirs.push(d);
  return d;
}

describe("bound I/O", () => {
  it("binds an existing file by its own identity and a new one by its nearest existing directory", async () => {
    const d = await dir();
    await writeFile(join(d, "a"), "a");
    expect(bindOwnedFs(join(d, "a"))).toMatchObject({ exists: true, anchor: join(d, "a") });
    expect(bindOwnedFs(join(d, "x", "y", "new"))).toMatchObject({ exists: false, anchor: d });
  });

  it("reads and writes the bound file", async () => {
    const d = await dir();
    const a = join(d, "a");
    await writeFile(a, "before, and longer");
    const binding = bindOwnedFs(a)!;
    expect(await readBound(binding)).toBe("before, and longer");
    await writeBound(binding, "after");
    expect(await readFile(a, "utf8")).toBe("after");
  });

  it("refuses, before any byte, a file replaced under the same name", async () => {
    const d = await dir();
    const a = join(d, "a");
    await writeFile(a, "original");
    const binding = bindOwnedFs(a)!;
    await writeFile(join(d, "b"), "replacement");
    await rename(join(d, "b"), a);
    expect(stillBound(a, binding)).toBe(false);
    await expect(readBound(binding)).rejects.toBeInstanceOf(OwnedFsNotDispatched);
    await expect(writeBound(binding, "x")).rejects.toBeInstanceOf(OwnedFsNotDispatched);
    expect(await readFile(a, "utf8")).toBe("replacement");
  });

  it("refuses a file that became a link", async () => {
    const d = await dir();
    const a = join(d, "a");
    await writeFile(a, "original");
    await writeFile(join(d, "other"), "other");
    const binding = bindOwnedFs(a)!;
    await rm(a);
    await symlink(join(d, "other"), a);
    await expect(writeBound(binding, "x")).rejects.toBeInstanceOf(OwnedFsNotDispatched);
    expect(await readFile(join(d, "other"), "utf8")).toBe("other");
  });

  it("creates a new file exclusively: one that appeared meanwhile is not overwritten", async () => {
    const d = await dir();
    const n = join(d, "new");
    const binding = bindOwnedFs(n)!;
    await writeFile(n, "someone else's");
    expect(stillBound(n, binding)).toBe(false);
    await expect(writeBound(binding, "x")).rejects.toBeInstanceOf(OwnedFsNotDispatched);
    expect(await readFile(n, "utf8")).toBe("someone else's");
  });

  it("marks a file still missing as missing, so the agent hears Resource not found", async () => {
    const d = await dir();
    const error = await readBound(bindOwnedFs(join(d, "gone"))!).catch((e: unknown) => e);
    expect(isHostFileMissing(error)).toBe(true);
  });
});
