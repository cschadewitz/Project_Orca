/** Actual main IPC registration + default controller; capable storage is a fixture,
 * not compiled-native or Electron acceptance. No daemon, OS key or network access. */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { RecoveryController } from "../src/main/diagnostics/recovery-controller.js";
import type { DiagnosticsSetting, RecoveryDisk } from "../src/main/diagnostics/recovery-contract.js";

afterEach(() => vi.restoreAllMocks());

function fixture(enabled: boolean) {
  let setting: DiagnosticsSetting = { enabled, scopeVersion: 1, minutes: 10 };
  const disk = {
    revoke: vi.fn(),
    readSetting: vi.fn(async () => ({ ...setting })),
    writeSetting: vi.fn(async (next: DiagnosticsSetting) => {
      setting = { ...next };
    }),
    // Every capture/export capability would succeed if the controller dispatched it.
    open: vi.fn(async () => true),
    maintain: vi.fn(async () => true),
    checkpoint: vi.fn(async () => undefined),
    previous: vi.fn(async () => undefined),
    discardPrevious: vi.fn(async () => undefined),
    cleanExit: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => undefined),
    readExportState: vi.fn(async () => ({})),
    writeExportState: vi.fn(async () => undefined),
    stageExport: vi.fn(async () => ({ device: "1", inode: "2" })),
    clearStage: vi.fn(async () => undefined),
    validateDestination: vi.fn(async () => true),
    publishStage: vi.fn(async () => "saved" as const),
    writersStopped: vi.fn(async () => true),
  } satisfies RecoveryDisk;
  const picker = vi.fn(async () => "synthetic-unused-destination");
  const controller = new RecoveryController({
    disk,
    clock: { read: () => ({ bootId: "synthetic-shipping-ipc", elapsedMs: 1000 }) },
    chooseDestination: picker,
  });
  const handlers = new Map<string, (event: unknown, params: unknown, epoch: number) => Promise<unknown>>();
  const mainFrame = {};
  const sender = { id: 1, mainFrame, send: vi.fn() };
  const window = { isDestroyed: () => false, webContents: sender };
  const event = { sender, senderFrame: mainFrame };
  const source = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const start = source.indexOf("diagnostics.subscribe((status) => {");
  const end = source.indexOf("/* ---------- one app, one window onto a store ---------- */", start);
  if (start < 0 || end < start) throw new Error("Actual diagnostics IPC registration boundary unavailable");
  const registration = transformSync(source.slice(start, end), { loader: "ts", format: "cjs" }).code;
  runInNewContext(registration, {
    z,
    diagnostics: controller,
    diagnosticsInitializer: { initialize: () => controller.initialize() },
    assertOrdinaryStartup: () => {},
    appWriters: { run: (work: () => unknown) => work() },
    workspace: { connectionTarget: { epoch: 0 } },
    BrowserWindow: { fromWebContents: () => window, getAllWindows: () => [window] },
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, params: unknown, epoch: number) => Promise<unknown>) =>
        handlers.set(channel, handler),
    },
  });
  const call = (method: string, params?: unknown) => {
    const handler = handlers.get(`orca:diagnostics.${method}`);
    if (!handler) throw new Error(`Missing actual IPC method ${method}`);
    return handler(event, params, 0);
  };
  return { controller, disk, picker, call };
}

it.each([false, true])("shipping IPC cannot capture/export with initially persisted consent %s", async (enabled) => {
  const timer = vi.spyOn(globalThis, "setInterval");
  const f = fixture(enabled);
  try {
    await f.call("status");
    await f.call("setEnabled", { enabled: true, scopeVersion: 1 });
    expect(f.controller.status()).toMatchObject({ enabled: true, productionEnabled: false, code: "unavailable" });
    expect(f.controller.record("run", "run_failed")).toBe(false);
    await f.controller.checkpoint();
    for (const source of ["current", "previous"])
      expect(await f.call("prepareExport", { source })).toEqual({ ok: false, code: "unavailable" });
    const handle = randomUUID();
    expect(await f.call("chooseDestination", { handle })).toEqual({ ok: false, code: "stale_export" });
    expect(await f.call("save", { handle, destinationToken: randomUUID() })).toEqual({
      ok: false,
      code: "stale_export",
    });
    await f.call("retryCleanup");
    await f.call("setEnabled", { enabled: false, scopeVersion: 1 });
    await f.call("retryCleanup");
    f.controller.rendererDisposed();
    expect(f.controller.status()).toMatchObject({ enabled: false, productionEnabled: false, payloadReservedBytes: 0 });
    expect(f.disk.cleanup).toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
    for (const port of [
      f.disk.open,
      f.disk.maintain,
      f.disk.checkpoint,
      f.disk.previous,
      f.disk.stageExport,
      f.disk.validateDestination,
      f.disk.publishStage,
      f.picker,
    ])
      expect(port).not.toHaveBeenCalled();
  } finally {
    await f.controller.cleanExit();
  }
  expect(f.disk.cleanExit).toHaveBeenCalledOnce();
});
