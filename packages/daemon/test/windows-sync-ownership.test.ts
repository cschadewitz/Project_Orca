/** Platform-branch tests are simulated; the native case uses the host's real fsync. */
import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnershipStore } from "../src/auth/ownership.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
  };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const dirs: string[] = [];
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.mocked(openSync).mockReset();
  vi.mocked(fsyncSync).mockReset();
  vi.mocked(closeSync).mockReset();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-owner-sync-"));
  dirs.push(dir);
  const file = join(dir, "ownership.json");
  return { dir, file, ownership: new OwnershipStore(file) };
}
function snapshot(file: string) {
  const { dev, ino, size, mode, mtimeMs } = statSync(file);
  return { bytes: readFileSync(file), dev, ino, size, mode, mtimeMs };
}
function trackOwnerOpen(file: string) {
  const observed: { fd: number; before: ReturnType<typeof snapshot> }[] = [];
  vi.mocked(openSync).mockImplementation((path, flags, mode) => {
    const before = path === file ? snapshot(file) : undefined;
    const fd = actual.openSync(path, flags, mode);
    if (before) observed.push({ fd, before });
    return fd;
  });
  return observed;
}

it("natively synchronizes ownership without changing the published bytes, inode or mode", async () => {
  const { dir, file, ownership } = await fixture();
  const observed = trackOwnerOpen(file);
  ownership.record("run", "alice");
  await ownership.flush("run");
  expect(ownership.lastError).toBeUndefined();
  expect(new OwnershipStore(file).owner("run")).toBe("alice");
  expect(observed).toHaveLength(1);
  expect(snapshot(file)).toEqual(observed[0]!.before);
  expect(fsyncSync).toHaveBeenCalledWith(observed[0]!.fd);
  expect(closeSync).toHaveBeenCalledWith(observed[0]!.fd);
  expect(() => fstatSync(observed[0]!.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  expect(await readdir(dir)).toEqual(["ownership.json"]);
});

describe("simulated ownership synchronization platform branches", () => {
  it.each([
    ["win32", "r+"],
    ["linux", "r"],
    ["darwin", "r"],
  ])("uses non-creating %s file mode %s and preserves platform directory handling", async (os, expectedMode) => {
    const { dir, file, ownership } = await fixture();
    Object.defineProperty(process, "platform", { ...platform, value: os });
    // Directory handles and fsync are simulated so this flag test is portable to Windows.
    const directoryFd = -42;
    vi.mocked(openSync).mockImplementation((path, flags, mode) =>
      path === dir ? directoryFd : actual.openSync(path, flags, mode),
    );
    vi.mocked(fsyncSync).mockImplementation(() => undefined);
    vi.mocked(closeSync).mockImplementation((fd) => {
      if (fd !== directoryFd) actual.closeSync(fd);
    });
    ownership.record("run", "alice");
    await ownership.flush("run");
    expect(openSync).toHaveBeenCalledWith(file, expectedMode);
    const fd = vi.mocked(openSync).mock.results[0]!.value as number;
    expect(fsyncSync).toHaveBeenCalledWith(fd);
    expect(closeSync).toHaveBeenCalledWith(fd);
    expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(openSync).toHaveBeenCalledTimes(os === "win32" ? 1 : 2);
    expect(fsyncSync).toHaveBeenCalledTimes(os === "win32" ? 1 : 2);
    if (os !== "win32") {
      expect(openSync).toHaveBeenCalledWith(dir, "r");
      expect(fsyncSync).toHaveBeenCalledWith(directoryFd);
      expect(closeSync).toHaveBeenCalledWith(directoryFd);
    }
    expect(await readdir(dir)).toEqual(["ownership.json"]);
  });

  it("does not recreate ownership if it disappears before the Windows synchronization open", async () => {
    const { dir, file, ownership } = await fixture();
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      if (path === file) unlinkSync(file);
      return actual.openSync(path, flags, mode);
    });
    ownership.record("run", "alice");
    await expect(ownership.flush("run")).rejects.toMatchObject({ code: "STORE_WRITE" });
    expect(ownership.lastError).toMatchObject({ code: "ENOENT" });
    expect(openSync).toHaveBeenCalledExactlyOnceWith(file, "r+");
    expect(fsyncSync).not.toHaveBeenCalled();
    expect(closeSync).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses an open failure without retrying with a creating mode or changing published bytes", async () => {
    const { dir, file, ownership } = await fixture();
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const failure = Object.assign(new Error("denied"), { code: "EACCES" });
    let before: ReturnType<typeof snapshot> | undefined;
    vi.mocked(openSync).mockImplementation(() => {
      before = snapshot(file);
      throw failure;
    });
    ownership.record("run", "alice");
    await expect(ownership.flush("run")).rejects.toMatchObject({ code: "STORE_WRITE" });
    expect(ownership.lastError).toBe(failure);
    expect(openSync).toHaveBeenCalledExactlyOnceWith(file, "r+");
    expect(snapshot(file)).toEqual(before);
    expect(fsyncSync).not.toHaveBeenCalled();
    expect(closeSync).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual(["ownership.json"]);
  });

  it("keeps failed synchronization refused until explicit retry and closes the handle and lock", async () => {
    const { dir, file, ownership } = await fixture();
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const observed = trackOwnerOpen(file);
    const failure = Object.assign(new Error("sync failed"), { code: "EIO" });
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw failure;
    });
    ownership.record("run", "alice");
    await expect(ownership.flush("run")).rejects.toMatchObject({ code: "STORE_WRITE" });
    expect(ownership.lastError).toBe(failure);
    await expect(ownership.flush("run")).rejects.toMatchObject({ code: "STORE_WRITE" });
    expect(snapshot(file)).toEqual(observed[0]!.before);
    expect(closeSync).toHaveBeenCalledExactlyOnceWith(observed[0]!.fd);
    expect(() => fstatSync(observed[0]!.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(await readdir(dir)).toEqual(["ownership.json"]);
    ownership.record("run", "alice");
    await ownership.flush("run");
    expect(ownership.lastError).toBeUndefined();
    expect(observed).toHaveLength(2);
    expect(fsyncSync).toHaveBeenCalledTimes(2);
    expect(snapshot(file)).toEqual(observed[1]!.before);
    expect(await readdir(dir)).toEqual(["ownership.json"]);
  });
});

describe("existing ownership verification", () => {
  it.each([
    ["win32", "r+"],
    ["linux", "r"],
    ["darwin", "r"],
  ])("verifies %s through %s without allocating or replacing ownership", async (os, expectedMode) => {
    const { dir, file, ownership } = await fixture();
    ownership.record("run", "alice");
    await ownership.flush("run");
    const before = snapshot(file);
    Object.defineProperty(process, "platform", { ...platform, value: os });
    const directoryFd = -42;
    vi.mocked(openSync)
      .mockClear()
      .mockImplementation((path, flags, mode) => (path === dir ? directoryFd : actual.openSync(path, flags, mode)));
    vi.mocked(fsyncSync)
      .mockClear()
      .mockImplementation(() => undefined);
    vi.mocked(closeSync)
      .mockClear()
      .mockImplementation((fd) => {
        if (fd !== directoryFd) actual.closeSync(fd);
      });
    await ownership.verify("run", "alice");
    expect(openSync).toHaveBeenCalledWith(file, expectedMode);
    expect(openSync).toHaveBeenCalledTimes(os === "win32" ? 1 : 2);
    expect(fsyncSync).toHaveBeenCalledTimes(os === "win32" ? 1 : 2);
    expect(snapshot(file)).toEqual(before);
    expect(await readdir(dir)).toEqual(["ownership.json"]);
  });
  it("refuses failed verification sync without replacing or repairing ownership", async () => {
    const { dir, file, ownership } = await fixture();
    ownership.record("run", "alice");
    await ownership.flush("run");
    const before = snapshot(file);
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    vi.mocked(openSync).mockClear();
    vi.mocked(closeSync).mockClear();
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw new Error("sync failed");
    });
    await expect(ownership.verify("run", "alice")).rejects.toMatchObject({ code: "STORE_WRITE" });
    expect(openSync).toHaveBeenCalledExactlyOnceWith(file, "r+");
    expect(closeSync).toHaveBeenCalledTimes(1);
    expect(snapshot(file)).toEqual(before);
    expect(await readdir(dir)).toEqual(["ownership.json"]);
  });
});
