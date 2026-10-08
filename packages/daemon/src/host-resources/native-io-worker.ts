/** Dedicated telemetry worker: synchronous fixed-file I/O never uses libuv's shared worker pool. */
import { closeSync, openSync, readSync, statSync, statfsSync } from "node:fs";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { safe, SourceError } from "./parsers.js";
import type { NativeIoCode, NativeIoRequest, NativeIoResponse } from "./native-io.js";

const fixedReads = new Set([
  "/proc/stat",
  "/proc/meminfo",
  "/proc/vmstat",
  "/proc/sys/kernel/random/boot_id",
  "/proc/self/auxv",
  "/proc/self/cgroup",
  "/proc/self/mountinfo",
]);
function allowedRead(path: string): boolean {
  if (fixedReads.has(path)) return true;
  if (!path.startsWith("/sys/fs/cgroup/")) return false;
  const parts = path.slice("/sys/fs/cgroup/".length).split("/");
  const file = parts.pop();
  return (
    parts.length <= 8 &&
    parts.every((part) => part !== "." && part !== ".." && /^[\w.@:-]+$/.test(part)) &&
    ["cpu.max", "memory.max", "memory.current", "cpuset.cpus.effective"].includes(file ?? "")
  );
}
function boundedBytes(path: string, sourceBytes: number): Uint8Array {
  const descriptor = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(sourceBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > sourceBytes) throw new SourceError("invalid-source");
    return Uint8Array.from(bytes.subarray(0, offset));
  } finally {
    closeSync(descriptor);
  }
}
function code(error: unknown): NativeIoCode {
  if (error instanceof SourceError) return "INVALID_SOURCE";
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EACCES" || error.code === "EPERM")
  )
    return error.code;
  return "SOURCE_FAILED";
}
/** Exported only for deterministic sync-fs fixtures; main collector never imports this module. */
export function executeNativeRequest(
  request: NativeIoRequest,
  storagePaths: readonly string[],
  sourceBytes: number,
): NativeIoResponse {
  try {
    if (Buffer.byteLength(request.path) > 4096) throw new SourceError("invalid-source");
    if (request.operation === "read") {
      if (!allowedRead(request.path)) throw new SourceError("invalid-source");
      return { id: request.id, ok: true, value: boundedBytes(request.path, sourceBytes) };
    }
    if (request.operation !== "storage" || !storagePaths.includes(request.path))
      throw new SourceError("invalid-source");
    const stats = statfsSync(request.path, { bigint: true }),
      identity = statSync(request.path, { bigint: true });
    const diskTypes = [0xef53n, 0x58465342n, 0x9123683en, 0x2fc12fc1n, 0xf2f52010n, 0x5346544en];
    const backing = stats.type === 0x01021994n ? "tmpfs" : diskTypes.includes(stats.type) ? "disk" : "unknown";
    return {
      id: request.id,
      ok: true,
      value: {
        totalBytes: safe(Number(stats.blocks * stats.bsize)),
        availableBytes: safe(Number(stats.bavail * stats.bsize)),
        device: String(identity.dev),
        backing,
      },
    };
  } catch (error) {
    return { id: request.id, ok: false, code: code(error) };
  }
}
if (!isMainThread && parentPort) {
  const data = workerData as { storagePaths: string[]; sourceBytes: number };
  const port = parentPort;
  port.on("message", (request: NativeIoRequest) => {
    port.postMessage(executeNativeRequest(request, data.storagePaths, data.sourceBytes));
  });
}
