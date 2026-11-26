/**
 * #1205: a fresh install on a platform with no diagnostics storage (Linux) showed "Cleanup is
 * pending… Retry cleanup" with diagnostics off. Nothing can have been written there, so the
 * composed controller reports diagnostics unavailable with nothing pending, before and after
 * "Keep off", a retry and a quit-and-reopen. A platform that has a backend but failed to load
 * it is different: earlier files may exist, so it is not marked storage-less.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticsInitializer } from "../src/main/diagnostics/initialize.js";
import { loadNativeDiagnosticsStorage } from "../src/main/diagnostics/native-storage.js";

const safeStorage = {
  isAsyncEncryptionAvailable: async () => false,
  encryptStringAsync: async () => {
    throw new Error("unexpected key access");
  },
  decryptStringAsync: async () => {
    throw new Error("unexpected key access");
  },
} as unknown as Parameters<typeof createDiagnosticsInitializer>[0]["safeStorage"];

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("diagnostics on a platform with no diagnostics storage (#1205)", () => {
  it("shows nothing pending on a fresh profile, after Keep off and retry, and after reopening", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const profile = await mkdtemp(join(tmpdir(), "orca-diagnostics-linux-"));
    roots.push(profile);
    const root = join(profile, "diagnostics");
    for (const session of [1, 2]) {
      const diagnostics = createDiagnosticsInitializer({ root, safeStorage, chooseDestination: async () => undefined });
      await diagnostics.initialize();
      expect(diagnostics.controller.status(), `session ${session}`).toMatchObject({
        enabled: false,
        code: "unavailable",
        cleanupPending: false,
        previous: false,
        // The renderer says "not available on this system" rather than a failure (#1109).
        platformStorage: false,
      });
      // "Keep off", then "Retry cleanup" if it were offered: neither invents pending work.
      const kept = await diagnostics.controller.setEnabled(false, 1);
      expect(kept.ok && kept.value).toMatchObject({ enabled: false, cleanupPending: false });
      const retried = await diagnostics.controller.retryCleanup();
      expect(retried.ok && retried.value).toMatchObject({ cleanupPending: false });
      // Enabling cannot succeed without storage, and refusing it leaves nothing pending either.
      expect(await diagnostics.controller.setEnabled(true, 1)).toEqual({ ok: false, code: "unavailable" });
      expect(await diagnostics.controller.setMinutes(10)).toEqual({ ok: false, code: "unavailable" });
      expect(diagnostics.controller.status()).toMatchObject({ enabled: false, cleanupPending: false });
      await diagnostics.close();
    }
    // Nothing was created under the profile.
    expect(await readdir(profile)).toEqual([]);
  });

  it("marks only a platform without a backend as storage-less, not a missing addon", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(loadNativeDiagnosticsStorage(resolve("orca-unused-diagnostics-data")).platform).toBe(false);
    const original = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    const electron = Object.getOwnPropertyDescriptor(process.versions, "electron");
    try {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      Object.defineProperty(process.versions, "electron", { value: "44.4.5", configurable: true });
      Object.defineProperty(process, "resourcesPath", {
        value: resolve("orca-missing-diagnostics-resources"),
        configurable: true,
      });
      expect(loadNativeDiagnosticsStorage(resolve("orca-unused-diagnostics-data")).platform).toBeUndefined();
    } finally {
      if (original) Object.defineProperty(process, "resourcesPath", original);
      else Reflect.deleteProperty(process, "resourcesPath");
      if (electron) Object.defineProperty(process.versions, "electron", electron);
      else Reflect.deleteProperty(process.versions, "electron");
    }
  });
});
