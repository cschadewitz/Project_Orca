/** The initial Allow once, held past its preview expiry on the real clock.
 * Split out of initial-approval.test.ts: it waits ~57s in real time, so in its own file it runs beside the rest instead of in front of it.
 */
import { expect, it } from "vitest";
import { runControlledOwnedReadTest } from "../controlled-owned-read/producer-expanded.js";
import { bootstrap, noSavedGrant, semantics, supervisor } from "./fixture.js";

it("the initial Allow once waits beyond its preview expiry on the real clock", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  // A short preview lifetime: it still waits out a real expiry, just not the default 55 s one.
  const actionTtlMs = 8000;
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    initialApprovalIntent: true,
    pendingSaveIntent: true,
    initialAnswerChoice: "allow-once",
    waitBeforeSaveExpiry: true,
    actionTtlMs,
    refreshSaveReview: true,
  });
  const started = performance.now();
  const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
  expect(performance.now() - started).toBeGreaterThan(actionTtlMs - 1000);
  expect(result.receipts).toHaveLength(1);
  expect(c.observed.map((effect) => effect.bytes)).toEqual(["spos"]);
  await noSavedGrant(c.base);
  const records = await semantics(c.base, result.semanticRefs);
  const preview = records.find((record) => record.kind === "controlled-initial-preview-v1")!.value.action as {
    expiresAt: string;
  };
  const fresh = records.find((record) => record.kind === "controlled-fresh-authority-v1")!.value as {
    observedAt: number;
    leaseExpiresAt: number;
  };
  expect(fresh.observedAt).toBeGreaterThan(Date.parse(preview.expiresAt));
  expect(fresh.observedAt).toBeLessThan(fresh.leaseExpiresAt);
}, 90000);
