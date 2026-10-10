/** Exercise actual acquisition logic with synthetic descriptors/children; no host reads or commands. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { constants } from "node:fs";
import { open, statfs } from "node:fs/promises";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Acquisition, linuxObserverIO } from "../src/observer-io.js";
import { LIMITS } from "../src/policy.js";

vi.mock("node:fs/promises", () => ({ open: vi.fn(), statfs: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const boot = "aaaaaaaabbbb4ccc8dddeeeeeeeeeeee";
const budget = () => ({
  signal: new AbortController().signal,
  maxBytes: LIMITS.sourceBytes,
  maxRecords: LIMITS.sourceRecords,
  deadlineMs: LIMITS.deadlineMs,
});
const secret = "FAKE_SECRET /home/owner/.ssh/id_rsa";
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalUid = Object.getOwnPropertyDescriptor(process, "getuid");

function descriptor(value: string, properties: { regular?: boolean; uid?: number } = {}) {
  const bytes = Buffer.from(value);
  let position = 0;
  const file = {
    stat: vi.fn(async () => ({ isFile: () => properties.regular ?? true, uid: properties.uid ?? 0 })),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      const count = Math.min(length, bytes.length - position, 7);
      bytes.copy(buffer, offset, position, position + count);
      position += count;
      return { bytesRead: count };
    }),
    close: vi.fn(async () => {}),
  };
  vi.mocked(open).mockResolvedValue(file as unknown as Awaited<ReturnType<typeof open>>);
  return file;
}
function queryChild() {
  const events = new EventEmitter();
  const child = Object.assign(events, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}
beforeEach(() => {
  vi.resetAllMocks();
  // Synthetic Linux identity even when this source-only suite is run on another OS.
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1234 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", originalPlatform);
  if (originalUid) Object.defineProperty(process, "getuid", originalUid);
  else Reflect.deleteProperty(process, "getuid");
});

describe("fixed kernel acquisition", () => {
  it.each([
    ["boot", "/proc/sys/kernel/random/boot_id"],
    ["uptime", "/proc/uptime"],
    ["memory", "/proc/meminfo"],
  ] as const)("uses the exact %s route and closes partial reads", async (source, path) => {
    const file = descriptor("synthetic kernel contents");
    const result = await linuxObserverIO.kernel(source, new Acquisition(budget()));
    expect(Buffer.from(result).toString()).toBe("synthetic kernel contents");
    expect(open).toHaveBeenCalledWith(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(file.read.mock.calls[0]![0].length).toBe(LIMITS.sourceBytes + 1);
    expect(file.close).toHaveBeenCalledOnce();
  });
  it("fails at the aggregate limit, closing the descriptor without returning a prefix", async () => {
    const file = descriptor(secret);
    const acquisition = new Acquisition({ ...budget(), maxBytes: 10 });
    acquisition.take(5);
    await expect(linuxObserverIO.kernel("memory", acquisition)).rejects.toMatchObject({ reason: "oversized_source" });
    expect(file.read.mock.calls[0]![0].length).toBe(6);
    expect(file.close).toHaveBeenCalledOnce();
  });
  it.each([{ regular: false }, { uid: 1000 }])(
    "rejects non-regular or non-root proc descriptors %j",
    async (properties) => {
      const file = descriptor(secret, properties);
      await expect(linuxObserverIO.kernel("boot", new Acquisition(budget()))).rejects.toMatchObject({
        reason: "invalid_source",
      });
      expect(file.read).not.toHaveBeenCalled();
      expect(file.close).toHaveBeenCalledOnce();
    },
  );
  it("does not open after abort, and closes on mid-read abort or permission loss", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      linuxObserverIO.kernel("boot", new Acquisition({ ...budget(), signal: controller.signal })),
    ).rejects.toMatchObject({ reason: "timeout" });
    expect(open).not.toHaveBeenCalled();
    const file = descriptor(secret);
    const next = new AbortController();
    file.read.mockImplementation(async () => {
      next.abort();
      return { bytesRead: 1 };
    });
    await expect(
      linuxObserverIO.kernel("boot", new Acquisition({ ...budget(), signal: next.signal })),
    ).rejects.toMatchObject({ reason: "timeout" });
    expect(file.close).toHaveBeenCalledOnce();
    vi.mocked(open).mockRejectedValue(new Error(secret));
    await expect(linuxObserverIO.kernel("boot", new Acquisition(budget()))).rejects.toThrow();
  });
  it("uses root statfs only, preserving integer capacity until projection", async () => {
    vi.mocked(statfs).mockResolvedValue({ blocks: 5n, bsize: 1024n, bavail: 2n } as unknown as Awaited<
      ReturnType<typeof statfs>
    >);
    expect(await linuxObserverIO.root(new Acquisition(budget()))).toEqual({ totalBytes: 5120n, availableBytes: 2048n });
    expect(statfs).toHaveBeenCalledWith("/", { bigint: true });
  });
});

describe("bounded read-only query children", () => {
  it.each(["health", "logs"] as const)("uses fixed %s arguments and a clean exact-UID environment", async (source) => {
    const child = queryChild();
    const pending = linuxObserverIO.unit(source, "maintenance-bridge", 1234, boot, new Acquisition(budget()));
    const [executable, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(executable).toBe(source === "health" ? "/usr/bin/systemctl" : "/usr/bin/journalctl");
    expect(options).toEqual({
      shell: false,
      cwd: "/",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        LANG: "C",
        LC_ALL: "C",
        XDG_RUNTIME_DIR: "/run/user/1234",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1234/bus",
      },
    });
    expect(args).toContain("--user");
    expect(args).toContain("--no-pager");
    if (source === "health")
      expect(args).toEqual([
        "--user",
        "--no-pager",
        "show",
        "--property=Id,LoadState,ActiveState",
        "--",
        "maintenance-bridge.service",
      ]);
    else {
      expect(args).toEqual(
        expect.arrayContaining([
          "--output=json",
          "--lines=64",
          "--since=-15min",
          "_UID=1234",
          "_SYSTEMD_USER_UNIT=maintenance-bridge.service",
          `_BOOT_ID=${boot}`,
        ]),
      );
      expect(args?.find((arg) => arg.startsWith("--output-fields="))).not.toContain("MESSAGE");
      expect(args).not.toContain("--follow");
    }
    child.stdout.write("{}\n");
    child.emit("close", 0);
    expect(Buffer.from(await pending).toString()).toBe("{}\n");
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("rejects root/other-user and arbitrary service input before spawn", async () => {
    for (const uid of [0, 1235])
      await expect(
        linuxObserverIO.unit("health", "maintenance-bridge", uid, boot, new Acquisition(budget())),
      ).rejects.toMatchObject({ reason: "invalid_source" });
    await expect(
      linuxObserverIO.unit(
        "health",
        "ssh.service; shutdown" as "maintenance-bridge",
        1234,
        boot,
        new Acquisition(budget()),
      ),
    ).rejects.toMatchObject({ reason: "invalid_source" });
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each(["stdout", "stderr"] as const)("kills a query on %s overflow and waits for child close", async (stream) => {
    const child = queryChild();
    const pending = linuxObserverIO.unit(
      "logs",
      "maintenance-bridge",
      1234,
      boot,
      new Acquisition({ ...budget(), maxBytes: 10 }),
    );
    let settled = false;
    const result = pending.catch((error: unknown) => {
      settled = true;
      return error;
    });
    child[stream].write(secret);
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    child.stdout.write(secret);
    child.emit("close", null);
    expect(await result).toMatchObject({ reason: "oversized_source" });
  });
  it("bounds record acquisition across chunks, including a final unterminated record", async () => {
    const child = queryChild();
    const result = linuxObserverIO
      .unit("logs", "maintenance-bridge", 1234, boot, new Acquisition({ ...budget(), maxRecords: 2 }))
      .catch((error: unknown) => error);
    child.stdout.write("{}\n{");
    child.stdout.write("}\n{");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null);
    expect(await result).toMatchObject({ reason: "oversized_source" });
  });
  it.each(["abort", "timeout"] as const)(
    "terminates only its query on %s and releases listeners on close",
    async (failure) => {
      vi.useFakeTimers();
      const child = queryChild();
      const controller = new AbortController();
      const result = linuxObserverIO
        .unit("logs", "maintenance-bridge", 1234, boot, new Acquisition({ ...budget(), signal: controller.signal }))
        .catch((error: unknown) => error);
      if (failure === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(LIMITS.deadlineMs);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      child.emit("close", null);
      expect(await result).toMatchObject({ reason: "timeout" });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(["error", "exit", "warning"] as const)(
    "fails closed on a child %s without stderr/error content",
    async (failure) => {
      const child = queryChild();
      const result = linuxObserverIO
        .unit("health", "maintenance-bridge", 1234, boot, new Acquisition(budget()))
        .catch((error: unknown) => error);
      if (failure === "error") child.emit("error", new Error(secret));
      if (failure === "warning") child.stderr.write(secret);
      child.emit("close", failure === "exit" ? 1 : 0);
      const error = await result;
      expect(error).toMatchObject({ reason: "source_failed" });
      expect(String(error)).not.toContain(secret);
    },
  );
});
