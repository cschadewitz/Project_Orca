/** Closed owner facts only. No source object, identifiers, retry or additional observation. */
import { allowedEvent, type DIAGNOSTIC_CODES, type DiagnosticPhase } from "./profile.js";
import type { RecoveryController } from "./recovery-controller.js";
export type OwnedDiagnosticObservation = {
  [Phase in Exclude<DiagnosticPhase, "unknown">]: [
    phase: Phase,
    code: Exclude<(typeof DIAGNOSTIC_CODES)[Phase][number], "unknown">,
  ];
}[Exclude<DiagnosticPhase, "unknown">];
export type OwnedDiagnosticObserver = (...fact: OwnedDiagnosticObservation) => void;

/** Optional observation cannot change the owner's control flow. Controller owns consent. */
export function observeOwnedDiagnostic(
  observer: OwnedDiagnosticObserver | undefined,
  ...fact: OwnedDiagnosticObservation
): void {
  try {
    observer?.(...fact);
  } catch {
    /* No diagnostics exception escapes into execution. */
  }
}
export function ownedDiagnosticObserver(controller: Pick<RecoveryController, "record">): OwnedDiagnosticObserver {
  return (phase, code) => {
    const offered: unknown = code;
    if (offered === "unknown" || !allowedEvent(phase, code)) return;
    try {
      controller.record(phase, code);
    } catch {
      /* No queue, copy or fallback. */
    }
  };
}
