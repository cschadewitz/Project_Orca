/** Validate bounded authenticated bytes against the closed enum-only producer slice. */
import { randomUUID } from "node:crypto";
import { allowedEvent, DIAGNOSTIC_LIMITS, type DiagnosticCount } from "./profile.js";
import { canonicalJson, diagnosticReport, type DiagnosticReport } from "./snapshot.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifier = (v: unknown): v is string => typeof v === "string" && v.length === 36 && uuid.test(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const count = (v: unknown): v is DiagnosticCount => v === "at_least_65535" || (integer(v) && v < 65_535);
export function validateDiagnosticReport(bytes: Buffer, freshIds = false): Buffer {
  if (bytes.length > DIAGNOSTIC_LIMITS.maxReportBytes) throw new Error("capacity_limited");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const r = JSON.parse(text) as DiagnosticReport;
  if (
    !r ||
    typeof r !== "object" ||
    !identifier(r.reportId) ||
    !identifier(r.sessionId) ||
    r.reportId === r.sessionId ||
    !r.coverage ||
    !r.omissions ||
    !Array.isArray(r.events) ||
    r.events.length > DIAGNOSTIC_LIMITS.maxEvents ||
    !integer(r.coverage.requestedWindowMs) ||
    r.coverage.requestedWindowMs % 60_000 !== 0 ||
    r.coverage.requestedWindowMs < 60_000 ||
    r.coverage.requestedWindowMs > 900_000 ||
    !integer(r.coverage.observedWindowMs) ||
    r.coverage.observedWindowMs > r.coverage.requestedWindowMs ||
    !integer(r.coverage.retainedWindowMs) ||
    r.coverage.retainedWindowMs > r.coverage.observedWindowMs ||
    typeof r.coverage.capacityLimited !== "boolean" ||
    !count(r.omissions.budget) ||
    !count(r.omissions.expired) ||
    !count(r.omissions.invalid)
  )
    throw new Error("unavailable");
  let last = 0;
  for (const e of r.events) {
    if (
      !e ||
      typeof e !== "object" ||
      !allowedEvent(e.phase, e.code) ||
      !integer(e.offsetMs) ||
      e.offsetMs < last ||
      e.offsetMs > r.coverage.observedWindowMs ||
      e.entityAlias !== "unknown"
    )
      throw new Error("unavailable");
    last = e.offsetMs;
  }
  const rebuilt = diagnosticReport(
    r.reportId,
    r.sessionId,
    {
      requestedWindowMs: r.coverage.requestedWindowMs,
      observedWindowMs: r.coverage.observedWindowMs,
      retainedWindowMs: r.coverage.retainedWindowMs,
      capacityLimited: r.coverage.capacityLimited,
    },
    { budget: r.omissions.budget, expired: r.omissions.expired, invalid: r.omissions.invalid },
    r.events.map((e) => ({ offsetMs: e.offsetMs, phase: e.phase, code: e.code, entityAlias: "unknown" })),
  );
  // Exact reconstruction rejects unknown fields, secret-bearing metadata, duplicate keys,
  // noncanonical representations and content-bearing nested input, without editing a preview.
  if (canonicalJson(rebuilt) !== text) throw new Error("unavailable");
  if (!freshIds) return bytes;
  return Buffer.from(canonicalJson({ ...rebuilt, reportId: randomUUID(), sessionId: randomUUID() }));
}
