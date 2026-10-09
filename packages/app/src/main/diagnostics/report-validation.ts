/** Validate bounded authenticated bytes against the closed enum-only producer slice. */
import { randomUUID } from "node:crypto";
import { allowedEvent, DIAGNOSTIC_LIMITS, type DiagnosticCount } from "./profile.js";
import {
  diagnosticReport,
  diagnosticReportWork,
  DIAGNOSTIC_ENVELOPE_BYTES,
  type DiagnosticReport,
  type DiagnosticEvent,
} from "./snapshot.js";
import { completeReportWork, REPORT_BATCH_EVENTS, scheduleReportWork } from "./report-work.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifier = (v: unknown): v is string => typeof v === "string" && v.length === 36 && uuid.test(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const count = (v: unknown): v is DiagnosticCount => v === "at_least_65535" || (integer(v) && v < 65_535);
export function validateDiagnosticReport(bytes: Buffer, freshIds = false): Buffer {
  return completeReportWork(validationWork(bytes, freshIds));
}

export function validateDiagnosticReportAsync(bytes: Buffer, freshIds = false): Promise<Buffer> {
  return scheduleReportWork(validationWork(bytes, freshIds));
}

function* validationWork(bytes: Buffer, freshIds: boolean): Generator<void, Buffer> {
  if (bytes.length > DIAGNOSTIC_LIMITS.maxReportBytes) throw new Error("capacity_limited");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // Read only canonical framing, then parse the small envelope and individual
  // bounded events. Exact reconstruction below remains the acceptance oracle;
  // no input reaches a whole-report JSON.parse in a deferred main callback.
  const marker = '  "events": [';
  const start = text.indexOf(marker);
  if (start < 0) throw new Error("unavailable");
  const contentStart = start + marker.length;
  const empty = text[contentStart] === "]";
  const contentEnd = empty ? contentStart : text.indexOf("\n  ]", contentStart);
  if (contentEnd < 0) throw new Error("unavailable");
  const closing = empty ? contentEnd : contentEnd + 3;
  const envelope = text.slice(0, contentStart) + text.slice(closing);
  if (Buffer.byteLength(envelope) > DIAGNOSTIC_ENVELOPE_BYTES) throw new Error("unavailable");
  const r = JSON.parse(envelope) as DiagnosticReport;
  yield;
  if (
    !r ||
    typeof r !== "object" ||
    !identifier(r.reportId) ||
    !identifier(r.sessionId) ||
    r.reportId === r.sessionId ||
    !r.coverage ||
    !r.omissions ||
    !Array.isArray(r.events) ||
    r.events.length !== 0 ||
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
  const events: DiagnosticEvent[] = [];
  let cursor = contentStart;
  while (cursor < contentEnd) {
    if (events.length >= DIAGNOSTIC_LIMITS.maxEvents) throw new Error("unavailable");
    const separator = text.indexOf(",\n    {", cursor);
    const end = separator < 0 || separator >= contentEnd ? contentEnd : separator;
    // The vocabulary is ASCII. A character cap bounds each parse, while the
    // existing byte cap and exact oracle reject any noncanonical/extra content.
    if (end - cursor > DIAGNOSTIC_LIMITS.maxEventBytes) throw new Error("unavailable");
    const e = JSON.parse(text.slice(cursor, end)) as DiagnosticEvent;
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
    events.push({ offsetMs: e.offsetMs, phase: e.phase, code: e.code, entityAlias: "unknown" });
    cursor = end + 1;
    if (events.length % REPORT_BATCH_EVENTS === 0) yield;
  }
  const first = events[0];
  const retainedWindowMs = first ? r.coverage.observedWindowMs - first.offsetMs : 0;
  if (r.coverage.retainedWindowMs !== retainedWindowMs) throw new Error("unavailable");
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
    events,
  );
  // Exact reconstruction rejects unknown fields, secret-bearing metadata, duplicate keys,
  // noncanonical representations and content-bearing nested input, without editing a preview.
  if ((yield* diagnosticReportWork(rebuilt)) !== text) throw new Error("unavailable");
  // Text is immutable across yielded turns. Return its validated bytes rather
  // than a caller-owned Buffer that could have changed during reconstruction.
  if (!freshIds) return Buffer.from(text);
  return Buffer.from(yield* diagnosticReportWork({ ...rebuilt, reportId: randomUUID(), sessionId: randomUUID() }));
}
