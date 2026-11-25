/** Bounded verified tree copying. Live paths stay fixed; unsupported topology refuses. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { loadDiagnosticsAddon } from "./diagnostics/native-addon.js";
import type { NativeStorageBackend } from "./diagnostics/native-storage.js";

const unavailable = () => new Error("Protected pair filesystem unavailable");
export interface PairTreePort {
  digest(this: void, path: string, signal: AbortSignal): Promise<string>;
  copy(this: void, source: string, destination: string, signal: AbortSignal): Promise<void>;
  restore(this: void, source: string, destination: string, signal: AbortSignal): Promise<void>;
}
const execute = promisify(execFile);
const check = (signal: AbortSignal) => {
  if (signal.aborted) throw unavailable();
};
async function command(file: string, args: string[], signal: AbortSignal): Promise<string> {
  try {
    return (
      await execute(file, args, { env: {}, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024, signal })
    ).stdout;
  } catch {
    throw unavailable();
  }
}
export async function syncPairDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function syncPairRecord(handle: FileHandle) {
  if (process.platform === "darwin") {
    const backend = loadDiagnosticsAddon("diagnostics_storage") as NativeStorageBackend;
    if (backend.abi !== 1 || backend.platform !== "darwin" || typeof backend.flushDescriptorSync !== "function")
      throw unavailable();
    backend.flushDescriptorSync(handle.fd);
  } else await handle.sync();
}
async function pathSafe(path: string) {
  if (!isAbsolute(path) || resolve(path) !== path || /[\r\n\0]/.test(path)) throw unavailable();
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (await realpath(path)) !== path) throw unavailable();
  return stat;
}
type Entry = {
  name: string;
  kind: "directory" | "file" | "symlink";
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: number;
  sha256: string;
  attributes: string;
};

/** Darwin metadata is read independently of the copy command. ACL/xattr bytes are hashed,
 * never logged or persisted as readable secrets. Linux is explicit fixture-only evidence. */
export function createPairTreePort(
  platform: "darwin" | "posix-fixture",
  fixtureBackend?: NativeStorageBackend,
): PairTreePort {
  if (
    (platform === "darwin" && process.platform !== "darwin") ||
    (platform === "posix-fixture" && process.platform !== "linux")
  )
    throw unavailable();
  const backend =
    fixtureBackend ??
    (platform === "darwin" ? (loadDiagnosticsAddon("diagnostics_storage") as NativeStorageBackend) : undefined);
  if (
    backend &&
    (backend.abi !== 1 || backend.replacementStorage !== 1 || (platform === "darwin" && backend.platform !== "darwin"))
  )
    throw unavailable();
  const nativeTree = async (
    operation: "pairCopy" | "pairRestore",
    source: string,
    destination: string,
    signal: AbortSignal,
  ) => {
    check(signal);
    const from = await lstat(source, { bigint: true }),
      to = await lstat(operation === "pairCopy" ? dirname(destination) : destination, { bigint: true });
    // Dispatched native work is awaited to settlement even on abort. The closed window
    // retains its kernel slots for the entire syscall operation, including lost replies.
    await backend!.call(
      operation,
      undefined,
      undefined,
      source,
      destination,
      Buffer.from(`${from.dev}:${from.ino}:${to.dev}:${to.ino}`),
      0,
      0,
      0,
    );
    check(signal);
  };
  const attributes = async (path: string, signal: AbortSignal) => {
    if (platform === "posix-fixture") return "fixture-no-native-attributes";
    const acl = (await command("/bin/ls", ["-lde", path], signal)).split("\n").slice(1).join("\n");
    const names = (await command("/usr/bin/xattr", ["-s", path], signal)).split("\n").filter(Boolean).sort();
    if (names.length > 128 || names.some((n) => !/^[A-Za-z0-9._-]{1,256}$/.test(n))) throw unavailable();
    const hash = createHash("sha256").update(acl);
    for (const name of names)
      hash.update(name).update(await command("/usr/bin/xattr", ["-s", "-px", name, path], signal));
    return hash.digest("hex");
  };
  const inventory = async (root: string, signal: AbortSignal): Promise<Entry[]> => {
    const initial = await pathSafe(root);
    const entries: Entry[] = [];
    let bytes = 0;
    const visit = async (path: string, depth: number): Promise<void> => {
      check(signal);
      if (depth > 64 || entries.length >= 65536) throw unavailable();
      const stat = await lstat(path);
      if (stat.uid !== process.getuid?.() || /[\r\n\0]/.test(path) || stat.mode & 0o6000) throw unavailable();
      const kind = stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : stat.isSymbolicLink()
            ? "symlink"
            : undefined;
      if (!kind || (kind === "file" && (stat.nlink !== 1 || stat.size > 1024 * 1024 * 1024))) throw unavailable();
      bytes += kind === "file" ? stat.size : 0;
      if (bytes > 1024 * 1024 * 1024) throw unavailable();
      const hash = createHash("sha256");
      if (kind === "symlink") {
        const target = await readlink(path);
        const resolved = resolve(dirname(path), target);
        if (isAbsolute(target) || (resolved !== root && !resolved.startsWith(root + "/")) || /[\r\n\0]/.test(target))
          throw unavailable();
        hash.update(target);
      } else if (kind === "file") {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const held = await handle.stat();
          if (held.dev !== stat.dev || held.ino !== stat.ino) throw unavailable();
          const buffer = Buffer.alloc(64 * 1024);
          let offset = 0;
          while (offset < stat.size) {
            check(signal);
            const result = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
            if (!result.bytesRead) throw unavailable();
            hash.update(buffer.subarray(0, result.bytesRead));
            offset += result.bytesRead;
          }
          const final = await handle.stat();
          if (
            (await handle.read(buffer, 0, 1, offset)).bytesRead ||
            final.size !== stat.size ||
            final.mtimeMs !== stat.mtimeMs ||
            final.ctimeMs !== stat.ctimeMs
          )
            throw unavailable();
        } finally {
          await handle.close();
        }
      }
      const metadata = await attributes(path, signal);
      const final = await lstat(path);
      if (
        final.dev !== stat.dev ||
        final.ino !== stat.ino ||
        final.size !== stat.size ||
        final.mtimeMs !== stat.mtimeMs ||
        final.ctimeMs !== stat.ctimeMs
      )
        throw unavailable();
      entries.push({
        name: relative(root, path),
        kind,
        mode: stat.mode & 0o7777,
        uid: stat.uid,
        gid: stat.gid,
        size: kind === "file" ? stat.size : 0,
        mtime: kind === "symlink" ? 0 : Math.trunc(stat.mtimeMs),
        sha256: hash.digest("hex"),
        attributes: metadata,
      });
      if (kind === "directory")
        for (const name of (await readdir(path)).sort()) await visit(join(path, name), depth + 1);
    };
    await visit(root, 0);
    const final = await pathSafe(root);
    if (initial.dev !== final.dev || initial.ino !== final.ino) throw unavailable();
    // Directory mtime changes when a restore is staged. Content/topology/access are relevant;
    // file mtimes are retained to avoid changing config/cache freshness semantics.
    return entries.map((e) => (e.kind === "directory" ? { ...e, mtime: 0 } : e));
  };
  const digest = async (path: string, signal: AbortSignal) =>
    createHash("sha256")
      .update(JSON.stringify(await inventory(path, signal)))
      .digest("hex");
  const flush = async (path: string, signal: AbortSignal) => {
    const entries = await inventory(path, signal);
    for (const entry of entries.filter((e) => e.kind === "file")) {
      const handle = await open(join(path, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    for (const entry of entries.filter((e) => e.kind === "directory").reverse())
      await syncPairDirectory(join(path, entry.name));
  };
  const copy = async (source: string, destination: string, signal: AbortSignal) => {
    check(signal);
    const before = await digest(source, signal);
    await pathSafe(dirname(destination));
    try {
      await lstat(destination);
      throw unavailable();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (backend) await nativeTree("pairCopy", source, destination, signal);
    else {
      for (const entry of await inventory(source, signal)) {
        check(signal);
        const from = join(source, entry.name),
          to = join(destination, entry.name);
        if (entry.kind === "directory") await mkdir(to, { mode: entry.mode });
        else if (entry.kind === "symlink") await symlink(await readlink(from), to);
        else {
          const input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
          const output = await open(
            to,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            entry.mode,
          );
          try {
            const buffer = Buffer.alloc(64 * 1024);
            let offset = 0;
            while (offset < entry.size) {
              check(signal);
              const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, entry.size - offset), offset);
              if (!bytesRead) throw unavailable();
              let written = 0;
              while (written < bytesRead) {
                const result = await output.write(buffer, written, bytesRead - written, offset + written);
                if (!result.bytesWritten) throw unavailable();
                written += result.bytesWritten;
              }
              offset += bytesRead;
            }
            await output.sync();
          } finally {
            await input.close();
            await output.close();
          }
          await chmod(to, entry.mode);
          // Inventory retains integer milliseconds. Target the middle of that millisecond
          // so floating seconds and syscall precision cannot round into the previous one.
          const seconds = (entry.mtime + 0.5) / 1000;
          await utimes(to, seconds, seconds);
        }
      }
    }
    await flush(destination, signal);
    await syncPairDirectory(dirname(destination));
    if ((await digest(source, signal)) !== before || (await digest(destination, signal)) !== before)
      throw unavailable();
  };
  return {
    digest,
    copy,
    async restore(source, destination, signal) {
      // The coordinator has durably preserved both complete pairs and "restoring" first.
      // Repeating this operation after interruption is safe only under that SAME closure.
      const before = await digest(source, signal);
      const initial = await pathSafe(destination);
      if (backend) {
        await nativeTree("pairRestore", source, destination, signal);
        const final = await pathSafe(destination);
        if (
          initial.dev !== final.dev ||
          initial.ino !== final.ino ||
          (await digest(source, signal)) !== before ||
          (await digest(destination, signal)) !== before
        )
          throw unavailable();
        return;
      }
      // Preserve root inode and its durable writer anchor; stage in a fresh sibling.
      const stage = join(
        dirname(destination),
        ".orca-restore-" + createHash("sha256").update(destination).digest("hex").slice(0, 24),
      );
      try {
        // Only disposable staging is replaced on resume, never either retained pair.
        await pathSafe(stage);
        await rm(stage, { recursive: true });
        await syncPairDirectory(dirname(stage));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await copy(source, stage, signal);
      for (const name of await readdir(destination)) {
        check(signal);
        if (name !== ".orca-update-window.json") await rm(join(destination, name), { recursive: true }); // rename-keep: the update-window guard the release being updated from writes (protocol update-window.ts)
      }
      {
        for (const name of await readdir(stage)) {
          check(signal);
          if (name === ".orca-update-window.json") continue; // rename-keep: the update-window guard the release being updated from writes (protocol update-window.ts)
          await rename(join(stage, name), join(destination, name));
          await syncPairDirectory(destination);
        }
      }
      await chmod(destination, (await lstat(source)).mode & 0o7777);
      await syncPairDirectory(destination);
      const final = await pathSafe(destination);
      if (initial.dev !== final.dev || initial.ino !== final.ino || (await digest(destination, signal)) !== before)
        throw unavailable();
      await rm(stage, { recursive: true });
      await syncPairDirectory(dirname(stage));
    },
  };
}
