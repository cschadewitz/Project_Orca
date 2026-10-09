/** One async native storage session. Paths become validated names beneath held handles. */
import { constants } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { loadDiagnosticsAddon } from "./native-addon.js";
import { createProductionNativeAdapter, sameIdentity, type RecoveryNativeAdapter } from "./native-adapter.js";
import type { RecoveryFileHandle, RecoveryFileSystem, RecoveryStat } from "./recovery-files.js";

export interface NativeStorageBackend {
  abi: 1;
  platform: "darwin" | "posix-fixture";
  call(
    operation: string,
    root: unknown,
    file: unknown,
    path: string,
    second: string,
    buffer: Buffer | undefined,
    offset: number,
    length: number,
    position: number,
  ): Promise<unknown>;
}
export interface NativeDiagnosticsStorage {
  native: RecoveryNativeAdapter;
  files: RecoveryFileSystem;
  close(): Promise<void>;
}
const unavailable = () => new Error("unavailable");
const refusedFiles: RecoveryFileSystem = {
  lstat: () => Promise.reject(unavailable()),
  readdir: () => Promise.reject(unavailable()),
  open: () => Promise.reject(unavailable()),
};

/** No Node/path-based fallback. Windows remains unavailable pending its native proof. */
export function loadNativeDiagnosticsStorage(root: string): NativeDiagnosticsStorage {
  if (process.platform === "darwin") {
    try {
      const backend = loadDiagnosticsAddon("diagnostics_storage");
      const abi = Object.getOwnPropertyDescriptor(backend, "abi")?.value as unknown;
      const platform = Object.getOwnPropertyDescriptor(backend, "platform")?.value as unknown;
      const call = Object.getOwnPropertyDescriptor(backend, "call")?.value as unknown;
      if (abi === 1 && platform === "darwin" && typeof call === "function")
        return createHandleRelativeStorage(root, backend as NativeStorageBackend);
    } catch {
      /* Missing/incompatible addon stays unavailable. */
    }
  }
  return { native: createProductionNativeAdapter(), files: refusedFiles, close: () => Promise.resolve() };
}

/** Explicit injection seam for native conformance; not production consent/acceptance. */
export function createHandleRelativeStorage(root: string, backend: NativeStorageBackend): NativeDiagnosticsStorage {
  if (!isAbsolute(root) || resolve(root) !== root || root === sep || backend.abi !== 1) throw unavailable();
  let held: unknown;
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  const handles = new WeakMap<RecoveryFileHandle, unknown>();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const call = (
    operation: string,
    path = "",
    second = "",
    file?: unknown,
    buffer?: Buffer,
    offset = 0,
    length = 0,
    position = 0,
  ) => {
    if (closed) return Promise.reject(unavailable());
    return backend.call(operation, held, file, path, second, buffer, offset, length, position);
  };
  const ensure = async (create = false) => {
    if (closed) throw unavailable();
    held ??= await call("openRoot", root, "", undefined, undefined, create ? 1 : 0);
    if (!held) throw unavailable();
  };
  const name = (path: string) => {
    const result = relative(root, path);
    if (!isAbsolute(path) || resolve(path) !== path || !result || result.includes(sep) || result === "..")
      throw unavailable();
    return result;
  };
  const stat = (value: unknown): RecoveryStat => {
    if (!value || typeof value !== "object") throw unavailable();
    const source = value as Record<string, unknown>;
    if (
      typeof source.dev !== "bigint" ||
      typeof source.ino !== "bigint" ||
      ![source.uid, source.mode, source.nlink, source.size, source.kind].every(
        (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
      )
    )
      throw unavailable();
    const { dev, ino } = source;
    const { uid, mode, nlink, size, kind } = source as unknown as {
      uid: number;
      mode: number;
      nlink: number;
      size: number;
      kind: number;
    };
    return {
      dev,
      ino,
      uid,
      mode,
      nlink,
      size,
      isFile: () => kind === 1,
      isDirectory: () => kind === 2,
      isSymbolicLink: () => kind === 3,
    };
  };
  const files: RecoveryFileSystem = {
    lstat: (path) =>
      serial(async () => {
        await ensure();
        return stat(await call(path === root ? "rootStat" : "stat", path === root ? "" : name(path)));
      }),
    readdir: (path) =>
      serial(async () => {
        if (path !== root) throw unavailable();
        await ensure();
        const result = await call("list");
        if (
          !Array.isArray(result) ||
          result.length > 16 ||
          !result.every((n) => typeof n === "string" && n.length < 64)
        )
          throw unavailable();
        return result as string[];
      }),
    open: (path, flags, mode) =>
      serial(async () => {
        await ensure();
        const reading = flags === (constants.O_RDONLY | constants.O_NOFOLLOW);
        const creating =
          flags === (constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW) &&
          mode === 0o600;
        if (!reading && !creating) throw unavailable();
        const native = await call(reading ? "openRead" : "openCreate", name(path));
        let fileClosed = false;
        const withFile = <T>(run: () => Promise<T>) =>
          serial(() => {
            if (fileClosed) throw unavailable();
            return run();
          });
        const file: RecoveryFileHandle = {
          stat: () => withFile(async () => stat(await call("fileStat", "", "", native))),
          read: (buffer, offset, length, position) =>
            withFile(async () => {
              const count = await call("read", "", "", native, buffer, offset, length, position);
              if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > length)
                throw unavailable();
              return { bytesRead: count };
            }),
          writeFile: (bytes) =>
            withFile(async () => {
              await call("write", "", "", native, bytes, 0, bytes.length);
            }),
          sync: () =>
            withFile(async () => {
              await call("sync", "", "", native);
            }),
          close: () =>
            serial(async () => {
              if (!fileClosed) {
                await call("closeFile", "", "", native);
                fileClosed = true;
                handles.delete(file);
              }
            }),
        };
        handles.set(file, native);
        return file;
      }),
  };
  const native: RecoveryNativeAdapter = {
    verifyRoot: (path) =>
      serial(async () => {
        if (path !== root) return false;
        try {
          await ensure(true);
          await call("rootStat");
          return true;
        } catch {
          return false;
        }
      }),
    acquire: (path) =>
      serial(async () => {
        if (path !== root) return false;
        try {
          await ensure(true);
          await call("acquire");
          return true;
        } catch {
          return false;
        }
      }),
    release: (path) =>
      serial(async () => {
        if (path !== root) throw unavailable();
        if (held) await call("release");
      }),
    async write(file, bytes) {
      if (!handles.has(file as RecoveryFileHandle)) throw unavailable();
      await file.writeFile(bytes);
      await file.sync();
    },
    replace: (from, to) =>
      serial(async () => {
        await ensure();
        await call("replace", name(from), name(to));
      }),
    remove: (path) =>
      serial(async () => {
        await ensure();
        await call("remove", name(path));
      }),
    validateDestination: (path, destination) =>
      serial(async () => {
        if (path !== root) return false;
        await ensure();
        return (await call("validateDestination", destination)) === true;
      }),
    async publish(path, stage, destination, identity, admit) {
      if (path !== root || name(stage) !== "export-stage.tmp") return "refused";
      const file = await files.open(stage, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!sameIdentity(await file.stat(), identity)) return "refused";
        return await serial(async () => {
          // No await separates the final consent/epoch check from native dispatch.
          if (!admit()) return "refused";
          const result = await call("publish", destination, "", handles.get(file));
          return result === "saved" || result === "refused" ? result : "unknown";
        });
      } finally {
        await file.close();
      }
    },
    writersStopped: (path) =>
      serial(async () => {
        if (path !== root) return false;
        await ensure();
        return (await call("stopped")) === true;
      }),
  };
  return {
    native,
    files,
    close: () =>
      serial(async () => {
        if (closed) return;
        if (held) await call("closeRoot");
        closed = true;
        held = undefined;
      }),
  };
}
