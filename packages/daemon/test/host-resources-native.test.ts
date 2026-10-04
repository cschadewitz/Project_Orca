/** Worker isolation and synchronous native-source fixtures; no actual host telemetry is read. */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_RESOURCE_LIMITS } from "@orca/protocol";
import {
  createNativeResourceIo,
  type NativeIoRequest,
  type NativeIoResponse,
} from "../src/host-resources/native-io.js";
import { executeNativeRequest } from "../src/host-resources/native-io-worker.js";
import { failureReason, nodeHostResourceSources } from "../src/host-resources/sources.js";
const sync = vi.hoisted(() => ({
  openSync: vi.fn(),
  closeSync: vi.fn(),
  readSync: vi.fn(),
  statSync: vi.fn(),
  statfsSync: vi.fn(),
}));
vi.mock("node:fs", () => sync);
// Any accidental main-thread promise-fs dependency fails this entire test module.
vi.mock("node:fs/promises", () => {
  throw new Error("host collector must not import shared-pool filesystem APIs");
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
class FakeWorker extends EventEmitter {
  requests: NativeIoRequest[] = [];
  postMessage = vi.fn((request: NativeIoRequest) => {
    this.requests.push(request);
  });
  unref = vi.fn(() => {});
  terminate = vi.fn(async () => 0);
  reply(response: NativeIoResponse) {
    this.emit("message", response);
  }
}
describe("isolated native worker client", () => {
  it("creates one worker lazily and performs no synchronous or shared-pool native I/O on the main thread", async () => {
    const worker = new FakeWorker(),
      factory = vi.fn(() => worker);
    const io = createNativeResourceIo([], factory);
    expect(factory).not.toHaveBeenCalled();
    const result = io.read("/proc/stat");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(worker.unref).toHaveBeenCalledTimes(1);
    for (const method of Object.values(sync)) expect(method).not.toHaveBeenCalled();
    worker.reply({ id: 1, ok: true, value: Buffer.from("fixed fixture") });
    expect((await result).toString()).toBe("fixed fixture");
    io.close();
  });
  it("retains four hung requests after caller timeout and never replaces the worker", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker(),
      factory = vi.fn(() => worker);
    const io = createNativeResourceIo([], factory);
    const pending = Array.from({ length: 4 }, () => io.read("/proc/stat").catch(() => undefined));
    const timeout = Promise.race([pending[0], new Promise((resolve) => setTimeout(() => resolve("timeout"), 250))]);
    await vi.advanceTimersByTimeAsync(250);
    expect(await timeout).toBe("timeout");
    await expect(io.read("/proc/stat")).rejects.toMatchObject({ code: "BUSY" });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(io.read("/proc/stat")).rejects.toMatchObject({ code: "BUSY" });
    expect(worker.requests).toHaveLength(4);
    expect(factory).toHaveBeenCalledTimes(1);
    worker.reply({ id: 1, ok: true, value: Buffer.from("settled") });
    await pending[0];
    const next = io.read("/proc/stat").catch(() => undefined);
    expect(worker.requests).toHaveLength(5);
    io.close();
    await Promise.all([...pending, next]);
  });
  it("rejects oversized byte replies before copying them on the main thread", async () => {
    const worker = new FakeWorker(),
      io = createNativeResourceIo([], () => worker);
    const pending = io.read("/proc/stat");
    worker.reply({ id: 1, ok: true, value: new Uint8Array(HOST_RESOURCE_LIMITS.sourceBytes + 1) });
    await expect(pending).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    io.close();
  });
  it("fails permanently and strips raw worker failure details", async () => {
    const worker = new FakeWorker(),
      factory = vi.fn(() => worker),
      io = createNativeResourceIo([], factory);
    const pending = io.read("/proc/stat");
    worker.emit("error", new Error("credential /secret/private"));
    await expect(pending).rejects.toMatchObject({ message: "host resource source unavailable", code: "SOURCE_FAILED" });
    await expect(io.read("/proc/stat")).rejects.toMatchObject({ code: "SOURCE_FAILED" });
    expect(factory).toHaveBeenCalledTimes(1);
    io.close();
  });
  it("preserves only allowlisted errno semantics across the worker boundary", async () => {
    const worker = new FakeWorker(),
      io = createNativeResourceIo([], () => worker);
    const pending = io.read("/sys/fs/cgroup/cpu.max");
    worker.reply({ id: 1, ok: false, code: "ENOENT" });
    await expect(pending).rejects.toMatchObject({ code: "ENOENT" });
    const denied = io.read("/proc/stat").catch((error) => failureReason(error));
    worker.reply({ id: 2, ok: false, code: "EACCES" });
    expect(await denied).toBe("permission-denied");
    io.close();
  });
  it("rejects oversized bootstrap/request paths before creating a worker", async () => {
    const factory = vi.fn(() => new FakeWorker());
    expect(() => createNativeResourceIo(["x".repeat(4097)], factory)).toThrow();
    const io = createNativeResourceIo([], factory);
    await expect(io.read("x".repeat(4097))).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(factory).not.toHaveBeenCalled();
    io.close();
  });
});
describe("synchronous worker adapters with mocked files", () => {
  function fakeFile(bytes: Buffer) {
    let cursor = 0;
    sync.openSync.mockReturnValue(11);
    sync.readSync.mockImplementation((_fd: number, buffer: Buffer, offset: number, length: number) => {
      const count = Math.min(length, bytes.length - cursor);
      bytes.copy(buffer, offset, cursor, cursor + count);
      cursor += count;
      return count;
    });
  }
  const execute = (operation: NativeIoRequest["operation"], path: string, paths: string[] = []) =>
    executeNativeRequest({ id: 1, operation, path }, paths, HOST_RESOURCE_LIMITS.sourceBytes);
  it("reads no more than sourceBytes+1 and closes oversized sources", () => {
    fakeFile(Buffer.alloc(HOST_RESOURCE_LIMITS.sourceBytes + 100, 65));
    expect(execute("read", "/proc/stat")).toEqual({ id: 1, ok: false, code: "INVALID_SOURCE" });
    expect(sync.readSync).toHaveBeenCalledTimes(1);
    expect(sync.readSync.mock.calls[0]![3]).toBe(HOST_RESOURCE_LIMITS.sourceBytes + 1);
    expect(sync.closeSync).toHaveBeenCalledWith(11);
  });
  it("rejects non-fixed reads, traversal and unconfigured storage without native calls", () => {
    for (const path of ["/etc/passwd", "/sys/fs/cgroup/../secret/cpu.max", "/sys/fs/cgroup/a/procs"])
      expect(execute("read", path)).toMatchObject({ ok: false, code: "INVALID_SOURCE" });
    expect(execute("storage", "/arbitrary")).toMatchObject({ ok: false, code: "INVALID_SOURCE" });
    expect(sync.openSync).not.toHaveBeenCalled();
    expect(sync.statfsSync).not.toHaveBeenCalled();
  });
  it("uses bavail and recognizes tmpfs while keeping virtual/unknown backing explicit", () => {
    sync.statfsSync.mockReturnValue({ blocks: 100n, bsize: 4096n, bavail: 10n, bfree: 20n, type: 0x794c7630n });
    sync.statSync.mockReturnValue({ dev: 42n });
    expect(execute("storage", "/bootstrap", ["/bootstrap"])).toMatchObject({
      ok: true,
      value: { totalBytes: 409600, availableBytes: 40960, device: "42", backing: "unknown" },
    });
    sync.statfsSync.mockReturnValue({ blocks: 100n, bsize: 4096n, bavail: 10n, type: 0x01021994n });
    expect(execute("storage", "/bootstrap", ["/bootstrap"])).toMatchObject({ value: { backing: "tmpfs" } });
  });
  it("sanitizes raw synchronous I/O exceptions", () => {
    sync.openSync.mockImplementation(() => {
      throw Object.assign(new Error("secret/private/key"), { code: "EACCES" });
    });
    expect(execute("read", "/proc/stat")).toEqual({ id: 1, ok: false, code: "EACCES" });
  });
  it("gets AT_PAGESZ through the injected byte port without native reads on the main thread", async () => {
    const word = ["ia32", "arm"].includes(process.arch) ? 4 : 8,
      bytes = Buffer.alloc(word * 4);
    const { endianness } = await import("node:os");
    if (word === 8) {
      if (endianness() === "LE") {
        bytes.writeBigUInt64LE(6n, 0);
        bytes.writeBigUInt64LE(8192n, word);
      } else {
        bytes.writeBigUInt64BE(6n, 0);
        bytes.writeBigUInt64BE(8192n, word);
      }
    } else if (endianness() === "LE") {
      bytes.writeUInt32LE(6, 0);
      bytes.writeUInt32LE(8192, word);
    } else {
      bytes.writeUInt32BE(6, 0);
      bytes.writeUInt32BE(8192, word);
    }
    const read = vi.fn(async () => bytes);
    const sources = nodeHostResourceSources({ io: { read, storage: vi.fn(), close: vi.fn() } });
    expect(await sources.pageSize()).toBe(8192);
    expect(read).toHaveBeenCalledWith("/proc/self/auxv");
    for (const method of Object.values(sync)) expect(method).not.toHaveBeenCalled();
  });
});
