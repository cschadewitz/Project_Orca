/** Node-only first-run lifetime fence. Never exported from the renderer protocol barrel. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import {
  windowsDirectory,
  windowsRead,
  windowsWrite,
  windowsPrivateChild,
  windowsLock,
  windowsBoot,
} from "./first-run-windows.js";
export { windowsDirectory, windowsRead, windowsWrite, windowsPrivateChild, windowsFile } from "./first-run-windows.js";

export const fenceHash = (text: string) => createHash("sha256").update(text).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const FenceDirectorySchema = z
  .object({ path: z.string(), dev: z.string(), ino: z.string(), uid: z.string() })
  .strict();
export const FenceBootSchema = z
  .object({ bootId: z.string().uuid(), hostHash: digest, kernelDomain: z.string().min(1) })
  .strict();
export const WriterSchema = z
  .object({
    version: z.literal(1),
    contract: z.literal("kernel-lifetime-v1"),
    reservationId: z.string().uuid(),
    claimHash: digest,
    workspace: FenceDirectorySchema,
    store: FenceDirectorySchema,
    processId: z.number().int().positive(),
    generation: z.string().uuid(),
    bootId: z.string().uuid(),
    hostHash: digest,
    kernelDomain: z.string().min(1),
  })
  .strict();
export type FirstRunWriter = z.infer<typeof WriterSchema>;
export function fenceDirectory(path: string) {
  if (process.platform === "win32") return windowsDirectory(path);
  const s = lstatSync(path, { bigint: true });
  if (
    !s.isDirectory() ||
    realpathSync(path) !== path ||
    typeof process.getuid !== "function" ||
    s.uid !== BigInt(process.getuid()) ||
    s.ino <= 0n
  )
    throw new Error("First-run fence directory unavailable");
  return { path, dev: String(s.dev), ino: String(s.ino), uid: String(s.uid) };
}
export function fenceRead(path: string, limit = 4096): string {
  if (process.platform === "win32") return windowsRead(path, limit);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.size > limit ||
      typeof process.getuid !== "function" ||
      s.uid !== process.getuid()
    )
      throw new Error("First-run fence evidence unavailable");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
export function fenceWrite(path: string, value: unknown) {
  if (process.platform === "win32") return windowsWrite(path, JSON.stringify(value) + "\n");
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
export function fenceBoot() {
  if (process.platform === "win32") {
    const { bootId, machine } = windowsBoot();
    return FenceBootSchema.parse({ bootId, hostHash: fenceHash(machine), kernelDomain: "win32:host" });
  }
  const domain = process.platform === "linux" ? statSync("/proc/self/ns/net", { bigint: true }) : undefined;
  const kernelDomain = domain ? `${domain.dev}:${domain.ino}` : "host";
  if (process.platform === "linux") {
    const machine = readFileSync("/etc/machine-id", "utf8").trim();
    if (!/^[a-f0-9]{32}$/.test(machine) || /^0+$/.test(machine)) throw new Error("Host identity unavailable");
    return FenceBootSchema.parse({
      kernelDomain,
      bootId: z.string().uuid().parse(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()),
      hostHash: fenceHash(machine),
    });
  }
  if (process.platform === "darwin") {
    const run = (file: string, args: string[]) =>
      execFileSync(file, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {},
        timeout: 2000,
        maxBuffer: 65536,
      }).trim();
    const machine = /"IOPlatformUUID"\s*=\s*"([0-9a-f-]{36})"/i.exec(
      run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]),
    )?.[1];
    return FenceBootSchema.parse({
      kernelDomain,
      bootId: z
        .string()
        .uuid()
        .parse(run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]).toLowerCase()),
      hostHash: fenceHash(z.string().uuid().parse(machine?.toLowerCase())),
    });
  }
  throw new Error("First-run fence platform unavailable");
}
/** Local single-host volumes only. Overlay permits disposable Linux reference tests. */
export function assertFenceVolume(path: string) {
  if (process.platform === "win32") {
    windowsDirectory(path);
    return;
  }
  if (process.platform === "linux" && [0xef53, 0x58465342, 0x9123683e, 0x794c7630].includes(statfsSync(path).type))
    return;
  if (process.platform === "darwin") {
    const text = execFileSync("/usr/sbin/diskutil", ["info", "-plist", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {},
      timeout: 2000,
      maxBuffer: 65536,
    });
    if (
      /<key>Internal<\/key>\s*<true\s*\/>/.test(text) &&
      /<key>FilesystemType<\/key>\s*<string>apfs<\/string>/.test(text)
    )
      return;
  }
  throw new Error("First-run fence volume unavailable");
}
/** Hash collisions only refuse another store. No random alternate port or namespace fallback. */
export function fencePort(workspace: z.infer<typeof FenceDirectorySchema>) {
  return 20000 + (Number.parseInt(fenceHash(JSON.stringify(workspace)).slice(0, 8), 16) % 40000);
}
export async function acquireFirstRunFence(
  workspace: z.infer<typeof FenceDirectorySchema>,
  observation: () => unknown,
): Promise<Server & { retainLifetime?(): void }> {
  const lock = process.platform === "win32" ? windowsLock(workspace) : undefined;
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.end(JSON.stringify(observation()) + "\n", () => socket.destroy());
  });
  server.maxConnections = 8;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: fencePort(workspace), exclusive: true, reusePort: false }, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    lock?.release();
    throw error;
  }
  if (lock) {
    server.once("close", () => lock.release());
    (server as Server & { retainLifetime(): void }).retainLifetime = () => lock.retain();
  }
  // The writer's socket can never be closed by an RPC or cleanup callback. Kernel releases it at exit.
  // Unref permits one-shot commands to exit naturally after all actual work finishes.
  server.unref();
  return server;
}
export async function observeFirstRunFence(workspace: z.infer<typeof FenceDirectorySchema>): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: fencePort(workspace) });
    let data = "",
      done = false;
    const finish = (value: unknown) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000, () => finish(undefined));
    socket.on("error", () => finish(undefined));
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (Buffer.byteLength(data) > 4096) finish(undefined);
    });
    socket.on("end", () => {
      try {
        finish(JSON.parse(data));
      } catch {
        finish(undefined);
      }
    });
  });
}
/** The journal's attempt directories, oldest first, or undefined when its layout is not one the app writes.
 * The app folds settled history into a checkpoint, so numbering may start after 000001 once one exists; checkpoint and
 * folded-attempt entries are compaction state, never an attempt. The app's inspection verifies the chain itself. */
export function firstRunAttempts(journal: string): string[] | undefined {
  const names = readdirSync(journal).sort();
  const attempts = names.filter((name) => /^[0-9]{6}$/.test(name));
  const start = Number(attempts[0]);
  if (
    !attempts.length ||
    names.length >= 256 ||
    names.some((name) => !/^(?:[0-9]{6}|checkpoint-[0-9]{6}\.(?:json|pending)|discarded-[0-9]{6})$/.test(name)) ||
    (start !== 1 && !names.some((name) => /^checkpoint-[0-9]{6}\.json$/.test(name))) ||
    attempts.some((name, i) => name !== String(start + i).padStart(6, "0"))
  )
    return undefined;
  return attempts;
}
/**
 * What a first-run writer holds once {@link enterFirstRunWriter} admits it, for checks only: it
 * has no release or close capability. `check()` is true only while this process still holds the
 * workspace's kernel-lifetime fence (no other participating writer can enter), its attempt is
 * still the journal's latest with this writer recorded, and the store is the same directory the
 * claim bound. Store carryover (#897) requires it to hold before, during and after the copy.
 */
export interface FirstRunWriterHold {
  readonly workspace: z.infer<typeof FenceDirectorySchema>;
  readonly store: z.infer<typeof FenceDirectorySchema>;
  readonly storeDir: string;
  readonly reservationId: string;
  /** This writer's own claim, and the claim immediately before it in the journal (none for the first). */
  readonly claimHash: string;
  readonly previous: string | null;
  check(): boolean;
}
/** All CLI/bootstrap routes refuse first-run stores without the main-only launch capability.
 * Returns the writer's hold for a first-run store, `undefined` for any other store. */
export async function enterFirstRunWriter(
  configDir: string,
  storeDir: string,
  token: string | undefined,
): Promise<FirstRunWriterHold | undefined> {
  let path = realpathSync(configDir);
  let root: string | undefined;
  for (let depth = 0; depth < 256; depth++) {
    if (exists(join(path, ".orca-first-run-ownership")) || exists(join(path, ".orca-first-run-ownership.json"))) {
      root = path;
      break;
    }
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  // A programmatic/store alias outside the config root cannot bypass the journal.
  if (!root) {
    path = storeDir;
    while (!exists(path)) {
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
    path = realpathSync(path);
    for (let depth = 0; depth < 256; depth++) {
      if (exists(join(path, ".orca-first-run-ownership")) || exists(join(path, ".orca-first-run-ownership.json")))
        throw new Error("First-run writer requires the selected configuration");
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
    return;
  }
  if (root !== configDir || storeDir !== join(root, ".orca") || !token)
    throw new Error("First-run writer requires an owned launch capability");
  const workspace = fenceDirectory(root);
  assertFenceVolume(root);
  let writer: FirstRunWriter | undefined;
  const fence = await acquireFirstRunFence(workspace, () => (writer ? fenceHash(JSON.stringify(writer)) : undefined));
  try {
    // Read after acquiring: a delayed pre-recovery child cannot enter the retired attempt.
    const journal = join(root, ".orca-first-run-ownership");
    const anchor = z
      .object({ version: z.literal(1), workspace: FenceDirectorySchema, journal: FenceDirectorySchema })
      .strict()
      .parse(JSON.parse(fenceRead(join(root, ".orca-first-run-ownership.json"))));
    if (
      JSON.stringify(anchor.workspace) !== JSON.stringify(workspace) ||
      JSON.stringify(anchor.journal) !== JSON.stringify(fenceDirectory(journal))
    )
      throw new Error("First-run anchor changed");
    const names = firstRunAttempts(journal);
    if (!names) throw new Error("First-run attempt unavailable");
    const attempt = join(journal, names.at(-1)!);
    fenceDirectory(attempt);
    const claimText = fenceRead(join(attempt, "claim.json"));
    const claim = z
      .object({
        version: z.literal(2),
        reservationId: z.string().uuid(),
        workspace: FenceDirectorySchema,
        configHash: digest,
        previous: digest.nullable(),
        launchHash: digest,
        fence: z.literal("kernel-lifetime-v1"),
        boot: FenceBootSchema,
        store: FenceDirectorySchema.nullable(),
      })
      .strict()
      .parse(JSON.parse(claimText));
    const entries = readdirSync(attempt);
    if (
      entries.join(",") !== "claim.json" ||
      claim.launchHash !== fenceHash(token) ||
      claim.configHash !== fenceHash(fenceRead(join(root, "orca.config.yaml"), 1024 * 1024)) ||
      JSON.stringify(claim.workspace) !== JSON.stringify(workspace) ||
      JSON.stringify(claim.boot) !== JSON.stringify(fenceBoot())
    )
      throw new Error("First-run launch no longer authorized");
    if ((claim.store === null) !== !exists(storeDir)) throw new Error("First-run store changed before launch");
    if (claim.store && JSON.stringify(claim.store) !== JSON.stringify(fenceDirectory(storeDir)))
      throw new Error("First-run store identity changed");
    if (!exists(storeDir)) {
      if (process.platform === "win32") windowsPrivateChild(storeDir);
      else {
        mkdirSync(storeDir, { mode: 0o700 });
        const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    }
    const store = fenceDirectory(storeDir);
    if (store.dev !== workspace.dev) throw new Error("First-run store volume changed");
    writer = WriterSchema.parse({
      version: 1,
      contract: "kernel-lifetime-v1",
      reservationId: claim.reservationId,
      claimHash: fenceHash(claimText),
      workspace,
      store,
      processId: process.pid,
      generation: randomUUID(),
      ...fenceBoot(),
    });
    fenceWrite(join(attempt, "writer.json"), writer);
    fence.retainLifetime?.();
    // Do not return a close/release capability to the runtime.
    const writerText = JSON.stringify(writer) + "\n";
    const attemptName = names.at(-1)!;
    const held = writer;
    const owned = root;
    return {
      workspace,
      store,
      storeDir,
      reservationId: claim.reservationId,
      claimHash: held.claimHash,
      previous: claim.previous,
      check() {
        try {
          return (
            fence.listening &&
            JSON.stringify(fenceDirectory(owned)) === JSON.stringify(workspace) &&
            JSON.stringify(fenceDirectory(storeDir)) === JSON.stringify(store) &&
            firstRunAttempts(journal)?.at(-1) === attemptName &&
            fenceRead(join(attempt, "claim.json")) === claimText &&
            fenceRead(join(attempt, "writer.json")) === writerText
          );
        } catch {
          return false;
        }
      },
    };
  } catch (error) {
    await new Promise<void>((resolve) => fence.close(() => resolve()));
    throw error;
  }
}
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Paths may be aliases or nested cwd values. Direct auth/demo mutations cannot bypass lifetime admission. */
export function assertNoUnownedFirstRunMutation(input: string): void {
  let path = input;
  while (!exists(path)) {
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  path = realpathSync(path);
  for (let depth = 0; depth < 256; depth++) {
    if (exists(join(path, ".orca-first-run-ownership")) || exists(join(path, ".orca-first-run-ownership.json")))
      throw new Error("First-run mutation requires owned daemon admission");
    const parent = dirname(path);
    if (parent === path) return;
    path = parent;
  }
  throw new Error("First-run mutation identity unavailable");
}
