/** Canonical immutable snapshot shape. Unimplemented producers remain explicitly unknown. */
import {
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_LIMITS,
  type DiagnosticCode,
  type DiagnosticCount,
  type DiagnosticPhase,
} from "./profile.js";

export interface DiagnosticEvent {
  readonly offsetMs: number;
  readonly phase: DiagnosticPhase;
  readonly code: DiagnosticCode;
  readonly entityAlias: "unknown";
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
