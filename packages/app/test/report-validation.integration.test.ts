/** Encrypted previous-profile recovery refuses malformed retained coverage. */
import { afterAll, describe, expect, it } from "vitest";
import { canonicalJson, diagnosticReport } from "../src/main/diagnostics/snapshot.js";
import { withSyntheticProfile } from "./recovery-preparation/crash-harness.js";
import { cleanupFixtureHelper, implementationFixture, value } from "./recovery-preparation/implementation-fixture.js";

afterAll(cleanupFixtureHelper);

function report() {
  return diagnosticReport(
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    { requestedWindowMs: 60_000, observedWindowMs: 1000, retainedWindowMs: 900, capacityLimited: false },
    { budget: 0, expired: 0, invalid: 0 },
    [{ offsetMs: 100, phase: "connection", code: "connection_lost", entityAlias: "unknown" }],
  );
}
const bytes = (value: unknown) => Buffer.from(canonicalJson(value));

describe("retained coverage semantics", () => {
  it.runIf(process.platform === "linux").each(["empty", "nonempty"] as const)(
    "rejects malformed %s coverage from encrypted previous recovery before refreshing public IDs",
    async (kind) => {
      await withSyntheticProfile(async (profile) => {
        const original = report();
        const malformed = {
          ...original,
          events: kind === "empty" ? [] : original.events,
          coverage: { ...original.coverage, retainedWindowMs: 1000 },
        };
        const first = await implementationFixture(profile);
        value(await first.controller.setEnabled(true, 1));
        await first.disk.checkpoint(bytes(malformed), first.clock.reading, () => true);
        // Retire the fixture writer without marking a clean capture exit. A fresh
        // disk authenticates/promotes the real ciphertext, then Preview validates it.
        first.controller.revokeAuthority();
        await first.native.release(first.root);
        const recovered = await implementationFixture(profile, {
          reading: { ...first.clock.reading, elapsedMs: first.clock.reading.elapsedMs + 1 },
        });
        try {
          expect(recovered.controller.status().previous).toBe(true);
          expect(await recovered.controller.prepareExport("previous")).toEqual({ ok: false, code: "unavailable" });
          expect(recovered.controller.status().activeExportHandle).toBeUndefined();
          expect(recovered.picker.calls).toBe(0);
          expect(recovered.native.publishCalls).toBe(0);
        } finally {
          recovered.controller.rendererDisposed();
          await recovered.controller.cleanExit();
        }
      });
    },
  );
});
