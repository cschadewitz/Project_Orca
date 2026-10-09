/** Validate bounded authenticated bytes against the closed enum-only producer slice. */
import { randomUUID } from "node:crypto";
import { DIAGNOSTIC_LIMITS, type DiagnosticCount } from "./profile.js";
import {
  diagnosticReport,
  canonicalJson,
  diagnosticEventOffset,
  DIAGNOSTIC_ENVELOPE_BYTES,
  type DiagnosticReport,
} from "./snapshot.js";
import type { ControlledPayloadMemory, PayloadLease } from "./payload-memory.js";
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

/** Production profile owns the returned lease through preview disposal. */
export async function validateOwnedDiagnosticReport(
  bytes: Buffer,
  freshIds: boolean,
  payload: ControlledPayloadMemory,
): Promise<{ payload: PayloadLease; text: string }> {
  const text = await scheduleReportWork(validationTextWork(bytes, freshIds));
  return { payload: payload.from(text), text };
}

/** Internally frozen text is already immutable; do not encode and decode it again. */
export async function validateOwnedDiagnosticText(
  text: string,
  payload: ControlledPayloadMemory,
): Promise<{ payload: PayloadLease; text: string }> {
  if (Buffer.byteLength(text) > DIAGNOSTIC_LIMITS.maxReportBytes) throw new Error("capacity_limited");
  const validated = await scheduleReportWork(validationCanonicalTextWork(text, false));
  return { payload: payload.from(validated), text: validated };
}

function* validationWork(bytes: Buffer, freshIds: boolean): Generator<void, Buffer> {
  return Buffer.from(yield* validationTextWork(bytes, freshIds));
}

function* validationTextWork(bytes: Buffer, freshIds: boolean): Generator<void, string> {
  if (bytes.length > DIAGNOSTIC_LIMITS.maxReportBytes) throw new Error("capacity_limited");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return yield* validationCanonicalTextWork(text, freshIds);
}

function* validationCanonicalTextWork(text: string, freshIds: boolean): Generator<void, string> {
  // Read canonical framing, parse only the small envelope and scan each bounded
  // event against the exact closed grammar. Reconstruction is the envelope oracle;
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
  let countEvents = 0;
  let firstOffset: number | undefined;
  let cursor = contentStart;
  while (cursor < contentEnd) {
    if (countEvents >= DIAGNOSTIC_LIMITS.maxEvents) throw new Error("unavailable");
    const separator = text.indexOf(",\n    {", cursor);
    const end = separator < 0 || separator >= contentEnd ? contentEnd : separator;
    // The vocabulary is ASCII. A character cap bounds each scan, while the
    // existing byte cap and exact oracle reject any noncanonical/extra content.
    if (end - cursor > DIAGNOSTIC_LIMITS.maxEventBytes) throw new Error("unavailable");
    if (text[cursor] !== "\n") throw new Error("unavailable");
    const offset = diagnosticEventOffset(text, cursor + 1, end);
    if (offset < last || offset > r.coverage.observedWindowMs) throw new Error("unavailable");
    last = offset;
    firstOffset ??= offset;
    countEvents++;
    cursor = end + 1;
    if (countEvents % REPORT_BATCH_EVENTS === 0) yield;
  }
  const retainedWindowMs = firstOffset === undefined ? 0 : r.coverage.observedWindowMs - firstOffset;
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
    [],
  );
  // Exact reconstruction rejects unknown fields, secret-bearing metadata, duplicate keys,
  // noncanonical representations and content-bearing nested input, without editing a preview.
  if (canonicalJson(rebuilt) !== envelope) throw new Error("unavailable");
  // Text is immutable across yielded turns. Return its validated bytes rather
  // than a caller-owned Buffer that could have changed during reconstruction.
  if (!freshIds) return text;
  const reportText = text.replace(`"reportId": "${r.reportId}"`, `"reportId": "${randomUUID()}"`);
  yield;
  return reportText.replace(`"sessionId": "${r.sessionId}"`, `"sessionId": "${randomUUID()}"`);
}
