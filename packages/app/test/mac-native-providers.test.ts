/** Controlled native/Electron ports and disposable files, never Mac acceptance. */
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it as platformIt, vi } from "vitest";
import type { HelloResult } from "@orca/protocol";
import { AdmissionIntents } from "../src/main/admission-intents.js";
import { createManagedMacNativeProviders, type MacNativePolicyRecord } from "../src/main/mac-native-providers.js";
import { readMacManifest, sha256 } from "../src/main/mac-candidate-manifest.js";
import type { MacCandidateBinding } from "../src/main/mac-candidate-download.js";
import { DaemonClient } from "../src/client/daemon-client.js";
import type { BundledDaemonOptions, DaemonChild } from "../src/main/daemon-process.js";

// Native proofs need a macOS bundle path and POSIX private directories and files. Windows
// must refuse them, so cases that need them accepted skip Windows; refusal cases run everywhere.
const it = platformIt.skipIf(process.platform === "win32");
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orca-native-bindings-"));
  roots.push(root);
  const appRoot = join(root, "data"),
    control = join(root, "control");
  await mkdir(appRoot, { mode: 0o700 });
  await mkdir(control, { mode: 0o700 });
  const source = new URL("../../../tools/deploy/tests/native-mac/fixtures/valid/", import.meta.url);
  const manifest = readMacManifest(await readFile(new URL("delivery/native-mac-artifact.json", source)));
  manifest.kind = "candidate";
  manifest.signing.teamId = "Q2FP9UY5T4";
  const bytes = Buffer.from(JSON.stringify(manifest)),
    identity = await readFile(new URL("ORCA.app/Contents/Resources/orca-build.json", source));
  const binding: MacCandidateBinding = {
    manifest,
    source: "https://delivery.invalid/invited/",
    candidate: { manifestSha256: sha256(bytes), channel: "test", compatibilityPlanId: "test", recoveryPlanId: "test" },
  };
  const storage = {
    isEncryptionAvailable: vi.fn(() => true),
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptString: vi.fn((text: string) => Buffer.from(text)),
    decryptString: vi.fn((bytes: Buffer) => bytes.toString()),
    encryptStringAsync: vi.fn(async (text: string) => Buffer.from(text)),
    decryptStringAsync: vi.fn(async (bytes: Buffer) => ({ result: bytes.toString("base64"), shouldReEncrypt: false })),
  };
  const intents = new AdmissionIntents(join(appRoot, "admission-intents.enc"), storage);
  const permissions = { getMediaAccessStatus: vi.fn(() => "granted"), isTrustedAccessibilityClient: vi.fn(() => true) };
  const policy = vi.fn(async (): Promise<MacNativePolicyRecord | undefined> => ({
    manifestBytes: bytes,
    policy: { fixture: "controlled existing policy" },
  }));
  const encoded = { identityBase64: identity.toString("base64"), daemonSha256: manifest.identity.daemon.sha256 };
  const execute = vi.fn(async (_helper: string, request: unknown): Promise<unknown> => {
    const operation = (request as { operation: string }).operation;
    return operation === "image"
      ? { outcome: "verified", manifestSha256: sha256(bytes), ...encoded }
      : {
          outcome: "verified",
          manifestSha256: sha256(bytes),
          copies: ["dmg", "zip"].map((format) => ({ format, ...encoded })),
        };
  });
  const options = {
    appRoot,
    control,
    executable: () => join(root, "ORCA.app/Contents/MacOS/ORCA"),
    helper: () => "/controlled-native-helper",
    intents,
    storage,
    permissions: () => permissions,
  };
  const providers = createManagedMacNativeProviders({
    ...options,
    fixture: { platform: "darwin", arch: "arm64", execute },
  });
  return {
    root,
    appRoot,
    control,
    binding,
    bytes,
    encoded,
    policy,
    execute,
    storage,
    intents,
    permissions,
    options,
    providers,
  };
}
const signal = () => new AbortController().signal;

platformIt("unsupported native execution never reaches policy, OS storage, permissions or a child", async () => {
  const h = await fixture(),
    providers = createManagedMacNativeProviders({
      ...h.options,
      fixture: { platform: "linux", arch: "arm64", execute: h.execute },
    });
  expect(providers.binaryRoot()).toBeUndefined();
  expect(await providers.inspect(h.binding, h.root, h.policy, signal())).toEqual({ outcome: "unknown" });
  expect(await providers.verifyBinary(h.root, sha256(h.bytes), h.policy, signal())).toBe(false);
  await expect(providers.continuity(signal())).rejects.toThrow("unavailable");
  expect(h.policy).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.storage.isEncryptionAvailable).not.toHaveBeenCalled();
  expect(h.permissions.getMediaAccessStatus).not.toHaveBeenCalled();
});
it("uses independently pinned policy and both actual sealed-copy proofs", async () => {
  const h = await fixture();
  const result = await h.providers.inspect(h.binding, h.root, h.policy, signal());
  expect(result).toMatchObject({ outcome: "verified", manifestSha256: sha256(h.bytes) });
  expect(h.policy).toHaveBeenCalledWith(sha256(h.bytes), expect.any(AbortSignal));
  expect(h.execute).toHaveBeenCalledWith(
    "/controlled-native-helper",
    expect.objectContaining({ operation: "candidate", path: h.root, scratchParent: join(h.control, "inspection") }),
    expect.any(AbortSignal),
  );
  expect(await h.providers.verifyBinary(join(h.root, "saved-binary"), sha256(h.bytes), h.policy, signal())).toBe(true);
});
platformIt.each(["missing-policy", "wrong-pin", "duplicate-copy", "wrong-daemon", "wrong-identity", "extra-field"])(
  "refuses or retains unknown for %s without inferred trust",
  async (fault) => {
    const h = await fixture();
    if (fault === "missing-policy") h.policy.mockResolvedValue(undefined);
    if (fault === "wrong-pin") h.policy.mockResolvedValue({ manifestBytes: Buffer.from("changed"), policy: {} });
    if (!["missing-policy", "wrong-pin"].includes(fault))
      h.execute.mockResolvedValue({
        outcome: "verified",
        manifestSha256: sha256(h.bytes),
        copies: ["dmg", fault === "duplicate-copy" ? "dmg" : "zip"].map((format) => ({
          format,
          ...h.encoded,
          ...(fault === "wrong-daemon" ? { daemonSha256: "f".repeat(64) } : {}),
          ...(fault === "wrong-identity" ? { identityBase64: Buffer.from("{}").toString("base64") } : {}),
        })),
        ...(fault === "extra-field" ? { path: "/private" } : {}),
      });
    expect((await h.providers.inspect(h.binding, h.root, h.policy, signal())).outcome).not.toBe("verified");
    if (["missing-policy", "wrong-pin"].includes(fault)) expect(h.execute).not.toHaveBeenCalled();
  },
);
it("joins cancelled native cleanup and discards the late positive proof", async () => {
  const h = await fixture(),
    controller = new AbortController();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((done) => {
      entered = done;
    }),
    wait = new Promise<void>((done) => {
      release = done;
    });
  const previous = h.execute.getMockImplementation()!;
  h.execute.mockImplementation(async (...args) => {
    entered();
    await wait;
    return previous(...args);
  });
  let settled = false;
  const operation = h.providers.inspect(h.binding, h.root, h.policy, controller.signal).finally(() => {
    settled = true;
  });
  await ready;
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  expect(await operation).toEqual({ outcome: "unknown" });
});
it("continuity reads existing intent/key wrappers and OS grants without encryption or permission prompts", async () => {
  const h = await fixture();
  h.intents.retain({ target: "local", principalId: "owner", workspaceId: "workspace" }, "flow");
  h.storage.encryptString.mockClear();
  const diagnostics = join(h.appRoot, "diagnostics");
  await mkdir(diagnostics, { mode: 0o700 });
  const envelope = Buffer.from(
    JSON.stringify({
      version: 1,
      purpose: "control",
      epoch: "epoch",
      keyId: "epoch",
      sessionId: "",
      key: Buffer.alloc(32, 1).toString("base64"),
    }),
  );
  await writeFile(join(diagnostics, "control.key"), envelope, { mode: 0o600 });
  const first = await h.providers.continuity(signal());
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(await h.providers.continuity(signal())).toBe(first);
  expect(await readFile(join(diagnostics, "control.key"))).toEqual(envelope);
  expect(h.storage.encryptString).not.toHaveBeenCalled();
  expect(h.storage.encryptStringAsync).not.toHaveBeenCalled();
  expect(h.permissions.isTrustedAccessibilityClient).toHaveBeenCalledWith(false);
  h.permissions.getMediaAccessStatus.mockReturnValue("denied");
  expect(await h.providers.continuity(signal())).not.toBe(first);
  h.storage.decryptStringAsync.mockResolvedValue({ result: "", shouldReEncrypt: true });
  await expect(h.providers.continuity(signal())).rejects.toThrow();
});
platformIt.each(["unknown-grant", "missing-keychain", "invalid-intents", "unfinished-wrapper"])(
  "continuity refuses %s without reset",
  async (fault) => {
    const h = await fixture();
    if (fault === "unknown-grant") h.permissions.getMediaAccessStatus.mockReturnValue("unknown");
    if (fault === "missing-keychain") h.storage.isAsyncEncryptionAvailable.mockResolvedValue(false);
    if (fault === "invalid-intents") await writeFile(join(h.appRoot, "admission-intents.enc"), "{}", { mode: 0o600 });
    if (fault === "unfinished-wrapper") {
      await mkdir(join(h.appRoot, "diagnostics"), { mode: 0o700 });
      await writeFile(join(h.appRoot, "diagnostics/control.key.tmp"), "partial", { mode: 0o600 });
    }
    await expect(h.providers.continuity(signal())).rejects.toThrow();
    expect(h.storage.encryptString).not.toHaveBeenCalled();
    expect(h.storage.encryptStringAsync).not.toHaveBeenCalled();
  },
);

class Child extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: string[] = [];
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    this.exitCode = 0;
    this.emit("close", 0, null);
    return true;
  }
}
it.each([false, true, "late-stop"])(
  "closed producer binds independent child identity/fence and preserves unknown launch (fault %s)",
  async (fault) => {
    const h = await fixture(),
      child = new Child(),
      attempt = randomUUID(),
      previous = { workspaceId: randomUUID(), instanceId: randomUUID(), processId: 1234 };
    const target = { ...previous, instanceId: randomUUID(), processId: child.pid },
      storeDir = join(h.root, "workspace/.orca");
    const hello = vi.spyOn(DaemonClient.prototype, "hello").mockResolvedValue({
      identity: { workspaceId: target.workspaceId, instanceId: target.instanceId },
      processId: fault === true ? 99 : child.pid,
      storeDir,
    } as HelloResult);
    const start = vi.fn(async (options: BundledDaemonOptions) => {
      options.onChild!(child as unknown as DaemonChild);
      options.onLog!(
        "closed update validation: " +
          JSON.stringify({
            version: 1,
            target,
            fenceId: attempt,
            directory: storeDir,
            epoch: "source-observed-epoch",
            work: "empty",
          }),
      );
      if (!(await options.probe!("http://127.0.0.1:7001"))) throw new Error("Unknown captured startup");
      return {
        url: "http://127.0.0.1:7001",
        pid: child.pid,
        child: child as unknown as DaemonChild,
        stop: async () => {},
      };
    });
    const providers = createManagedMacNativeProviders({
      ...h.options,
      fixture: { platform: "darwin", arch: "arm64", execute: h.execute, start },
    });
    const identity = {
        version: 1 as const,
        attempt,
        previousTarget: previous,
        candidate: h.binding.candidate,
        storeDir,
        manifestBase64: h.bytes.toString("base64"),
      },
      permit = { attempt, token: "one-use" };
    const process = await providers.startClosed(identity, permit, h.policy, signal());
    expect(start).toHaveBeenCalledTimes(1);
    expect(hello).toHaveBeenCalledWith("orca-app/closed-startup", false);
    expect(child.signals).toEqual([]);
    expect(await providers.startClosed(identity, permit, h.policy, signal())).toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
    if (fault === true) expect(process).toBeUndefined();
    else {
      expect(process?.instanceId).toBe(target.instanceId);
      expect(process?.child).toBe(child);
      expect(await process!.closed(signal())).toEqual({ outcome: "closed", target, fenceId: attempt });
      expect(await process!.store(signal())).toMatchObject({ epoch: "source-observed-epoch", target, work: "empty" });
      if (fault === "late-stop") {
        const controller = new AbortController();
        child.kill = (signal) => {
          child.signals.push(signal);
          controller.abort();
          return true;
        };
        expect(await providers.stopClosed(controller.signal)).toBe(false);
        child.exitCode = 0;
        child.emit("close", 0, null);
        expect(await providers.stopClosed(signal())).toBe(false);
      } else {
        expect(await providers.stopClosed(signal())).toBe(true);
        expect(await providers.stopClosed(signal())).toBe(true);
      }
      expect(child.signals).toEqual(["SIGTERM"]);
    }
  },
);
