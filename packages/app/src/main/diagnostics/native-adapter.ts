/** Native safety seam. POSIX fixtures are synthetic evidence, never shipping conformance. */
import { constants } from "node:fs";
import { lstat, open, rename, unlink, mkdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { RecoveryFileHandle } from "./recovery-files.js";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { validReading, type BootReading, type StageIdentity } from "./recovery-contract.js";

export interface DiagnosticsKeyAdapter {
  available(): Promise<boolean>;
  wrap(bytes: Buffer): Promise<Buffer>;
  unwrap(bytes: Buffer): Promise<Buffer>;
}

export interface RecoveryNativeAdapter {
  verifyRoot(root: string): Promise<boolean>;
  acquire(root: string): Promise<boolean>;
  release(root: string): Promise<void>;
  replace(source: string, destination: string): Promise<void>;
  write(handle: Pick<RecoveryFileHandle, "writeFile" | "sync">, bytes: Buffer): Promise<void>;
  remove(path: string): Promise<void>;
  validateDestination(root: string, destination: string): Promise<boolean>;
  publish(
    root: string,
    stage: string,
    destination: string,
    identity: StageIdentity,
    admit: () => boolean,
  ): Promise<"saved" | "refused" | "unknown">;
  writersStopped(root: string): Promise<boolean>;
}

interface AsyncSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

/** macOS/Windows only. Wrapping is asynchronous and never touches execution secrets. */
export function createSafeStorageKeyAdapter(
  storage: AsyncSafeStorage,
  platform: string = process.platform,
): DiagnosticsKeyAdapter {
  const available = async () =>
    (platform === "darwin" || platform === "win32") && (await storage.isAsyncEncryptionAvailable());
  return {
    available,
    async wrap(bytes) {
      if (!(await available()) || bytes.length > 2048) throw new Error("unavailable");
      const wrapped = await storage.encryptStringAsync(bytes.toString("base64"));
      if (wrapped.length > 4096) throw new Error("capacity_limited");
      return wrapped;
    },
    async unwrap(bytes) {
      if (!(await available()) || bytes.length > 4096) throw new Error("unavailable");
      const decrypted = await storage.decryptStringAsync(bytes);
      // Provider rotation needs a separately reviewed serialized rewrap; never
      // silently regenerate authority or retain a weakened wrapper.
      if (decrypted.shouldReEncrypt) throw new Error("unavailable");
      const text = decrypted.result;
      if (text.length > 4096 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error("unavailable");
      return Buffer.from(text, "base64");
    },
  };
}

/** No reviewed handle-relative ACL/clock/no-replace adapter is bundled yet. Fail closed. */
export function createProductionNativeAdapter(): RecoveryNativeAdapter {
  return {
    async verifyRoot() {
      return false;
    },
    async acquire() {
      return false;
    },
    async release() {},
    async replace() {
      throw new Error("unavailable");
    },
    async write() {
      throw new Error("unavailable");
    },
    async remove() {
      throw new Error("cleanup_pending");
    },
    async validateDestination() {
      return false;
    },
    async publish() {
      return "refused";
    },
    async writersStopped() {
      return false;
    },
  };
}

export function sameIdentity(stat: { dev: number | bigint; ino: number | bigint }, identity: StageIdentity): boolean {
  return String(stat.dev) === identity.device && String(stat.ino) === identity.inode;
}
const activeFixtureRoots = new Set<string>();

/** Explicit synthetic fixture, restricted to owner-only POSIX directories.
 * No portable Node call implements atomic no-replace move: fixtures must inject
 * one (tests use Linux renameat2), and separately prove supervised writer exit.
 * Path verification does not claim to resist adversarial concurrent parent swaps.
 */
export class PosixFixtureNativeAdapter implements RecoveryNativeAdapter {
  private readonly leases = new Map<string, string>();
  constructor(
    private readonly options: {
      stopped: (root: string) => Promise<boolean>;
      moveNoReplace: (source: string, destination: string) => Promise<"saved" | "refused" | "unknown">;
    },
  ) {}

  async verifyRoot(root: string): Promise<boolean> {
    if (process.platform === "win32" || !isAbsolute(root) || resolve(root) !== root) return false;
    try {
      await mkdir(root, { mode: 0o700 });
    } catch (error) {
      if (!isCode(error, "EEXIST")) return false;
    }
    try {
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        return false;
      let parent = dirname(root);
      while (true) {
        const stat = await lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
      return true;
    } catch {
      return false;
    }
  }

  async acquire(root: string): Promise<boolean> {
    if (activeFixtureRoots.has(root)) return false;
    activeFixtureRoots.add(root);
    let acquired = false;
    try {
      if (!(await this.verifyRoot(root))) return false;
      const path = `${root}/writer.lock`;
      try {
        // Existing lease is never retired using a PID, time, or lock heuristic.
        const stat = await lstat(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o077) !== 0 ||
          !(await this.options.stopped(root))
        )
          return false;
        await unlink(path);
      } catch (error) {
        if (!isCode(error, "ENOENT")) return false;
      }
      const token = randomUUID();
      try {
        const file = await open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(token);
          await file.sync();
        } finally {
          await file.close();
        }
        await syncDirectory(root);
        this.leases.set(root, token);
        acquired = true;
        return true;
      } catch {
        return false;
      }
    } finally {
      if (!acquired) activeFixtureRoots.delete(root);
    }
  }

  async release(root: string): Promise<void> {
    const token = this.leases.get(root);
    if (!token) return;
    const handle = await open(`${root}/writer.lock`, constants.O_RDONLY | constants.O_NOFOLLOW);
    let stored: string;
    try {
      stored = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    if (stored !== token) throw new Error("cleanup_pending");
    await unlink(`${root}/writer.lock`);
    await syncDirectory(root);
    this.leases.delete(root);
    activeFixtureRoots.delete(root);
  }
  async replace(source: string, destination: string): Promise<void> {
    await rename(source, destination);
    await syncDirectory(dirname(destination));
  }
  async write(handle: FileHandle, bytes: Buffer): Promise<void> {
    await handle.writeFile(bytes);
    await handle.sync();
  }
  async remove(path: string): Promise<void> {
    await unlink(path);
    await syncDirectory(dirname(path));
  }
  async validateDestination(root: string, destination: string): Promise<boolean> {
    if (
      !(await this.verifyRoot(root)) ||
      !isAbsolute(destination) ||
      resolve(destination) !== destination ||
      destination.startsWith(`${root}/`)
    )
      return false;
    try {
      const rootStat = await lstat(root);
      let parent = dirname(destination);
      const selected = await lstat(parent);
      if (selected.dev !== rootStat.dev || selected.uid !== process.getuid?.()) return false;
      while (true) {
        const stat = await lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
      try {
        await lstat(destination);
        return false;
      } catch (error) {
        return isCode(error, "ENOENT");
      }
    } catch {
      return false;
    }
  }
  async publish(
    root: string,
    stage: string,
    destination: string,
    identity: StageIdentity,
    admit: () => boolean,
  ): Promise<"saved" | "refused" | "unknown"> {
    if (!(await this.validateDestination(root, destination))) return "refused";
    const stat = await lstat(stage);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      !sameIdentity(stat, identity)
    )
      return "refused";
    if (!admit()) return "refused";
    return this.options.moveNoReplace(stage, destination);
  }
  async writersStopped(root: string): Promise<boolean> {
    return this.options.stopped(root);
  }
}

/** Linux real-syscall fixture adapter. Caller compiles the checked-in bounded
 * helper into a disposable directory and supplies observed supervised exit.
 * This exercises Linux disk/publication behavior only; it does not establish
 * macOS/Windows conformance or eliminate Node's pre-publication path limitations.
 */
export class LinuxFixtureNativeAdapter extends PosixFixtureNativeAdapter {
  constructor(options: { helper: string; stopped: (root: string) => Promise<boolean> }) {
    const state = { active: 0 };
    const call = async (args: string[]) => {
      state.active++;
      try {
        return await helperCall(options.helper, args);
      } finally {
        state.active--;
      }
    };
    super({
      stopped: async (root) => state.active === 0 && (await options.stopped(root)),
      moveNoReplace: async (source, destination) => {
        const stat = await lstat(source);
        try {
          const result = await call(["move", dirname(source), destination, String(stat.dev), String(stat.ino)]);
          return result === "saved" || result === "refused" ? result : "unknown";
        } catch {
          return "unknown";
        }
      },
    });
    this.verify = (root) => call(["verify", root]);
  }
  private readonly verify: (root: string) => Promise<string>;
  override async verifyRoot(root: string): Promise<boolean> {
    if (process.platform !== "linux" || !(await super.verifyRoot(root))) return false;
    try {
      return (await this.verify(root)) === "verified";
    } catch {
      return false;
    }
  }
}

export async function readLinuxBootClock(helper: string): Promise<BootReading | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const fields = (await helperCall(helper, ["clock"])).split(" ");
    const reading = { bootId: fields[0] ?? "", elapsedMs: Number(fields[1]) };
    return fields.length === 2 && validReading(reading) ? reading : undefined;
  } catch {
    return undefined;
  }
}

function helperCall(helper: string, args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile(helper, args, { encoding: "utf8", maxBuffer: 1024, timeout: 10_000 }, (error, stdout) => {
      if (error) reject(new Error("unavailable"));
      else resolveResult(stdout.trim());
    });
  });
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
