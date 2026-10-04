/** Actual Linux fixture disk/crypto checks; synthetic keys are not native OS protection proof. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { NodeRecoveryDisk } from "../src/main/diagnostics/recovery-disk.js";
import {
  LinuxFixtureNativeAdapter,
  createProductionNativeAdapter,
  createSafeStorageKeyAdapter,
  readLinuxBootClock,
  type DiagnosticsKeyAdapter,
} from "../src/main/diagnostics/native-adapter.js";
import { RECOVERY_LIMITS } from "../src/main/diagnostics/recovery-contract.js";

const execute = promisify(execFile);
const linux = process.platform === "linux";
let suiteRoot: string;
let helper: string;
beforeAll(async () => {
  suiteRoot = await mkdtemp(join(tmpdir(), "orca-storage-"));
  helper = join(suiteRoot, "native");
  if (linux)
    await execute("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      fileURLToPath(new URL("../native/diagnostics/linux-fixture.c", import.meta.url)),
      "-o",
      helper,
    ]);
});
afterAll(async () => {
  if (suiteRoot) await rm(suiteRoot, { recursive: true, force: true });
});

function protectedKeys() {
  const protection = randomBytes(32);
  let lost = false;
  const keys: DiagnosticsKeyAdapter = {
    async available() {
      return !lost;
    },
    async wrap(bytes) {
      if (lost) throw new Error("unavailable");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", protection, nonce);
      const encrypted = cipher.update(bytes);
      cipher.final();
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    async unwrap(bytes) {
      if (lost) throw new Error("unavailable");
      const decipher = createDecipheriv("aes-256-gcm", protection, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const plaintext = decipher.update(bytes.subarray(28));
      decipher.final();
      return plaintext;
    },
  };
  return {
    keys,
    lose() {
      lost = true;
    },
  };
}
async function fixture() {
  const parent = await mkdtemp(join(suiteRoot, "case-"));
  const root = join(parent, "owned");
  const secrets = protectedKeys();
  const native = new LinuxFixtureNativeAdapter({ helper, stopped: async () => true });
  const disk = new NodeRecoveryDisk({ root, keys: secrets.keys, native });
  const now = (await readLinuxBootClock(helper))!;
  return { parent, root, ...secrets, native, disk, now };
}
async function enable(f: Awaited<ReturnType<typeof fixture>>) {
  await f.disk.writeSetting({ enabled: true, scopeVersion: 1, minutes: 5 });
  await f.disk.open(f.now);
}

describe.skipIf(!linux)("bounded Linux recovery disk", () => {
  it("creates no settings, wrappers, or reports before actual opt-in", async () => {
    const f = await fixture();
    expect(await f.disk.readSetting()).toEqual({ enabled: false, scopeVersion: 1, minutes: 5 });
    expect(await f.disk.readExportState()).toEqual({});
    await f.disk.cleanup();
    expect(await readdir(f.parent)).toEqual([]);
  });
  it("seals exact report and authenticates restart promotion after retired writer", async () => {
    const f = await fixture();
    await enable(f);
    const report = Buffer.from('{"approved":"unknown"}\n');
    await f.disk.checkpoint(report, f.now, () => true);
    const slot = (await readdir(f.root)).find((name) => name.endsWith(".bin"))!;
    expect((await readFile(join(f.root, slot))).includes(report)).toBe(false);
    // Explicit fixture retirement after all previous operations settled. Actual
    // SIGKILL/exit proof lives in the integration tests, not this retirement.
    await f.native.release(f.root);
    const next = new NodeRecoveryDisk({ root: f.root, keys: f.keys, native: f.native });
    expect(await next.open(f.now)).toBe(true);
    expect((await next.previous(f.now))?.bytes.equals(report)).toBe(true);
    await next.cleanExit();
  });
  it("repeated checkpoints never accumulate a fourth slot or key wrapper", async () => {
    const f = await fixture();
    await enable(f);
    const bytes = Buffer.alloc(RECOVERY_LIMITS.exportBytes, 120);
    for (let index = 0; index < 5; index++)
      await f.disk.checkpoint(bytes, { ...f.now, elapsedMs: f.now.elapsedMs + index }, () => true);
    const names = await readdir(f.root);
    expect(names.filter((name) => name.endsWith(".bin"))).toHaveLength(1);
    expect(names.filter((name) => name.startsWith("session-"))).toHaveLength(1);
    const sizes = await Promise.all(names.map(async (name) => (await stat(join(f.root, name))).size));
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(RECOVERY_LIMITS.retainedBytes);
    await expect(f.disk.checkpoint(Buffer.alloc(RECOVERY_LIMITS.exportBytes + 1), f.now, () => true)).rejects.toThrow(
      "capacity_limited",
    );
    await f.disk.cleanExit();
  });
  it("revocation during a real file write prevents manifest publication", async () => {
    const f = await fixture();
    await enable(f);
    const original = f.native.write.bind(f.native);
    let resolveWrite!: () => void;
    let observeWrite!: () => void;
    const started = new Promise<void>((resolve) => {
      observeWrite = resolve;
    });
    const release = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    f.native.write = async (file, bytes) => {
      await original(file, bytes);
      if (bytes.length > 500) {
        observeWrite();
        await release;
      }
    };
    let admitted = true;
    const pending = f.disk.checkpoint(Buffer.alloc(4096), f.now, () => admitted);
    await started;
    admitted = false;
    const disabled = f.disk.writeSetting({ enabled: false, scopeVersion: 1, minutes: 5 });
    resolveWrite();
    await expect(pending).rejects.toThrow("off");
    await disabled;
    const manifest = JSON.parse(await readFile(join(f.root, "manifest.json"), "utf8")) as {
      payload: { current?: unknown };
    };
    expect(manifest.payload.current).toBeUndefined();
    await f.disk.cleanup();
    await f.disk.cleanExit();
  });
  it("keeps lost-key cleanup separate from bounded content-free export metadata", async () => {
    const f = await fixture();
    await enable(f);
    await f.disk.checkpoint(Buffer.from("secret diagnostic report\n"), f.now, () => true);
    await f.disk.writeExportState({
      summary: { id: "old", outcome: "unknown", acknowledged: true, olderUnknowns: false },
    });
    f.lose();
    await f.disk.writeSetting({ enabled: false, scopeVersion: 1, minutes: 5 });
    await f.disk.cleanup();
    expect((await readdir(f.root)).sort()).toEqual(["setting.json", "writer.lock"]);
    await f.disk.cleanExit();
  });
  it.each(["symlink", "hardlink", "nonprivate"])(
    "opt-out removes diagnostics keys and ciphertext independently of unsafe fixed staging %s",
    async (fault) => {
      const f = await fixture();
      await enable(f);
      await f.disk.checkpoint(Buffer.from("secret diagnostic report\n"), f.now, () => true);
      await f.disk.writeExportState({ current: { id: "unresolved", phase: "intent" } });
      const identity = await f.disk.stageExport("unresolved", Buffer.from("approved preview\n"));
      const metadata = await readFile(join(f.root, "export.json"));
      const target = join(f.parent, "user-file");
      await writeFile(target, "unrelated user file", { mode: 0o600 });
      const stage = join(f.root, "export-stage.tmp");
      if (fault === "nonprivate") await chmod(stage, 0o644);
      else {
        await unlink(stage);
        if (fault === "symlink") await symlink(target, stage);
        else await link(target, stage);
      }
      const unsafe = await lstat(stage);
      await expect(f.disk.cleanup()).rejects.toThrow("cleanup_pending");
      expect((await readdir(f.root)).some((name) => name.startsWith("session-"))).toBe(true);
      f.lose();
      await f.disk.writeSetting({ enabled: false, scopeVersion: 1, minutes: 5 });
      await expect(f.disk.cleanup()).rejects.toThrow("cleanup_pending");
      expect((await readdir(f.root)).sort()).toEqual([
        "export-stage.tmp",
        "export.json",
        "setting.json",
        "writer.lock",
      ]);
      expect((await f.disk.readSetting()).enabled).toBe(false);
      expect(await readFile(join(f.root, "export.json"))).toEqual(metadata);
      expect(await readFile(target, "utf8")).toBe("unrelated user file");
      const preserved = await lstat(stage);
      expect([preserved.dev, preserved.ino, preserved.mode, preserved.nlink]).toEqual([
        unsafe.dev,
        unsafe.ino,
        unsafe.mode,
        unsafe.nlink,
      ]);
      await expect(f.disk.clearStage(identity)).rejects.toThrow("cleanup_pending");
      await expect(f.disk.writeSetting({ enabled: true, scopeVersion: 1, minutes: 5 })).rejects.toThrow(
        "cleanup_pending",
      );
      await expect(f.disk.writeExportState({})).rejects.toThrow("cleanup_pending");
      await expect(f.disk.publishStage(identity, join(f.parent, "report.json"), () => true)).rejects.toThrow(
        "cleanup_pending",
      );
      await expect(f.disk.checkpoint(Buffer.from("later report\n"), f.now, () => true)).rejects.toThrow("off");
      expect(await readFile(join(f.root, "export.json"))).toEqual(metadata);
      await f.disk.cleanExit();
    },
  );
  it("never relaxes unsafe-stage inspection without proven writer cessation", async () => {
    const f = await fixture();
    await enable(f);
    await f.disk.checkpoint(Buffer.from("secret diagnostic report\n"), f.now, () => true);
    const target = join(f.parent, "user-file");
    await writeFile(target, "unrelated user file", { mode: 0o600 });
    await symlink(target, join(f.root, "export-stage.tmp"));
    const before = (await readdir(f.root)).sort();
    f.native.writersStopped = async () => false;
    await expect(f.disk.writeSetting({ enabled: false, scopeVersion: 1, minutes: 5 })).rejects.toThrow(
      "cleanup_pending",
    );
    await expect(f.disk.cleanup()).rejects.toThrow("cleanup_pending");
    expect((await readdir(f.root)).sort()).toEqual(before);
    expect((await f.disk.readSetting()).enabled).toBe(true);
    expect(await readFile(target, "utf8")).toBe("unrelated user file");
    // Only the fixture retires its own settled lease; this is no cleanup success.
    await f.native.release(f.root);
  });
  it("requires a valid persisted off setting before preserving unsafe staging for cleanup", async () => {
    const f = await fixture();
    await enable(f);
    await f.disk.checkpoint(Buffer.from("secret diagnostic report\n"), f.now, () => true);
    await writeFile(join(f.root, "export-stage.tmp"), "residual", { mode: 0o644 });
    await writeFile(join(f.root, "setting.json"), '{"enabled":false,"scopeVersion":1,"minutes":99}');
    const before = (await readdir(f.root)).sort();
    await expect(f.disk.cleanup()).rejects.toThrow("cleanup_pending");
    expect((await readdir(f.root)).sort()).toEqual(before);
    await f.native.release(f.root);
  });
  it.each(["oversize-stage", "unsafe-other-entry", "stage-directory", "entry-limit"])(
    "unsafe-stage opt-out preserves strict %s validation and budgets",
    async (fault) => {
      const f = await fixture();
      await enable(f);
      await f.disk.checkpoint(Buffer.from("secret diagnostic report\n"), f.now, () => true);
      await f.disk.writeSetting({ enabled: false, scopeVersion: 1, minutes: 5 });
      const stage = join(f.root, "export-stage.tmp");
      if (fault === "stage-directory") {
        // A directory is not one of the narrow permitted file/link types.
        await mkdir(stage, { mode: 0o700 });
      } else {
        await writeFile(stage, "residual", { mode: 0o644 });
        if (fault === "oversize-stage") await truncate(stage, RECOVERY_LIMITS.exportBytes + 1);
        if (fault === "unsafe-other-entry") {
          const target = join(f.parent, "user-file");
          await writeFile(target, "unrelated user file", { mode: 0o600 });
          await symlink(target, join(f.root, "manifest.json.tmp"));
        }
        if (fault === "entry-limit") {
          for (const name of [
            "setting.json.tmp",
            "manifest.json.tmp",
            "control.key.tmp",
            "export.json",
            "export.json.tmp",
            "slot-1.bin",
            "session-1.key",
            "slot-2.bin",
            "session-2.key",
            "unexpected",
          ])
            await writeFile(join(f.root, name), "", { mode: 0o600 });
          expect(await readdir(f.root)).toHaveLength(RECOVERY_LIMITS.entries + 1);
        }
      }
      const before = (await readdir(f.root)).sort();
      await expect(f.disk.cleanup()).rejects.toThrow(
        fault === "oversize-stage" || fault === "entry-limit" ? "capacity_limited" : "cleanup_pending",
      );
      expect((await readdir(f.root)).sort()).toEqual(before);
      if (fault === "oversize-stage")
        await expect(f.disk.writeSetting({ enabled: false, scopeVersion: 1, minutes: 5 })).rejects.toThrow(
          "capacity_limited",
        );
      await f.native.release(f.root);
    },
  );
  it("commits stage identity before plaintext and natively preserves existing destination", async () => {
    const f = await fixture();
    await enable(f);
    await f.disk.writeExportState({ current: { id: "operation", phase: "intent" } });
    const original = f.native.write.bind(f.native);
    let inspected = false;
    f.native.write = async (file, bytes) => {
      if (bytes.toString() === "exact\n") {
        const state = JSON.parse(await readFile(join(f.root, "export.json"), "utf8")) as {
          current: { stage?: unknown };
        };
        expect(state.current.stage).toBeDefined();
        expect((await stat(join(f.root, "export-stage.tmp"))).size).toBe(0);
        inspected = true;
      }
      await original(file, bytes);
    };
    const identity = await f.disk.stageExport("operation", Buffer.from("exact\n"));
    expect(inspected).toBe(true);
    const destination = join(f.parent, "report.json");
    expect(await f.disk.validateDestination(destination)).toBe(true);
    await writeFile(destination, "user-owned", { mode: 0o600 });
    expect(await f.disk.publishStage(identity, destination, () => true)).toBe("refused");
    expect(await readFile(destination, "utf8")).toBe("user-owned");
    await f.disk.clearStage(identity);
    await f.disk.writeExportState({});
    await f.disk.cleanExit();
  });
  it("publishes a same-filesystem exact copy without leaving private plaintext", async () => {
    const f = await fixture();
    await enable(f);
    const bytes = Buffer.from("exact content, omissions and final newline\n");
    await f.disk.writeExportState({ current: { id: "new", phase: "intent" } });
    const identity = await f.disk.stageExport("new", bytes);
    const destination = join(f.parent, "report.json");
    expect(await f.disk.publishStage(identity, destination, () => true)).toBe("saved");
    expect((await readFile(destination)).equals(bytes)).toBe(true);
    expect(await readdir(f.root)).not.toContain("export-stage.tmp");
    await f.disk.writeExportState({});
    await f.disk.cleanExit();
    expect((await readFile(destination)).equals(bytes)).toBe(true);
  });
  it("refuses unexpected files and symlinks without traversing or deleting targets", async () => {
    const f = await fixture();
    await enable(f);
    const target = join(f.parent, "user-file");
    await writeFile(target, "retained");
    await symlink(target, join(f.root, "slot-0.bin"));
    await expect(f.disk.cleanup()).rejects.toThrow("cleanup_pending");
    expect(await readFile(target, "utf8")).toBe("retained");
    await rm(join(f.root, "slot-0.bin"));
    await f.disk.cleanup();
    await f.disk.cleanExit();
  });
  it("refuses a second writer even if a fixture callback incorrectly claims cessation", async () => {
    const f = await fixture();
    await enable(f);
    const second = new NodeRecoveryDisk({
      root: f.root,
      keys: f.keys,
      native: new LinuxFixtureNativeAdapter({ helper, stopped: async () => true }),
    });
    await expect(second.open(f.now)).rejects.toThrow("unavailable");
    await f.disk.cleanExit();
  });
  it("bounds cleanup records and refuses content-bearing metadata", async () => {
    const f = await fixture();
    await enable(f);
    await f.disk.writeExportState({
      summary: { id: "unknown", outcome: "unknown", acknowledged: true, olderUnknowns: true },
    });
    const bytes = await readFile(join(f.root, "export.json"));
    expect(bytes.length * 2).toBeLessThanOrEqual(RECOVERY_LIMITS.cleanupBytes);
    expect(bytes.toString()).not.toMatch(/destination|hash|timestamp|key/);
    await expect(f.disk.writeExportState({ current: { id: "a".repeat(65), phase: "intent" } })).rejects.toThrow(
      "cleanup_pending",
    );
    await f.disk.cleanExit();
  });
});

it("production native adapter and unsupported protection stay closed", async () => {
  expect(await createProductionNativeAdapter().verifyRoot("/tmp/unused")).toBe(false);
  const adapter = createSafeStorageKeyAdapter(
    {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async () => Buffer.alloc(0),
      decryptStringAsync: async () => ({ result: "", shouldReEncrypt: false }),
    },
    "linux",
  );
  expect(await adapter.available()).toBe(false);
  await expect(adapter.wrap(Buffer.alloc(32))).rejects.toThrow("unavailable");
});
it("provider rotation flag refuses recovery without silently rewrapping", async () => {
  const adapter = createSafeStorageKeyAdapter(
    {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async () => Buffer.alloc(0),
      decryptStringAsync: async () => ({ result: "eA==", shouldReEncrypt: true }),
    },
    "darwin",
  );
  await expect(adapter.unwrap(Buffer.from("wrapped"))).rejects.toThrow("unavailable");
});
