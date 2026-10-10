/** Shipping Windows capture gate refuses before key, file, picker or network authority. */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dgram from "node:dgram";
import { afterEach, expect, it, vi } from "vitest";
import { createDiagnosticsInitializer } from "../src/main/diagnostics/initialize.js";
import { createSafeStorageKeyAdapter } from "../src/main/diagnostics/native-adapter.js";
import { diagnosticsAddonPath } from "../src/main/diagnostics/native-addon.js";

afterEach(() => vi.restoreAllMocks());

it.each(["x64", "arm64"])("Windows %s native capability has one fixed packaged location", (arch) => {
  const resourcesPath = resolve("synthetic-resources");
  for (const addon of ["diagnostics_clock", "diagnostics_storage"] as const) {
    expect(diagnosticsAddonPath(addon, { platform: "win32", arch, electron: true, resourcesPath })).toBe(
      join(resourcesPath, "native", "diagnostics", `win32-${arch}`, `${addon}.node`),
    );
  }
});

it.runIf(process.platform === "win32")(
  "repeated actual Windows off/refused attempts and recreation retain no files or key/picker authority",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "orca-windows-refusal-"));
    const calls = {
      isAsyncEncryptionAvailable: vi.fn(async () => true),
      encryptStringAsync: vi.fn(async () => Buffer.from("synthetic-unused")),
      decryptStringAsync: vi.fn(async () => ({ result: "synthetic-unused", shouldReEncrypt: false })),
    };
    const picker = vi.fn(async () => join(directory, "export.json"));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("synthetic network refusal"));
    const network = [
      vi.spyOn(net.Socket.prototype, "connect"),
      vi.spyOn(net, "createConnection"),
      vi.spyOn(tls, "connect"),
      vi.spyOn(http, "request"),
      vi.spyOn(https, "request"),
      vi.spyOn(http2, "connect"),
      vi.spyOn(dgram, "createSocket"),
    ];
    try {
      for (let restart = 0; restart < 2; restart++) {
        const fixture = createDiagnosticsInitializer({
          root: join(directory, "diagnostics"),
          safeStorage: calls,
          chooseDestination: picker,
        });
        try {
          await fixture.initialize();
          expect(fixture.controller.status()).toMatchObject({
            enabled: false,
            productionEnabled: false,
            payloadReservedBytes: 0,
          });
          expect((await fixture.controller.setEnabled(true, 1)).ok).toBe(false);
          fixture.startupObserver("startup_spawn_failed");
          expect(fixture.controller.record("run", "run_failed")).toBe(false);
          expect((await fixture.controller.prepareExport("current")).ok).toBe(false);
          expect((await fixture.controller.prepareExport("previous")).ok).toBe(false);
          expect((await fixture.controller.chooseDestination("synthetic-stale")).ok).toBe(false);
          expect((await fixture.controller.save("synthetic-stale", "synthetic-stale")).ok).toBe(false);
          await fixture.controller.checkpoint();
          fixture.controller.rendererDisposed();
          expect(fixture.controller.status().payloadReservedBytes).toBe(0);
        } finally {
          await fixture.close();
        }
        expect(await readdir(directory)).toEqual([]);
      }
      for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
      expect(picker).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      for (const call of network) expect(call).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(["unavailable", "rotation"])("Windows key seam refuses %s without plaintext fallback", async (refusal) => {
  const encrypt = vi.fn(async () => Buffer.from("synthetic-wrapper"));
  const decrypt = vi.fn(async () => ({ result: Buffer.alloc(32, 7).toString("base64"), shouldReEncrypt: true }));
  const keys = createSafeStorageKeyAdapter(
    {
      isAsyncEncryptionAvailable: async () => refusal !== "unavailable",
      encryptStringAsync: encrypt,
      decryptStringAsync: decrypt,
    },
    "win32",
  );
  if (refusal === "unavailable") {
    await expect(keys.wrap(Buffer.alloc(32, 7))).rejects.toThrow("unavailable");
    expect(encrypt).not.toHaveBeenCalled();
  }
  await expect(keys.unwrap(Buffer.from("synthetic-wrapper"))).rejects.toThrow("unavailable");
  if (refusal === "unavailable") expect(decrypt).not.toHaveBeenCalled();
});
