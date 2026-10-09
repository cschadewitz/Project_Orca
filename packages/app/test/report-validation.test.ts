/** Pure diagnostic report identifiers and retained coverage validation. */
import { describe, expect, it } from "vitest";
import { validateDiagnosticReport } from "../src/main/diagnostics/report-validation.js";
import { canonicalJson, diagnosticReport, type DiagnosticReport } from "../src/main/diagnostics/snapshot.js";

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

describe("authenticated report identifiers", () => {
  it.each([false, true])("preserves exact valid bytes or refreshes only public IDs, freshIds=%s", (freshIds) => {
    const original = report();
    const result = validateDiagnosticReport(bytes(original), freshIds);
    if (!freshIds) expect(result).toEqual(bytes(original));
    else {
      const restored = JSON.parse(result.toString("utf8")) as DiagnosticReport;
      expect(typeof restored.reportId).toBe("string");
      expect(typeof restored.sessionId).toBe("string");
      expect(restored.reportId).not.toBe(original.reportId);
      expect(restored.sessionId).not.toBe(original.sessionId);
      expect(restored.reportId).not.toBe(restored.sessionId);
      expect({ ...restored, reportId: original.reportId, sessionId: original.sessionId }).toEqual(original);
    }
  });

  it.each([false, true])("rejects coerced UUIDs before public-ID refresh, freshIds=%s", (freshIds) => {
    const original = report();
    for (const ids of [
      { reportId: [original.reportId] },
      { sessionId: [original.sessionId] },
      { reportId: [original.reportId], sessionId: [original.reportId] },
      { reportId: original.reportId, sessionId: original.reportId },
      { reportId: null },
      { sessionId: 123 },
      { reportId: `${original.reportId}0` },
    ])
      expect(() => validateDiagnosticReport(bytes({ ...original, ...ids }), freshIds)).toThrow("unavailable");
  });
});

describe("retained coverage semantics", () => {
  it.each([false, true])("requires the actual first retained event or zero for no events, freshIds=%s", (freshIds) => {
    const original = report();
    const empty = { ...original, events: [], coverage: { ...original.coverage, retainedWindowMs: 0 } };
    expect(() => validateDiagnosticReport(bytes(empty), freshIds)).not.toThrow();
    expect(() => validateDiagnosticReport(bytes(original), freshIds)).not.toThrow();
    for (const malformed of [
      {
        ...empty,
        windowMs: 60_000,
        coverage: { ...empty.coverage, observedWindowMs: 60_000, retainedWindowMs: 60_000 },
      },
      { ...original, coverage: { ...original.coverage, retainedWindowMs: 899 } },
      { ...original, coverage: { ...original.coverage, retainedWindowMs: 1000 } },
    ])
      expect(() => validateDiagnosticReport(bytes(malformed), freshIds)).toThrow("unavailable");
  });
});
