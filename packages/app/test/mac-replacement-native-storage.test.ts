/** Opt-in exact native Node-API journal faults. Linux/synthetic keys are not Mac acceptance. */
import { execFile, spawn } from "node:child_process";
import { constants, mkdirSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHandleRelativeStorage, type NativeStorageBackend } from "../src/main/diagnostics/native-storage.js";
import { createMacReplacementStartup, createNativeMacReplacementStartup } from "../src/main/mac-replacement-startup.js";
import { MacReplacementBootstrap } from "../src/main/mac-replacement-recovery.js";
import type { MacReplacementRecord } from "../src/main/mac-replacement-journal.js";
import { SyntheticKeys } from "./recovery-preparation/implementation-fixture.js";

const headers = process.env.ORCA_REPLACEMENT_NATIVE_TEST_HEADERS;
const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "orca-replacement-native-"));
  roots.push(root);
  return root;
}
function record(): MacReplacementRecord {
  const pair = {
    id: randomUUID(),
    manifestSha256: "a".repeat(64),
    binarySha256: "b".repeat(64),
    stateSha256: "c".repeat(64),
    // More than the diagnostics control-file 4 KiB limit; pair observations are synthetic.
    roots: Array.from({ length: 32 }, (_, i) => ({ id: `root-${i}-${"x".repeat(80)}`, sha256: "d".repeat(64) })),
    continuitySha256: "e".repeat(64),
    writerEpoch: randomUUID(),
    writeRevision: 7,
  };
  return {
    version: 1,
    id: randomUUID(),
    fenceId: randomUUID(),
    token: randomUUID(),
    previousTarget: { workspaceId: randomUUID(), instanceId: randomUUID(), processId: 12345 },
    candidate: {
      manifestSha256: "f".repeat(64),
      channel: "synthetic-fixture",
      compatibilityPlanId: "synthetic-fixture",
      recoveryPlanId: "synthetic-fixture",
    },
    rootIds: pair.roots.map((root) => root.id),
    phase: "closed",
    previous: pair,
  };
}

it("seals an earlier clear bootstrap before any replacement commit dispatch", async () => {
  let finish!: () => void;
  const pending = new Promise<undefined>((resolve) => {
    finish = () => resolve(undefined);
  });
  const bootstrap = new MacReplacementBootstrap({ read: () => pending });
  const read = bootstrap.inspect();
  expect(bootstrap.ordinaryAllowed).toBe(false);
  bootstrap.seal();
  finish();
  expect(await read).toEqual({ outcome: "unknown" });
  expect(bootstrap.ordinaryAllowed).toBe(false);
  expect(await bootstrap.inspect()).toEqual({ outcome: "unknown" });
});

it.runIf(process.platform !== "darwin")(
  "the native production composition stays closed on unsupported platforms",
  async () => {
    const parent = await directory();
    const available = vi.fn(async () => true);
    const startup = createNativeMacReplacementStartup({
      root: join(parent, "updater"),
      safeStorage: {
        isAsyncEncryptionAvailable: available,
        encryptStringAsync: vi.fn(async () => Buffer.from("unused")),
        decryptStringAsync: vi.fn(async () => ({ result: "unused", shouldReEncrypt: false })),
      },
    });
    expect(startup.bootstrap.ordinaryAllowed).toBe(false);
    expect(await startup.bootstrap.inspect()).toEqual({ outcome: "unknown" });
    expect(startup.bootstrap.ordinaryAllowed).toBe(false);
    await startup.close();
    expect(await readdir(parent)).toEqual([]);
    expect(available).not.toHaveBeenCalled();
  },
);

describe.runIf(process.platform === "linux" && headers)("disposable native replacement syscall/Node-API path", () => {
  let backend: NativeStorageBackend;
  let build: string;
  let addon: string;
  beforeAll(async () => {
    build = await mkdtemp(join(tmpdir(), "orca-replacement-addon-"));
    addon = join(build, "storage.node");
    const source = fileURLToPath(new URL("../native/diagnostics/storage.c", import.meta.url));
    await promisify(execFile)(
      "/usr/bin/cc",
      [
        "-shared",
        "-fPIC",
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-DNAPI_VERSION=8",
        "-I",
        headers!,
        source,
        "-o",
        addon,
      ],
      { timeout: 10_000, maxBuffer: 4096 },
    );
    backend = createRequire(import.meta.url)(addon) as NativeStorageBackend;
    expect(backend).toMatchObject({ abi: 1, platform: "posix-fixture", replacementStorage: 1 });
  });
  afterAll(async () => {
    if (build) await rm(build, { recursive: true, force: true });
  });
  function startup(root: string, adapter = backend) {
    // Explicit provisioning of disposable fixture state; production never creates a lost root.
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const storage = createHandleRelativeStorage(root, adapter, "replacement");
    const owner = createMacReplacementStartup(root, { ...storage, keys: new SyntheticKeys() });
    closers.push(() => owner.close());
    return { ...owner, storage };
  }
  it("a missing updater root remains unknown without recreating lost recovery authority", async () => {
    const parent = await directory(),
      root = join(parent, "missing-updater");
    const storage = createHandleRelativeStorage(root, backend, "replacement");
    const owner = createMacReplacementStartup(root, { ...storage, keys: new SyntheticKeys() });
    closers.push(() => owner.close());
    expect(await owner.bootstrap.inspect()).toEqual({ outcome: "unknown" });
    expect(owner.bootstrap.ordinaryAllowed).toBe(false);
    expect(await readdir(parent)).toEqual([]);
  });
  it("persists an encrypted >4 KiB identity and keeps fresh bootstrap closed across normal quit", async () => {
    const root = join(await directory(), "updater");
    const first = startup(root);
    expect(first.bootstrap.ordinaryAllowed).toBe(false);
    expect(await first.bootstrap.inspect()).toEqual({ outcome: "ordinary" });
    expect(first.bootstrap.ordinaryAllowed).toBe(true);
    const saved = record();
    const commit = first.journal.commit(saved);
    expect(first.bootstrap.ordinaryAllowed).toBe(false); // synchronous, before native await
    expect(await first.bootstrap.inspect()).toEqual({ outcome: "unknown" });
    await commit;
    const bytes = await readFile(join(root, "replacement.enc"));
    expect(bytes.length).toBeGreaterThan(4096);
    expect(bytes.includes(Buffer.from(saved.token))).toBe(false);
    expect(await readdir(root)).toEqual(["replacement.enc", "writer.lock"]);
    await first.close();
    const next = startup(root);
    expect(await next.bootstrap.inspect()).toEqual({ outcome: "replacement-closed", record: saved });
    expect(next.bootstrap.ordinaryAllowed).toBe(false);
    expect(await next.journal.read()).toEqual(saved);
  });
  it("refuses competing journal handles, retaining the first owner and durable identity", async () => {
    const root = join(await directory(), "updater");
    const first = startup(root);
    await first.journal.commit(record());
    const rival = startup(root);
    expect(await rival.bootstrap.inspect()).toEqual({ outcome: "unknown" });
    expect(rival.bootstrap.ordinaryAllowed).toBe(false);
    expect(await first.journal.read()).toBeDefined();
    await first.close();
    // A failed instance is sealed; only a fresh session can inspect the retained journal.
    expect(await rival.bootstrap.inspect()).toEqual({ outcome: "unknown" });
    const fresh = startup(root);
    expect(await fresh.bootstrap.inspect()).toMatchObject({ outcome: "replacement-closed" });
  });
  it.each(["before-rename", "after-rename"])(
    "lost %s acknowledgement preserves evidence and refuses fresh ordinary startup",
    async (edge) => {
      const root = join(await directory(), "updater");
      const adapter: NativeStorageBackend = {
        ...backend,
        call: async (...args) => {
          if (args[0] === "replace" && edge === "before-rename") throw new Error("Synthetic interruption");
          const result = await backend.call(...args);
          if (args[0] === "replace" && edge === "after-rename") throw new Error("Synthetic lost acknowledgement");
          return result;
        },
      };
      const first = startup(root, adapter);
      await expect(first.journal.commit(record())).rejects.toThrow("unavailable");
      expect(first.bootstrap.ordinaryAllowed).toBe(false);
      await first.close();
      const names = await readdir(root);
      expect(names).toContain(edge === "before-rename" ? "replacement.tmp" : "replacement.enc");
      const next = startup(root);
      expect(await next.bootstrap.inspect()).toMatchObject({
        outcome: edge === "before-rename" ? "unknown" : "replacement-closed",
      });
      expect(next.bootstrap.ordinaryAllowed).toBe(false);
      expect(await readdir(root)).toEqual(names);
    },
  );
  it.each(["ciphertext", "key", "symlink", "hardlink", "permissions"])(
    "refuses %s damage without reset or evidence deletion",
    async (damage) => {
      const parent = await directory(),
        root = join(parent, "updater");
      const first = startup(root);
      await first.journal.commit(record());
      await first.close();
      const path = join(root, "replacement.enc");
      if (damage === "ciphertext" || damage === "key") {
        const bytes = await readFile(path);
        const offset = damage === "key" ? 4 : bytes.length - 1;
        bytes[offset] = bytes[offset]! ^ 1;
        await writeFile(path, bytes);
      } else if (damage === "symlink") {
        await rename(path, join(parent, "retained"));
        await symlink(join(parent, "retained"), path);
      } else if (damage === "hardlink") await link(path, join(parent, "alias"));
      else await chmod(path, 0o644);
      const names = await readdir(root);
      const next = startup(root);
      expect(await next.bootstrap.inspect()).toEqual({ outcome: "unknown" });
      expect(next.bootstrap.ordinaryAllowed).toBe(false);
      expect(await readdir(root)).toEqual(names);
    },
  );
  it("isolates namespaces, refuses evidence removal/export, and fails closed at the 40 KiB envelope bound", async () => {
    const parent = await directory(),
      root = join(parent, "updater");
    const first = startup(root);
    expect(await first.storage.native.acquire(root)).toBe(true);
    await expect(
      first.storage.files.open(
        join(root, "setting.json.tmp"),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      ),
    ).rejects.toThrow("unavailable");
    const file = await first.storage.files.open(
      join(root, "replacement.tmp"),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await expect(first.storage.native.write(file, Buffer.alloc(40961))).rejects.toThrow("unavailable");
    await file.close();
    await expect(first.storage.native.remove(join(root, "replacement.tmp"))).rejects.toThrow("unavailable");
    await expect(first.storage.native.validateDestination(root, join(parent, "export"))).rejects.toThrow("unavailable");
    await first.close();
    expect(await startup(root).bootstrap.inspect()).toEqual({ outcome: "unknown" });
    const diagnosticsRoot = join(parent, "diagnostics");
    const diagnostics = createHandleRelativeStorage(diagnosticsRoot, backend);
    closers.push(() => diagnostics.close());
    expect(await diagnostics.native.acquire(diagnosticsRoot)).toBe(true);
    await expect(
      diagnostics.files.open(
        join(diagnosticsRoot, "replacement.enc"),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      ),
    ).rejects.toThrow("unavailable");
    expect(() =>
      createHandleRelativeStorage(
        root,
        { ...backend, replacementStorage: undefined } as unknown as NativeStorageBackend,
        "replacement",
      ),
    ).toThrow("unavailable");
  });
  it("a root replaced while owned cannot redirect journal writes or reopen that owner", async () => {
    const parent = await directory(),
      root = join(parent, "updater");
    const first = startup(root);
    await first.journal.commit(record());
    await rename(root, join(parent, "retained"));
    await mkdir(root, { mode: 0o700 });
    await expect(first.journal.commit(record())).rejects.toThrow("unavailable");
    expect(first.bootstrap.ordinaryAllowed).toBe(false);
    expect(await readdir(root)).toEqual([]);
    expect(await readdir(join(parent, "retained"))).toContain("replacement.enc");
    await expect(first.close()).rejects.toThrow("unavailable");
  });
  it.each(["temp", "committed"])(
    "a process crash at %s retains closure and releases only its kernel lock",
    async (edge) => {
      const parent = await directory(),
        root = join(parent, "updater");
      const first = startup(root);
      await first.journal.commit(record());
      const envelope = join(parent, "synthetic-envelope");
      await writeFile(envelope, await readFile(join(root, "replacement.enc")), { mode: 0o600 });
      await first.close();
      const worker = join(parent, "worker.mjs");
      await writeFile(
        worker,
        `
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const backend = createRequire(import.meta.url)(process.argv[2]);
const root = await backend.call('openRoot', undefined, undefined, process.argv[3], 'replacement', undefined, 0, 0, 0);
await backend.call('acquire', root, undefined, '', '', undefined, 0, 0, 0);
const file = await backend.call('openCreate', root, undefined, 'replacement.tmp', '', undefined, 0, 0, 0);
const bytes = await readFile(process.argv[4]);
await backend.call('write', root, file, '', '', bytes, 0, bytes.length, 0);
await backend.call('sync', root, file, '', '', undefined, 0, 0, 0);
await backend.call('closeFile', root, file, '', '', undefined, 0, 0, 0);
if (process.argv[5] === 'committed') await backend.call('replace', root, undefined, 'replacement.tmp', 'replacement.enc', undefined, 0, 0, 0);
process.stdout.write('held\\n');
process.stdin.resume();
`,
      );
      const child = spawn(process.execPath, [worker, addon, root, envelope, edge], { stdio: ["pipe", "pipe", "pipe"] });
      closers.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          child.kill("SIGKILL");
          await exit;
        }
      });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Synthetic child exited before holding lock")));
        child.stdout.once("data", (bytes: Buffer) =>
          bytes.toString() === "held\n" ? resolve() : reject(new Error("Unexpected fixture output")),
        );
      });
      const rival = startup(root);
      expect(await rival.bootstrap.inspect()).toEqual({ outcome: "unknown" });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL"); // disposable fault process only
      await exited;
      const names = await readdir(root);
      expect(names).toContain(edge === "temp" ? "replacement.tmp" : "replacement.enc");
      const next = startup(root);
      expect(await next.bootstrap.inspect()).toMatchObject({
        outcome: edge === "temp" ? "unknown" : "replacement-closed",
      });
      expect(next.bootstrap.ordinaryAllowed).toBe(false);
      expect(await readdir(root)).toEqual(names);
    },
  );
});
