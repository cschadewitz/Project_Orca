/** Fixed Linux acquisition only: bounded kernel files and same-user, read-only systemd queries. */
import { constants } from "node:fs";
import { open, statfs } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ReadBudget } from "./adapter.js";
import { LIMITS, SERVICES, type ServiceAlias } from "./policy.js";

const KERNEL_PATHS = Object.freeze({
  boot: "/proc/sys/kernel/random/boot_id",
  uptime: "/proc/uptime",
  memory: "/proc/meminfo",
});
export type KernelSource = keyof typeof KERNEL_PATHS;
export type UnitSource = "health" | "logs";
export class SourceError extends Error {
  constructor(readonly reason: "invalid_source" | "oversized_source" | "source_failed" | "timeout") {
    super(reason);
  }
}

/** One aggregate byte/deadline budget for every acquisition in an observation. */
export class Acquisition {
  private consumed = 0;
  private readonly started = performance.now();
  constructor(readonly budget: ReadBudget) {
    if (
      !Number.isInteger(budget.maxBytes) ||
      budget.maxBytes < 1 ||
      budget.maxBytes > LIMITS.sourceBytes ||
      !Number.isInteger(budget.maxRecords) ||
      budget.maxRecords < 1 ||
      budget.maxRecords > LIMITS.sourceRecords ||
      !Number.isFinite(budget.deadlineMs) ||
      budget.deadlineMs <= 0 ||
      budget.deadlineMs > LIMITS.deadlineMs
    )
      throw new SourceError("invalid_source");
  }
  get remaining() {
    return this.budget.maxBytes - this.consumed;
  }
  get timeRemaining() {
    return Math.max(0, this.budget.deadlineMs - (performance.now() - this.started));
  }
  check() {
    if (this.budget.signal.aborted) throw new SourceError("timeout");
    if (this.timeRemaining === 0) throw new SourceError("timeout");
  }
  take(count: number) {
    this.check();
    if (!Number.isSafeInteger(count) || count < 0) throw new SourceError("invalid_source");
    if (count > this.remaining) throw new SourceError("oversized_source");
    this.consumed += count;
  }
}

/** Trusted test seam; no caller-selected path, executable, arguments or environment. */
export interface ObserverIO {
  platform(): string;
  uid(): number | undefined;
  kernel(source: KernelSource, acquisition: Acquisition): Promise<Uint8Array>;
  root(acquisition: Acquisition): Promise<{ totalBytes: bigint; availableBytes: bigint }>;
  unit(
    source: UnitSource,
    service: ServiceAlias,
    uid: number,
    bootId: string,
    acquisition: Acquisition,
  ): Promise<Uint8Array>;
}

async function kernel(source: KernelSource, acquisition: Acquisition): Promise<Uint8Array> {
  acquisition.check();
  if (!Object.hasOwn(KERNEL_PATHS, source)) throw new SourceError("invalid_source");
  const file = await open(KERNEL_PATHS[source], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    acquisition.check();
    const info = await file.stat();
    if (!info.isFile() || info.uid !== 0) throw new SourceError("invalid_source");
    // procfs size is usually zero; read at most the remaining allowance plus one overflow byte.
    const buffer = Buffer.alloc(acquisition.remaining + 1);
    let used = 0;
    while (used < buffer.length) {
      acquisition.check();
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
      acquisition.take(bytesRead);
      if (bytesRead === 0) return buffer.subarray(0, used);
      used += bytesRead;
    }
    throw new SourceError("oversized_source");
  } finally {
    await file.close();
  }
}

const JOURNAL_FIELDS = [
  "__REALTIME_TIMESTAMP",
  "_UID",
  "_BOOT_ID",
  "_SYSTEMD_USER_UNIT",
  "ORCA_MAINTENANCE_CATEGORY",
  "ORCA_MAINTENANCE_STATE",
  "ORCA_MAINTENANCE_READY",
  "ORCA_MAINTENANCE_RESOURCE",
  "ORCA_MAINTENANCE_USED_PERCENT",
].join(",");

async function unit(
  source: UnitSource,
  service: ServiceAlias,
  uid: number,
  bootId: string,
  acquisition: Acquisition,
): Promise<Uint8Array> {
  acquisition.check();
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== uid ||
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    !SERVICES.includes(service) ||
    service === "orca-daemon" ||
    !/^[0-9a-f]{32}$/.test(bootId) ||
    (source !== "health" && source !== "logs")
  )
    throw new SourceError("invalid_source");
  const name = `${service}.service`;
  const executable = source === "health" ? "/usr/bin/systemctl" : "/usr/bin/journalctl";
  const args =
    source === "health"
      ? ["--user", "--no-pager", "show", "--property=Id,LoadState,ActiveState", "--", name]
      : [
          "--user",
          "--no-pager",
          "--quiet",
          "--output=json",
          `--output-fields=${JOURNAL_FIELDS}`,
          `--lines=${acquisition.budget.maxRecords}`,
          "--since=-15min",
          `--until=@${Date.now() / 1000}`,
          `_UID=${uid}`,
          `_SYSTEMD_USER_UNIT=${name}`,
          `_BOOT_ID=${bootId}`,
        ];
  const child = spawn(executable, args, {
    shell: false,
    cwd: "/",
    env: {
      LANG: "C",
      LC_ALL: "C",
      XDG_RUNTIME_DIR: `/run/user/${uid}`,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let failure: SourceError | undefined;
    let lines = 0;
    let stderrSeen = false;
    const stop = (error: unknown) => {
      if (!failure) failure = error instanceof SourceError ? error : new SourceError("source_failed");
      // Terminate only this read-only query child, never a unit or the ORCA process.
      child.kill("SIGKILL");
    };
    const abort = () => stop(new SourceError("timeout"));
    acquisition.budget.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, acquisition.timeRemaining);
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      try {
        acquisition.take(chunk.byteLength);
        if (source === "logs") {
          for (const byte of chunk) {
            if (lines >= acquisition.budget.maxRecords) throw new SourceError("oversized_source");
            if (byte === 10) lines++;
          }
        }
        chunks.push(chunk);
      } catch (error) {
        stop(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (failure) return;
      stderrSeen ||= chunk.byteLength > 0;
      // Count but never retain/echo stderr; even warnings cannot create an unbounded side channel.
      try {
        acquisition.take(chunk.byteLength);
      } catch (error) {
        stop(error);
      }
    });
    child.on("error", () => stop(new SourceError("source_failed")));
    child.on("close", (code) => {
      clearTimeout(timer);
      acquisition.budget.signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0 || stderrSeen) reject(new SourceError("source_failed"));
      else {
        try {
          acquisition.check();
          resolve(Buffer.concat(chunks));
        } catch (error) {
          reject(error instanceof SourceError ? error : new SourceError("source_failed"));
        }
      }
    });
    // Cover abort racing listener registration/spawn.
    if (acquisition.budget.signal.aborted) abort();
  });
}

export const linuxObserverIO: ObserverIO = Object.freeze({
  platform: () => process.platform,
  uid: () => process.getuid?.(),
  kernel,
  async root(acquisition: Acquisition) {
    acquisition.check();
    const info = await statfs("/", { bigint: true });
    acquisition.check();
    return { totalBytes: info.blocks * info.bsize, availableBytes: info.bavail * info.bsize };
  },
  unit,
});
