/** Lazy isolated native I/O: a stuck telemetry syscall cannot occupy the shared libuv pool. */
import { Worker } from "node:worker_threads";
import { HOST_RESOURCE_LIMITS, type ResourceReason } from "@orca/protocol";
import type { StorageReading } from "./sources.js";

export type NativeIoCode = "ENOENT" | "EACCES" | "EPERM" | "INVALID_SOURCE" | "SOURCE_FAILED" | "BUSY";
export type NativeIoRequest = { id: number; operation: "read" | "storage"; path: string };
export type NativeIoResponse =
  { id: number; ok: true; value: Uint8Array | StorageReading } | { id: number; ok: false; code: NativeIoCode };
export interface NativeIoWorker {
  postMessage: (request: NativeIoRequest) => void;
  on: (event: string, listener: (value: unknown) => void) => unknown;
  unref: () => void;
  terminate: () => Promise<number>;
}
export interface NativeResourceIo {
  read: (path: string) => Promise<Buffer>;
  storage: (path: string) => Promise<StorageReading>;
  close: () => void;
}
export class NativeIoError extends Error {
  readonly reason: ResourceReason;
  constructor(readonly code: NativeIoCode) {
    super("host resource source unavailable");
    this.reason =
      code === "EACCES" || code === "EPERM"
        ? "permission-denied"
        : code === "INVALID_SOURCE"
          ? "invalid-source"
          : code === "BUSY"
            ? "busy"
            : "source-failed";
  }
}
/** At most four queued/unsettled operations, including caller-timed-out operations. */
export function createNativeResourceIo(
  storagePaths: readonly string[] = [],
  factory: () => NativeIoWorker = () =>
    new Worker(new URL("./native-io-worker.js", import.meta.url), {
      workerData: { storagePaths: [...storagePaths], sourceBytes: HOST_RESOURCE_LIMITS.sourceBytes },
      // The compiled worker is standalone; main-process eval/loader flags do not apply.
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 1 },
    }),
): NativeResourceIo {
  if (storagePaths.length > 3 || storagePaths.some((path) => Buffer.byteLength(path) > 4096))
    throw new NativeIoError("INVALID_SOURCE");
  let worker: NativeIoWorker | undefined,
    closed = false,
    sequence = 0;
  const pending = new Map<
    number,
    { resolve: (value: Uint8Array | StorageReading) => void; reject: (error: NativeIoError) => void }
  >();
  const fail = () => {
    closed = true;
    for (const item of pending.values()) item.reject(new NativeIoError("SOURCE_FAILED"));
    pending.clear();
  };
  const start = () => {
    if (worker) return worker;
    worker = factory();
    worker.on("message", (value) => {
      const response = value as NativeIoResponse;
      if (!response || typeof response !== "object" || !Number.isSafeInteger(response.id)) {
        fail();
        return;
      }
      const item = pending.get(response.id);
      if (!item) return;
      pending.delete(response.id);
      if (response.ok) item.resolve(response.value);
      else item.reject(new NativeIoError(response.code));
    });
    worker.on("error", fail);
    worker.on("exit", fail);
    // Listeners can ref MessagePort; unref after registration, once, never on a timer.
    worker.unref();
    return worker;
  };
  const request = (operation: NativeIoRequest["operation"], path: string): Promise<Uint8Array | StorageReading> => {
    if (Buffer.byteLength(path) > 4096) return Promise.reject(new NativeIoError("INVALID_SOURCE"));
    if (closed) return Promise.reject(new NativeIoError("SOURCE_FAILED"));
    if (pending.size >= 4) return Promise.reject(new NativeIoError("BUSY"));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      try {
        start().postMessage({ id, operation, path });
      } catch {
        fail();
      }
    });
  };
  return {
    read: async (path) => {
      const value = await request("read", path);
      if (!(value instanceof Uint8Array) || value.byteLength > HOST_RESOURCE_LIMITS.sourceBytes)
        throw new NativeIoError("INVALID_SOURCE");
      return Buffer.from(value);
    },
    storage: async (path) => {
      const value = await request("storage", path);
      if (value instanceof Uint8Array) throw new NativeIoError("INVALID_SOURCE");
      return value;
    },
    close: () => {
      fail();
      if (worker) void worker.terminate().catch(() => {});
    },
  };
}
