/** Native synchronization preserves the existing journal and releases real host handles and locks. */
import { mkdtemp, open, readdir, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
