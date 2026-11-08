/** Fresh Save acceptance after the original action expires, on the real clock.
 * Split out of core.test.ts: it waits in real time, so in its own file it runs beside the rest of the suite instead of in front of it.
 */
import { join } from "node:path";
import { expect, it } from "vitest";
import { fileStores } from "@orca/store";
import { runControlledOwnedReadTest } from "../controlled-owned-read/producer-expanded.js";
import { bootstrap, supervisor } from "./fixture.js";

it("waits past the original action expiry on the real clock before fresh Save acceptance", async () => {
  const b = await bootstrap(),
    c = await supervisor("connected", b.grant);
  // A short action lifetime: the scenario still waits out a real expiry, just not the default 55 s one.
  const actionTtlMs = 8000;
  Object.assign(c.options, {
    ownerDurationMs: 300000,
    pendingSaveIntent: true,
    waitBeforeSaveExpiry: true,
    actionTtlMs,
  });
  const started = performance.now();
  const result = await runControlledOwnedReadTest(c.base, "connected", c.options);
  expect(performance.now() - started).toBeGreaterThan(actionTtlMs - 1000);
  expect(result.receipts.length).toBe(2);
  expect(c.observed.map((item) => item.phase)).toEqual(["human-read", "rule-read"]);
  const stores = fileStores(join(c.base, "workspace/.orca"));
  const events = await stores.events.readTypes("controlled", ["agent.permission"]);
  const marker = events.find((event) => event.type === "agent.permission" && event.payload.scopedApprovalRef)!;
  const payload = (await stores.execution.getPayload(
    "controlled",
    marker.executionPayloadRef!,
    "agent.permission",
  )) as {
    entry: {
      version: number;
      acceptedAt: string;
      action: { expiresAt: string };
      saveAuthority: { issuedAt: number; expiresAt: number };
    };
  };
  expect(payload.entry.version).toBe(3);
  expect(Date.parse(payload.entry.acceptedAt)).toBeGreaterThanOrEqual(Date.parse(payload.entry.action.expiresAt));
  expect(Date.parse(payload.entry.acceptedAt)).toBeLessThan(payload.entry.saveAuthority.expiresAt);
}, 90000);
