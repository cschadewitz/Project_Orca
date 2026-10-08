/** Portable protocol/disabled composition plus the exact Linux syscall core. */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { createDiagnosticsInitializer } from "../src/main/diagnostics/initialize.js";
import { createHandleRelativeStorage, loadNativeDiagnosticsStorage } from "../src/main/diagnostics/native-storage.js";
import type { NativeStorageBackend } from "../src/main/diagnostics/native-storage.js";

it("serializes native work and retains ownership until a delayed operation settles", async () => {
  const held = {};
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = vi.fn<NativeStorageBackend["call"]>(async (operation) => {
    if (operation === "openRoot") return held;
    if (operation === "rootStat") return { dev: 1n, ino: 2n, uid: 0, mode: 0o40700, nlink: 1, size: 0, kind: 2 };
    if (operation === "remove") await wait;
    return undefined;
  });
  const root = join(tmpdir(), "orca-native-port-fixture");
  const storage = createHandleRelativeStorage(root, { abi: 1, platform: "posix-fixture", call });
  expect(await storage.native.verifyRoot(root)).toBe(true);
  const pending = storage.native.remove(join(root, "setting.json"));
  const closed = storage.close();
  await vi.waitFor(() => expect(call.mock.calls.some((args) => args[0] === "remove")).toBe(true));
  expect(call.mock.calls.some((args) => args[0] === "closeRoot")).toBe(false);
  release();
  await pending;
  await closed;
  expect(call.mock.calls.map((args) => args[0])).toEqual(["openRoot", "rootStat", "remove", "closeRoot"]);
  await expect(storage.files.lstat(root)).rejects.toThrow("unavailable");
});

it.runIf(process.platform !== "darwin")(
  "fixed production loader and initializer remain unavailable without file/key/picker work",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "orca-disabled-native-"));
    try {
      const root = join(directory, "diagnostics");
      const available = vi.fn(async () => true);
      const encrypt = vi.fn(async () => Buffer.from("unused"));
      const decrypt = vi.fn(async () => ({ result: "unused", shouldReEncrypt: false }));
      const picker = vi.fn(async () => join(directory, "report.json"));
      const fixture = createDiagnosticsInitializer({
        root,
        safeStorage: {
          isAsyncEncryptionAvailable: available,
          encryptStringAsync: encrypt,
          decryptStringAsync: decrypt,
        },
        chooseDestination: picker,
      });
      await fixture.initialize();
      fixture.startupObserver("startup_spawn_failed");
      expect(fixture.controller.status()).toMatchObject({ enabled: false, productionEnabled: false });
      expect(fixture.controller.record("startup", "startup_spawn_failed")).toBe(false);
      expect(await loadNativeDiagnosticsStorage(root).native.verifyRoot(root)).toBe(false);
      await fixture.close();
      expect(available).not.toHaveBeenCalled();
      expect(encrypt).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();
      expect(picker).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === "linux")(
  "compiles and exercises actual handle-relative syscalls, lock exclusion, unsafe files, no-clobber and parent replacement",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "orca-storage-syscalls-"));
    try {
      const executable = join(directory, "fixture");
      const source = fileURLToPath(new URL("./recovery-preparation/native-storage-syscalls.c", import.meta.url));
      const run = promisify(execFile);
      await run("/usr/bin/cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", executable], {
        timeout: 10_000,
        maxBuffer: 4096,
      });
      const result = await run(executable, [directory], { timeout: 10_000, maxBuffer: 1024 });
      expect(result.stdout).toBe("native storage syscall fixture passed\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
