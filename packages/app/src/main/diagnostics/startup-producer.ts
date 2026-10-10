/** Only the local startup owner can observe these facts; no error/text classifier. */
import { allowedEvent, type DIAGNOSTIC_CODES } from "./profile.js";
import type { RecoveryController } from "./recovery-controller.js";

export type StartupDiagnosticCode = Exclude<(typeof DIAGNOSTIC_CODES)["startup"][number], "unknown">;
export type StartupDiagnosticObserver = (code: StartupDiagnosticCode) => void;

/** Controller remains the sole consent/clock/budget fence. No queue or history copy. */
export function startupDiagnosticObserver(controller: Pick<RecoveryController, "record">): StartupDiagnosticObserver {
  return (code) => {
    const observation: unknown = code;
    if (observation === "unknown" || !allowedEvent("startup", observation)) return;
    try {
      controller.record("startup", code);
    } catch {
      // Optional diagnostics never changes startup success, retries or rejection.
    }
  };
}

export function observeStartup(observer: StartupDiagnosticObserver | undefined, code: StartupDiagnosticCode): void {
  try {
    observer?.(code);
  } catch {
    // Never let optional observation escape into the process owner's control flow.
  }
}
