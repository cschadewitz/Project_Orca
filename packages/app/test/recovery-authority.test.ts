/** Deterministic controller fences on disposable Linux storage; no native acceptance claim. */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryController } from "../src/main/diagnostics/recovery-controller.js";
import { RECOVERY_LIMITS, type BootReading } from "../src/main/diagnostics/recovery-contract.js";
import { withSyntheticProfile } from "./recovery-preparation/crash-harness.js";
import { barrier, inspectPrivateRoot } from "./recovery-preparation/filesystem-evidence.js";
import { cleanupFixtureHelper, implementationFixture, value } from "./recovery-preparation/implementation-fixture.js";
import { crashImplementationAt } from "./recovery-preparation/process-fixture.js";

afterAll(cleanupFixtureHelper);
afterEach(() => vi.restoreAllMocks());

describe.runIf(process.platform === "linux")("diagnostics request authority", () => {
  it("a newer durable Off wins while older Enable is in pre-enable cleanup", async () => {
    await withSyntheticProfile(async (profile) => {
      const f = await implementationFixture(profile);
      const cleanup = barrier();
      const clearStage = barrier();
      const originalCleanup = f.disk.cleanup.bind(f.disk);
      const originalClear = f.disk.clearStage.bind(f.disk);
      vi.spyOn(f.disk, "cleanup").mockImplementationOnce(async () => {
        await cleanup.wait();
        await originalCleanup();
      });
      vi.spyOn(f.disk, "clearStage").mockImplementationOnce(async () => {
        await clearStage.wait();
        await originalClear();
      });
      const open = vi.spyOn(f.disk, "open");
      const wrapped = vi.spyOn(f.keys, "wrap");
      const writes = vi.spyOn(f.disk, "writeSetting");
      const enabling = f.controller.setEnabled(true, 1);
      await cleanup.entered;
      const off = f.controller.setEnabled(false, 1);
      cleanup.release();
      await clearStage.entered;
      expect(value(await off).enabled).toBe(false);
      expect((await f.disk.readSetting()).enabled).toBe(false);
      clearStage.release();
      await enabling;
      expect(f.controller.status().enabled).toBe(false);
      expect((await f.disk.readSetting()).enabled).toBe(false);
      expect(writes.mock.calls.every(([setting]) => !setting.enabled)).toBe(true);
      expect(f.controller.record("run", "run_failed")).toBe(false);
      expect((await f.controller.preparePreview("current")).ok).toBe(false);
      expect(open).not.toHaveBeenCalled();
      expect(wrapped).not.toHaveBeenCalled();
      expect(
        [...(await inspectPrivateRoot(f.root)).files.keys()].some((name) =>
          /^(slot-|session-|control\.key)/.test(name),
        ),
      ).toBe(false);
      await f.controller.cleanExit();
    });
  });

  it("a newer Off fences Enable admitted before controller initialization settles", async () => {
    await withSyntheticProfile(async (profile) => {
      const f = await implementationFixture(profile);
      const initialization = barrier();
      const read = f.disk.readSetting.bind(f.disk);
      vi.spyOn(f.disk, "readSetting").mockImplementationOnce(async () => {
        const setting = await read();
        await initialization.wait();
        return setting;
      });
      const controller = new RecoveryController({ disk: f.disk, clock: f.clock, productionEnabled: true });
      const open = vi.spyOn(f.disk, "open");
      const wrapped = vi.spyOn(f.keys, "wrap");
      const writes = vi.spyOn(f.disk, "writeSetting");
      const enabling = controller.setEnabled(true, 1);
      await initialization.entered;
      expect(value(await controller.setEnabled(false, 1)).enabled).toBe(false);
      initialization.release();
      await enabling;
      expect(controller.status().enabled).toBe(false);
      expect((await f.disk.readSetting()).enabled).toBe(false);
      expect(writes.mock.calls.every(([setting]) => !setting.enabled)).toBe(true);
      expect(controller.record("run", "run_failed")).toBe(false);
      expect(open).not.toHaveBeenCalled();
      expect(wrapped).not.toHaveBeenCalled();
      await controller.cleanExit();
    });
  });

  it("renderer process disposal fences late previous preparation and retains its charge until settlement", async () => {
    await withSyntheticProfile(async (profile) => {
      await crashImplementationAt(profile, "checkpoint-committed");
      const f = await implementationFixture(profile, { reading: { bootId: "synthetic-boot", elapsedMs: 2000 } });
      const pending = barrier();
      const previous = f.disk.previous.bind(f.disk);
      vi.spyOn(f.disk, "previous").mockImplementationOnce(async (now) => {
        const old = await previous(now);
        expect(old).toBeDefined();
        await pending.wait();
        return old;
      });
      const preparing = f.controller.preparePreview("previous");
      await pending.entered;
      // This is the controller entry point called by main's render-process-gone handler.
      f.controller.rendererDisposed();
      expect(f.controller.status().payloadReservedBytes).toBe(4 * RECOVERY_LIMITS.exportBytes);
      expect(f.controller.status().activePreviewHandle).toBeUndefined();
      expect((await f.controller.preparePreview("current")).ok).toBe(false);
      pending.release();
      expect(await preparing).toEqual({ ok: false, code: "stale_preview" });
      expect(f.controller.status().activePreviewHandle).toBeUndefined();
      expect(f.controller.status().payloadReservedBytes).toBe(0);
      expect(f.controller.status().enabled).toBe(true);
      expect((await f.disk.readSetting()).enabled).toBe(true);
      expect(f.controller.record("run", "run_failed")).toBe(true);
      const fresh = value(await f.controller.preparePreview("previous"));
      value(await f.controller.closePreview(fresh.handle));
      await f.controller.cleanExit();
    });
  });

  it("uncertainty waits for the busy slot, survives failed maintenance and retries without restoring history", async () => {
    await withSyntheticProfile(async (profile) => {
      const f = await implementationFixture(profile);
      value(await f.controller.setEnabled(true, 1));
      f.controller.record("run", "run_failed");
      await f.controller.checkpoint();
      const pending = barrier();
      const write = f.disk.writeSetting.bind(f.disk);
      vi.spyOn(f.disk, "writeSetting").mockImplementationOnce(async (setting) => {
        await pending.wait();
        await write(setting);
      });
      const maintenance = vi.spyOn(f.disk, "maintain").mockRejectedValueOnce(new Error("cleanup_pending"));
      const failed = barrier();
      const unsubscribe = f.controller.subscribe((status) => {
        if (maintenance.mock.calls.length && status.code === "age_uncertain") failed.release();
      });
      const changing = f.controller.setMinutes(10);
      await pending.entered;
      f.clock.reading.elapsedMs = 999;
      expect(f.controller.status().code).toBe("age_uncertain");
      f.clock.reading.elapsedMs = 1001;
      await Promise.resolve();
      expect(maintenance).not.toHaveBeenCalled();
      expect(f.controller.record("run", "run_failed")).toBe(false);
      pending.release();
      await changing;
      await failed.wait();
      unsubscribe();
      expect(maintenance).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(f.controller.status().cleanupPending).toBe(true);
      expect((await f.controller.preparePreview("current")).ok).toBe(false);
      expect([...(await inspectPrivateRoot(f.root)).files.keys()].some((name) => /^slot-/.test(name))).toBe(true);
      value(await f.controller.retryCleanup());
      expect(maintenance).toHaveBeenLastCalledWith(undefined);
      expect([...(await inspectPrivateRoot(f.root)).files.keys()].some((name) => /^(slot-|session-)/.test(name))).toBe(
        false,
      );
      expect(f.controller.record("run", "run_failed")).toBe(false);
      expect(f.controller.status().code).toBe("unavailable");
      // Only a new consent cycle can create a fresh capture session after cleanup.
      value(await f.controller.setEnabled(false, 1));
      value(await f.controller.setEnabled(true, 1));
      expect(f.controller.record("connection", "connection_lost")).toBe(true);
      const fresh = value(await f.controller.preparePreview("current"));
      expect(fresh.text).not.toContain("run_failed");
      value(await f.controller.closePreview(fresh.handle));
      await f.controller.cleanExit();
    });
  });

  for (const observer of ["status", "preview"] as const) {
    it.each(["rollback", "missing", "boot-change", "throws"] as const)(
      `${observer} latches %s even when the next clock reading is plausible`,
      async (fault) => {
        await withSyntheticProfile(async (profile) => {
          const f = await implementationFixture(profile);
          value(await f.controller.setEnabled(true, 1));
          expect(f.controller.record("run", "run_failed")).toBe(true);
          await f.controller.checkpoint();
          const preview = observer === "preview" ? value(await f.controller.preparePreview("current")) : undefined;
          const pending = barrier();
          const settled = barrier();
          const maintain = f.disk.maintain.bind(f.disk);
          const maintenance = vi.spyOn(f.disk, "maintain").mockImplementationOnce(async (now) => {
            await pending.wait();
            try {
              return await maintain(now);
            } finally {
              settled.release();
            }
          });
          const wrapped = vi.spyOn(f.keys, "wrap");
          let reading: BootReading | undefined = { bootId: "synthetic-boot", elapsedMs: 1000 };
          let throws = false;
          vi.spyOn(f.clock, "read").mockImplementation(() => {
            if (throws) throw new Error("Synthetic clock unavailable");
            return reading!;
          });
          if (fault === "rollback") reading.elapsedMs = 999;
          else if (fault === "missing") reading = undefined;
          else if (fault === "boot-change") reading.bootId = "different-boot";
          else throws = true;
          const selection = preview ? f.controller.chooseDestination(preview.handle) : undefined;
          if (!preview) f.controller.status();
          // Restore before the scheduled maintenance can run; the observation must survive.
          reading = { bootId: "synthetic-boot", elapsedMs: 1001 };
          throws = false;
          if (selection) expect((await selection).ok).toBe(false);
          expect(f.controller.status().code).toBe("age_uncertain");
          expect(f.controller.status().previous).toBe(false);
          expect(f.controller.record("run", "run_failed")).toBe(false);
          expect((await f.controller.preparePreview("current")).ok).toBe(false);
          await pending.entered;
          expect(maintenance).toHaveBeenCalledWith(undefined);
          pending.release();
          await settled.wait();
          const evidence = await inspectPrivateRoot(f.root);
          expect([...evidence.files.keys()].some((name) => /^(slot-|session-)/.test(name))).toBe(false);
          expect(wrapped).not.toHaveBeenCalled();
          expect(f.controller.status().activePreviewHandle).toBeUndefined();
          expect(f.controller.status().enabled).toBe(true);
          if (preview) value(await f.controller.closePreview(preview.handle));
          await f.controller.cleanExit();
        });
      },
    );
  }
});
