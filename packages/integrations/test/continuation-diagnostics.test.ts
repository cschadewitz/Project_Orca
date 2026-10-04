/** Prove failure evidence stays bounded and excludes sensitive fields. */
import { expect, it } from "vitest";
import { continuationDiagnostics } from "./continuation-diagnostics.js";

it("emits only bounded public milestones, receipt classification and known error codes", () => {
  const events = Array.from({ length: 40 }, (_, seq) => ({
    seq,
    type: "continuation.recorded",
    payload: { state: "accepted", entry: "SECRET", note: "SECRET" },
  }));
  events.push({ seq: 40, type: "agent.update", payload: { state: "SECRET", entry: "SECRET", note: "SECRET" } });
  const receipt = {
    operationId: "SECRET",
    continuationId: "SECRET",
    runId: "SECRET",
    expectedBoundary: "SECRET",
    state: "blocked" as const,
    blockedReason: "unsafe-boundary" as const,
  };
  const result = continuationDiagnostics(events, receipt, false, { code: "RUN_LEASED", message: "SECRET" });
  expect(result).toMatchObject({
    errorCode: "RUN_LEASED",
    receiptState: "blocked",
    blockedReason: "unsafe-boundary",
    leaseFilePresent: false,
    truncated: true,
  });
  expect(result.milestones).toHaveLength(32);
  expect(result.milestones[0]).toEqual({ seq: 8, type: "continuation.recorded", state: "accepted" });
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(continuationDiagnostics([], undefined, "unavailable", { code: "SECRET" })).toEqual({
    errorCode: "OTHER",
    leaseFilePresent: "unavailable",
    milestones: [],
    truncated: false,
  });
});
