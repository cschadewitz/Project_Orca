import { previewText } from "./recovery-preparation/preview-text.js";
/** Closed producer and existing consent fences; disk/key fixtures are synthetic. */
import { afterAll, describe, expect, it, vi } from "vitest";
import { startupDiagnosticObserver } from "../src/main/diagnostics/startup-producer.js";
import { withSyntheticProfile } from "./recovery-preparation/crash-harness.js";
import { cleanupFixtureHelper, implementationFixture, value } from "./recovery-preparation/implementation-fixture.js";

afterAll(cleanupFixtureHelper);

it("rejects arbitrary source values without coercion and isolates recorder failure", () => {
  const record = vi.fn(() => {
    throw new Error("recorder failed");
  });
  const observe = startupDiagnosticObserver({ record });
  const toString = vi.fn(() => "startup_spawn_failed");
  observe({ toString } as never);
  observe("/private/token-file" as never);
  observe("unknown" as never);
  observe("connection_lost" as never);
  expect(record).not.toHaveBeenCalled();
  expect(toString).not.toHaveBeenCalled();
  expect(() => observe("startup_spawn_failed")).not.toThrow();
  expect(record.mock.calls).toEqual([["startup", "startup_spawn_failed"]]);
});

describe.runIf(process.platform === "linux")("startup producer/controller integration", () => {
  it("uses current consent and never replays observations collected before opt-in or after Off", async () => {
    await withSyntheticProfile(async (profile) => {
      const f = await implementationFixture(profile);
      const observe = startupDiagnosticObserver(f.controller);
      observe("startup_spawn_failed");
      value(await f.controller.setEnabled(true, 1));
      observe("startup_exited_before_handshake");
      const preview = await previewText(f.controller, value(await f.controller.preparePreview("current")));
      expect(JSON.parse(preview.text).events.map((event: { code: string }) => event.code)).toEqual([
        "startup_exited_before_handshake",
      ]);
      value(await f.controller.closePreview(preview.handle));
      value(await f.controller.setEnabled(false, 1));
      observe("startup_handshake_timeout");
      value(await f.controller.setEnabled(true, 1));
      const fresh = await previewText(f.controller, value(await f.controller.preparePreview("current")));
      expect(JSON.parse(fresh.text).events).toEqual([]);
      await f.controller.cleanExit();
    });
  });

  it("cannot activate the production-disabled controller", async () => {
    await withSyntheticProfile(async (profile) => {
      const f = await implementationFixture(profile, { productionEnabled: false });
      const observe = startupDiagnosticObserver(f.controller);
      expect(value(await f.controller.setEnabled(true, 1))).toMatchObject({
        enabled: true,
        productionEnabled: false,
        code: "unavailable",
      });
      observe("startup_spawn_failed");
      expect(f.controller.record("startup", "startup_spawn_failed")).toBe(false);
      expect((await f.controller.preparePreview("current")).ok).toBe(false);
      await f.controller.cleanExit();
    });
  });
});
