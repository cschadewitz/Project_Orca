/** Canonical immutable snapshot shape. Unimplemented producers remain explicitly unknown. */
import {
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_LIMITS,
  type DiagnosticCode,
  type DiagnosticCount,
  type DiagnosticPhase,
} from "./profile.js";
import { completeReportWork, REPORT_BATCH_EVENTS, scheduleReportWork } from "./report-work.js";
import type { ControlledPayloadMemory, PayloadLease } from "./payload-memory.js";

export interface DiagnosticEvent {
  readonly offsetMs: number;
  readonly phase: DiagnosticPhase;
  readonly code: DiagnosticCode;
  readonly entityAlias: "unknown";
}

export interface DiagnosticEventSource {
  readonly size: number;
  readonly events: Iterable<DiagnosticEvent>;
}

export interface DiagnosticCoverage {
  readonly requestedWindowMs: number;
  readonly observedWindowMs: number;
  readonly retainedWindowMs: number;
  readonly capacityLimited: boolean;
}

export interface DiagnosticOmissions {
  readonly budget: DiagnosticCount;
  readonly expired: DiagnosticCount;
  readonly invalid: DiagnosticCount;
}

export function diagnosticReport(
  reportId: string,
  sessionId: string,
  coverage: DiagnosticCoverage,
  omissions: DiagnosticOmissions,
  events: readonly DiagnosticEvent[],
) {
  return {
    schemaVersion: 1,
    reportId,
    sessionId,
    mode: "rolling_snapshot" as const,
    windowMs: coverage.observedWindowMs,
    coverage,
    versions: {
      app: "unknown",
      daemon: "unknown",
      buildRevision: "unknown",
      appProtocol: "unknown",
      daemonProtocol: "unknown",
      storeFormat: "unknown",
      os: "unknown",
      osVersion: "unknown",
      arch: "unknown",
    },
    snapshot: {
      connection: "unknown",
      authentication: "unknown",
      admission: "unknown",
      resume: "unknown",
      protectedState: "unknown",
    },
    evidence: {
      handshake: "unknown",
      admissionObservation: "unknown",
      resumeObservation: "unknown",
      protectedStateObservation: "unknown",
    },
    entities: [],
    events,
    omissions: { ...omissions, unavailable: "unknown" },
  };
}

export type DiagnosticReport = ReturnType<typeof diagnosticReport>;

/** Called only with bounded internally constructed data, never a producer's payload. */
export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(
      value,
      (_key, item: unknown) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          const record = item as Record<string, unknown>;
          return Object.fromEntries(
            Object.keys(record)
              .sort()
              .map((key) => [key, record[key]]),
          );
        }
        return item;
      },
      2,
    ) + "\n"
  );
}

/** Fixed event framing for the closed vocabulary, identical to canonicalJson. */
const eventFraming = new Map<string, readonly [string, string]>();
for (const phase of Object.keys(DIAGNOSTIC_CODES) as DiagnosticPhase[]) {
  for (const code of DIAGNOSTIC_CODES[phase]) {
    eventFraming.set(`${phase}:${code}`, [
      `    {\n      "code": ${JSON.stringify(code)},\n      "entityAlias": "unknown",\n      "offsetMs": `,
      `,\n      "phase": ${JSON.stringify(phase)}\n    }`,
    ]);
  }
}

const eventTemplates = [...eventFraming.values()];

/** Internally constructed reports only; authenticated input must be rebuilt first. */
export function diagnosticEventText(event: DiagnosticEvent): string {
  const framing = eventFraming.get(`${event.phase}:${event.code}`);
  if (!framing) throw new Error("unavailable");
  return framing[0] + String(event.offsetMs) + framing[1];
}

/** Exact closed canonical grammar, without allocating a parsed event or rebuilt string. */
export function diagnosticEventOffset(text: string, start: number, end: number): number {
  for (let index = 0; index < eventTemplates.length; index++) {
    const [prefix, suffix] = eventTemplates[index]!;
    if (!text.startsWith(prefix, start)) continue;
    let cursor = start + prefix.length;
    if (cursor >= end) continue;
    const first = text.charCodeAt(cursor);
    if (first < 48 || first > 57) continue;
    let offset = first - 48;
    cursor++;
    while (cursor < end) {
      const digit = text.charCodeAt(cursor) - 48;
      if (digit < 0 || digit > 9) break;
      // Canonical integers never have leading zeroes. Cap before arithmetic
      // can overflow; the report's observed window supplies the tighter bound.
      if (first === 48) throw new Error("unavailable");
      offset = offset * 10 + digit;
      if (offset > maximumWindow) throw new Error("unavailable");
      cursor++;
    }
    if (cursor + suffix.length === end && text.startsWith(suffix, cursor)) return offset;
  }
  throw new Error("unavailable");
}

export function* diagnosticReportWork(
  report: DiagnosticReport,
  payload?: ControlledPayloadMemory,
  source?: DiagnosticEventSource,
): Generator<void, string> {
  const lease = payload?.allocate(DIAGNOSTIC_LIMITS.maxReportBytes);
  const output = lease?.bytes ?? Buffer.allocUnsafe(DIAGNOSTIC_LIMITS.maxReportBytes);
  try {
    const length = yield* diagnosticSerializationWork(report, output, source);
    return output.toString("utf8", 0, length);
  } finally {
    lease?.release();
  }
}

/** Checkpoint plaintext stays in its arena lease; no full-size heap string is needed. */
export function canonicalOwnedDiagnosticReportAsync(
  report: DiagnosticReport,
  payload: ControlledPayloadMemory,
  source?: DiagnosticEventSource,
): Promise<PayloadLease> {
  function* work(): Generator<void, PayloadLease> {
    const lease = payload.allocate(DIAGNOSTIC_LIMITS.maxReportBytes);
    let transferred = false;
    try {
      const length = yield* diagnosticSerializationWork(report, lease.bytes, source);
      const result = { bytes: lease.bytes.subarray(0, length), release: () => lease.release() };
      transferred = true;
      return result;
    } finally {
      if (!transferred) lease.release();
    }
  }
  return scheduleReportWork(work());
}

function* diagnosticSerializationWork(
  report: DiagnosticReport,
  output: Buffer,
  source?: DiagnosticEventSource,
): Generator<void, number> {
  // The envelope is small/fixed. Never send the growing event array through the
  // generic per-object sort/replacer or serialize the whole report in one turn.
  const envelope = canonicalJson({ ...report, events: [] });
  if (Buffer.byteLength(envelope) > output.length) throw new Error("capacity_limited");
  if ((source?.size ?? report.events.length) === 0) return output.write(envelope, "utf8");
  const marker = '  "events": []';
  const start = envelope.indexOf(marker);
  if (start < 0) throw new Error("unavailable");
  // One bounded output allocation avoids retaining tens of thousands of string
  // fragments and flattening them together in the final main-process callback.
  let offset = 0;
  const append = (part: string): void => {
    if (offset + Buffer.byteLength(part) > output.length) throw new Error("capacity_limited");
    offset += output.write(part, offset, "utf8");
  };
  append(envelope.slice(0, start));
  append('  "events": [\n');
  let index = 0;
  for (const event of source?.events ?? report.events) {
    const framing = eventFraming.get(`${event.phase}:${event.code}`);
    if (!framing) throw new Error("unavailable");
    if (index !== 0) append(",\n");
    append(framing[0]);
    append(String(event.offsetMs));
    append(framing[1]);
    if (++index % REPORT_BATCH_EVENTS === 0) yield;
  }
  append("\n  ]");
  append(envelope.slice(start + marker.length));
  return offset;
}

export function canonicalDiagnosticReport(report: DiagnosticReport): string {
  return completeReportWork(diagnosticReportWork(report));
}

export function canonicalDiagnosticReportAsync(
  report: DiagnosticReport,
  payload?: ControlledPayloadMemory,
  source?: DiagnosticEventSource,
): Promise<string> {
  return scheduleReportWork(diagnosticReportWork(report, payload, source));
}

// Reserve the maximum complete envelope, including future offset digits, saturation
// strings and pretty-print framing. Retention and snapshots share ONE byte budget.
const maximumWindow = DIAGNOSTIC_LIMITS.maxMinutes * 60_000;
const uuid = "00000000-0000-4000-8000-000000000000";
const maximumEnvelope = diagnosticReport(
  uuid,
  uuid,
  {
    requestedWindowMs: maximumWindow,
    observedWindowMs: maximumWindow,
    retainedWindowMs: maximumWindow,
    capacityLimited: false,
  },
  { budget: "at_least_65535", expired: "at_least_65535", invalid: "at_least_65535" },
  [],
);
export const DIAGNOSTIC_ENVELOPE_BYTES = Buffer.byteLength(canonicalJson(maximumEnvelope));

/** Marginal report bytes for this enum pair at the largest possible offset. */
function reserveEvent(phase: DiagnosticPhase, code: DiagnosticCode): number {
  const event: DiagnosticEvent = { phase, code, offsetMs: maximumWindow, entityAlias: "unknown" };
  const one = Buffer.byteLength(canonicalJson({ ...maximumEnvelope, events: [event] }));
  // The first event includes opening/closing line breaks; charging that for every
  // event is conservative and avoids whole-buffer serialization on observation.
  return one - DIAGNOSTIC_ENVELOPE_BYTES;
}

// Fixed vocabulary, calculated once. Observation does no serialization or growing cache work.
const reservations = new Map<string, number>();
for (const phase of Object.keys(DIAGNOSTIC_CODES) as DiagnosticPhase[]) {
  for (const code of DIAGNOSTIC_CODES[phase]) reservations.set(`${phase}:${code}`, reserveEvent(phase, code));
}

export function eventReservation(phase: DiagnosticPhase, code: DiagnosticCode): number {
  return reservations.get(`${phase}:${code}`)!;
}
