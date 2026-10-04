/** Platform-branch tests are simulated; the native case uses real host handles and sync. */
import { mkdtemp, open, readdir, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonlLogDir } from "../src/jsonl-log.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const dirs: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  vi.mocked(open).mockReset();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const marker = '{"seq":0,"correlation":"marker"}\n';
const matches = (raw: unknown) => (raw as { correlation?: string }).correlation === "marker";
async function fixture(contents = marker) {
  const dir = await mkdtemp(join(tmpdir(), "orca-journal-sync-"));
  dirs.push(dir);
  const file = join(dir, "run.jsonl");
  await writeFile(file, contents);
  return { dir, file, log: new JsonlLogDir(dir) };
}
async function snapshot(file: string) {
  const { dev, ino, size, mode, mtimeMs } = await stat(file);
  return { bytes: await readFile(file), dev, ino, size, mode, mtimeMs };
}
function trackHandles(file: string, simulated = false) {
  const handles: FileHandle[] = [];
  const syncs = vi.fn<() => Promise<void>>();
  const writes = vi.fn();
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    // Simulated non-Windows branches must not open or fsync directories on a Windows host.
    if (simulated && path !== file)
      return { sync: vi.fn(async () => undefined), close: vi.fn(async () => undefined) } as unknown as FileHandle;
    const handle = await actual.open(path, flags, mode);
    handles.push(handle);
    if (path === file) {
      if (simulated) vi.spyOn(handle, "sync").mockImplementation(syncs);
      else vi.spyOn(handle, "sync");
      for (const method of ["write", "writeFile", "truncate", "chmod", "chown"] as const)
        vi.spyOn(handle, method).mockImplementation(() => {
          writes(method);
          throw new Error("Synchronization must not mutate the journal");
        });
    }
    return handle;
  });
  syncs.mockResolvedValue(undefined);
  return { handles, syncs, writes };
}

it("natively synchronizes an existing marker without changing bytes, inode, mode or leaving handles or locks", async () => {
  const { dir, file, log } = await fixture();
  const before = await snapshot(file);
  const { handles, writes } = trackHandles(file);
  await log.synchronizeExisting("run", matches);
  expect(await snapshot(file)).toEqual(before);
  expect(open).toHaveBeenCalledWith(file, process.platform === "win32" ? "r+" : "r");
  expect(handles.length).toBeGreaterThan(0);
  expect(handles.every((handle) => handle.fd === -1)).toBe(true);
  expect(writes).not.toHaveBeenCalled();
  expect(await readdir(dir)).toEqual(["run.jsonl"]);
});

describe("simulated journal synchronization platform branches", () => {
  it.each([
    ["win32", "r+"],
    ["linux", "r"],
    ["darwin", "r"],
  ])("uses non-creating %s file mode %s without writing or changing directory sync", async (os, expectedMode) => {
    const { dir, file, log } = await fixture();
    Object.defineProperty(process, "platform", { ...platform, value: os });
    const before = await snapshot(file);
    const { handles, syncs, writes } = trackHandles(file, true);
    await log.synchronizeExisting("run", matches);
    expect(open).toHaveBeenCalledWith(file, expectedMode);
    expect(syncs).toHaveBeenCalledOnce();
    const directories: string[] = [];
    if (os !== "win32") {
      for (let path = dir; ; path = dirname(path)) {
        directories.push(path);
        if (dirname(path) === path) break;
      }
    }
    expect(vi.mocked(open).mock.calls).toEqual([[file, expectedMode], ...directories.map((path) => [path, "r"])]);
    for (const result of vi.mocked(open).mock.results.slice(1)) {
      const directory = (await result.value) as { sync: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
      expect(directory.sync).toHaveBeenCalledOnce();
      expect(directory.close).toHaveBeenCalledOnce();
    }
    expect(await snapshot(file)).toEqual(before);
    expect(handles[0]!.fd).toBe(-1);
    expect(writes).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(["run.jsonl"]);
  });

  it("does not create a missing Windows journal or initialize a missing directory", async () => {
    const { dir, file, log } = await fixture();
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await rm(file);
    await expect(log.synchronizeExisting("run", matches)).rejects.toMatchObject({ code: "ENOENT" });
    expect(open).toHaveBeenCalledExactlyOnceWith(file, "r+");
    expect(await readdir(dir)).toEqual([]);
    const missing = join(dir, "missing");
    await expect(new JsonlLogDir(missing).synchronizeExisting("run", matches)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    expect(open).toHaveBeenCalledOnce();
  });

  it.each([
    ["empty", ""],
    ["missing correlation", '{"seq":0,"correlation":"other"}\n'],
    ["incomplete final line", marker.trimEnd()],
    ["torn tail", marker + '{"seq":'],
    ["invalid complete record", marker + "not-json\n"],
    ["sequence gap", '{"seq":1,"correlation":"marker"}\n'],
    ["duplicate correlation", marker + '{"seq":1,"correlation":"marker"}\n'],
  ])("refuses %s without synchronizing, repairing or leaking the Windows handle", async (_label, contents) => {
    const { dir, file, log } = await fixture(contents);
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const before = await snapshot(file);
    const { handles, syncs, writes } = trackHandles(file, true);
    await expect(log.synchronizeExisting("run", matches)).rejects.toMatchObject({ code: "RUN_STATE" });
    expect(await snapshot(file)).toEqual(before);
    expect(syncs).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(handles[0]!.fd).toBe(-1);
    expect(await readdir(dir)).toEqual(["run.jsonl"]);
  });

  it("refuses Windows sync failure, closes the handle and lock, and retries without appending", async () => {
    const { dir, file, log } = await fixture();
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const before = await snapshot(file);
    const { handles, syncs, writes } = trackHandles(file, true);
    const failure = Object.assign(new Error("sync failed"), { code: "EIO" });
    syncs.mockRejectedValueOnce(failure);
    await expect(log.synchronizeExisting("run", matches)).rejects.toBe(failure);
    expect(handles[0]!.fd).toBe(-1);
    expect(await snapshot(file)).toEqual(before);
    expect(await readdir(dir)).toEqual(["run.jsonl"]);
    await log.synchronizeExisting("run", matches);
    expect(syncs).toHaveBeenCalledTimes(2);
    expect(handles).toHaveLength(2);
    expect(handles.every((handle) => handle.fd === -1)).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    expect(await snapshot(file)).toEqual(before);
    expect(await readdir(dir)).toEqual(["run.jsonl"]);
  });

  it("refuses Windows open failure without fallback or mutation and releases the lock", async () => {
    const { dir, file, log } = await fixture();
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const before = await snapshot(file);
    const failure = Object.assign(new Error("denied"), { code: "EACCES" });
    vi.mocked(open).mockRejectedValueOnce(failure);
    await expect(log.synchronizeExisting("run", matches)).rejects.toBe(failure);
    expect(open).toHaveBeenCalledExactlyOnceWith(file, "r+");
    expect(await snapshot(file)).toEqual(before);
    expect(await readdir(dir)).toEqual(["run.jsonl"]);
  });
});
