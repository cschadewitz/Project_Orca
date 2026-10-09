/** Startup scheduling only; no native storage, capture or OS acceptance claim. */
import { expect, it, vi } from "vitest";
import { RecoveryController } from "../src/main/diagnostics/recovery-controller.js";
import type { DiagnosticsSetting, RecoveryDisk } from "../src/main/diagnostics/recovery-contract.js";

function fixture() {
  let release!: () => void;
  let entered!: () => void;
  const readEntered = new Promise<void>((resolve) => (entered = resolve));
  const pending = new Promise<void>((resolve) => (release = resolve));
  let setting: DiagnosticsSetting = { enabled: true, scopeVersion: 1, minutes: 10 };
  const disk: RecoveryDisk = {
    revoke: vi.fn(),
    readSetting: vi.fn(async () => {
      const observed = { ...setting };
      entered();
      await pending;
      return observed;
    }),
    writeSetting: vi.fn(async (next) => {
      setting = next;
    }),
    open: vi.fn(async () => false),
    maintain: async () => false,
    checkpoint: vi.fn(async () => undefined),
    previous: async () => undefined,
    discardPrevious: async () => undefined,
    cleanExit: async () => undefined,
    cleanup: vi.fn(async () => undefined),
    readExportState: async () => ({}),
    writeExportState: async () => undefined,
    stageExport: async () => ({ device: "1", inode: "2" }),
    clearStage: async () => undefined,
    validateDestination: async () => false,
    publishStage: async () => "refused",
    writersStopped: async () => true,
  };
  const controller = new RecoveryController({
    disk,
    clock: { read: () => ({ bootId: "synthetic-startup-consent", elapsedMs: 1000 }) },
    // Exercise the shipping default. A durable choice never enables production capture.
  });
  return { controller, disk, readEntered, release };
}

it.each(["navigation", "renderer-disposal"])(
  "keeps durable consent when %s revokes a preview during the startup read",
  async (boundary) => {
    const f = fixture();
    const initialization = f.controller.initialize();
    await f.readEntered;
    if (boundary === "navigation") f.controller.revokePreviewAuthority();
    else f.controller.rendererDisposed();
    f.release();
    await initialization;
    expect(f.controller.status()).toMatchObject({
      enabled: true,
      minutes: 10,
      productionEnabled: false,
      code: "unavailable",
      cleanupPending: false,
    });
    expect(f.disk.writeSetting).not.toHaveBeenCalled();
    expect(f.disk.open).not.toHaveBeenCalled();
    expect(f.controller.record("run", "run_failed")).toBe(false);
    expect(await f.controller.preparePreview("current")).toEqual({ ok: false, code: "unavailable" });
    await f.controller.cleanExit();
  },
);

it.each(["off", "shutdown"])("a newer %s fences the pending enabled startup read", async (boundary) => {
  const f = fixture();
  const initialization = f.controller.initialize();
  await f.readEntered;
  const off = boundary === "off" ? f.controller.setEnabled(false, 1) : undefined;
  if (boundary === "shutdown") f.controller.revokeAuthority();
  f.release();
  await initialization;
  await off;
  expect(f.controller.status()).toMatchObject({ enabled: false, productionEnabled: false });
  expect(f.disk.open).not.toHaveBeenCalled();
  expect(f.controller.record("run", "run_failed")).toBe(false);
  if (boundary === "off") {
    expect(f.disk.writeSetting).toHaveBeenCalled();
    expect(vi.mocked(f.disk.writeSetting).mock.calls.every(([next]) => !next.enabled)).toBe(true);
  }
  await f.controller.cleanExit();
});
