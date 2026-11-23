/** The local I/O of ORCA's own file executor is bound to the file it was authorized for (#703 review). */
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindOwnedFs,
  isHostFileMissing,
  OwnedFsNotDispatched,
  readBound,
  stillBound,
  writeAll,
  writeBound,
} from "@orca/agents";

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

  it("makes no directory for a new file when the directory it goes under was replaced", async () => {
    const d = await dir();
    const under = join(d, "under");
    await mkdir(under);
    const binding = bindOwnedFs(join(under, "x", "y", "new"))!;
    await rename(under, join(d, "moved"));
    await mkdir(under);
    await expect(writeBound(binding, "new")).rejects.toBeInstanceOf(OwnedFsNotDispatched);
    expect(existsSync(join(under, "x"))).toBe(false);
    expect(existsSync(join(d, "moved", "x"))).toBe(false);
  });

  it("makes no directory for a new file when the directory it goes under became a link", async () => {
    const d = await dir();
    const under = join(d, "under");
    const elsewhere = join(d, "elsewhere");
    await mkdir(under);
    await mkdir(elsewhere);
    const binding = bindOwnedFs(join(under, "x", "new"))!;
    await rm(under, { recursive: true });
    await symlink(elsewhere, under);
    await expect(writeBound(binding, "new")).rejects.toBeInstanceOf(OwnedFsNotDispatched);
    expect(existsSync(join(elsewhere, "x"))).toBe(false);
  });

  it("refuses, as not dispatched, a directory that appeared before any was made", async () => {
    const d = await dir();
    const binding = bindOwnedFs(join(d, "x", "new"))!;
    await mkdir(join(d, "x"));
    await expect(writeBound(binding, "new")).rejects.toBeInstanceOf(OwnedFsNotDispatched);
    expect(existsSync(join(d, "x", "new"))).toBe(false);
  });

  it("continues a short write until all of the content is written", async () => {
    const written: Buffer[] = [];
    const handle = {
      write: (bytes: Buffer, offset: number, length: number) => {
        const n = Math.min(3, length);
        written.push(Buffer.from(bytes.subarray(offset, offset + n)));
        return Promise.resolve({ bytesWritten: n, buffer: bytes });
      },
    };
    await writeAll(handle as never, "hello, world");
    expect(Buffer.concat(written).toString("utf8")).toBe("hello, world");
  });

  it("does not take a write that stopped as done", async () => {
    const handle = { write: (bytes: Buffer) => Promise.resolve({ bytesWritten: 0, buffer: bytes }) };
    await expect(writeAll(handle as never, "x")).rejects.toThrow(/stopped before all of the content/);
  });

  it("binds only an ordinary file: a directory or a FIFO is never opened", async () => {
    const d = await dir();
    expect(bindOwnedFs(d)).toBeUndefined();
    if (process.platform === "win32") return;
    const fifo = join(d, "fifo");
    execFileSync("mkfifo", [fifo]);
    expect(bindOwnedFs(fifo)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "refuses, without waiting on it, a FIFO put in place of the file",
    async () => {
      const d = await dir();
      const a = join(d, "a");
      await writeFile(a, "original");
      const binding = bindOwnedFs(a)!;
      await rm(a);
      execFileSync("mkfifo", [a]);
      await expect(readBound(binding)).rejects.toBeInstanceOf(OwnedFsNotDispatched);
      await expect(writeBound(binding, "x")).rejects.toBeInstanceOf(OwnedFsNotDispatched);
    },
  );

  it("refuses a file that appeared where a missing one was authorized to be read", async () => {
    const d = await dir();
    const binding = bindOwnedFs(join(d, "later"))!;
    await writeFile(join(d, "later"), "someone else's");
    await expect(readBound(binding)).rejects.toBeInstanceOf(OwnedFsNotDispatched);
  });
});

describe("new files where creation cannot be bound to the directory", () => {
  it("refuses to create one, and makes nothing", async () => {
    const d = await dir();
    const file = join(d, "x", "new");
    const binding = bindOwnedFs(file)!;
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      await expect(writeBound(binding, "new")).rejects.toBeInstanceOf(OwnedFsNotDispatched);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(existsSync(join(d, "x"))).toBe(false);
  });
});
