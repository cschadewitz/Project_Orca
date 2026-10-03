/** Draft volatile diagnostics limits and closed event vocabulary; not collection consent. */
export const DIAGNOSTIC_LIMITS = Object.freeze({
  defaultMinutes: 5,
  minMinutes: 1,
  maxMinutes: 15,
  maxEvents: 4096,
  maxReportBytes: 1_048_576,
  maxEventBytes: 512,
});

export const DIAGNOSTIC_CODES = Object.freeze({
  startup: ["startup_spawn_failed", "startup_exited_before_handshake", "startup_handshake_timeout", "unknown"],
  connection: [
    "connection_unavailable",
    "connection_lost",
    "protocol_mismatch",
    "authentication_required",
    "authentication_invalid",
    "authorization_denied",
    "unknown",
  ],
  admission: ["admission_uncertain", "admission_recoverable_failure", "unknown"],
  resume: ["resume_failed", "unknown"],
  protected_state: ["protected_state_unavailable", "unknown"],
  lifecycle: ["app_started", "app_stopping", "sleep_observed", "wake_observed", "unknown"],
  run: ["run_failed", "unknown"],
  unknown: ["unknown"],
} as const);

for (const codes of Object.values(DIAGNOSTIC_CODES)) Object.freeze(codes);

export type DiagnosticPhase = keyof typeof DIAGNOSTIC_CODES;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[DiagnosticPhase][number];
export type DiagnosticCount = number | "at_least_65535";

/** Primitive-only boundary: never traverse, stringify, coerce or retain a source object. */
export function allowedEvent(phase: unknown, code: unknown): phase is DiagnosticPhase {
  if (typeof phase !== "string" || phase.length > 15 || typeof code !== "string" || code.length > 40) return false;
  if (!Object.hasOwn(DIAGNOSTIC_CODES, phase)) return false;
  return (DIAGNOSTIC_CODES[phase as DiagnosticPhase] as readonly string[]).includes(code);
}

export function omissionCount(value: number): DiagnosticCount {
  return value >= 65_535 ? "at_least_65535" : value;
}
