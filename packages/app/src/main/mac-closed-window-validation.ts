/** Same-window replacement startup validation using the existing whole-image verifier. */
import type { ClosedUpdateWindow } from "@orca/protocol/update-window";
import type { MacFixedPathRecovery, FixedStartupIdentity } from "./mac-fixed-path-recovery.js";
import { MacRestartVerification, type MacRestartProcess, type MacRestartResult } from "./mac-update-restart.js";
import { macBounded, macAbortable } from "./mac-candidate-download.js";

export interface ClosedValidationPorts {
  /** Start exactly one independently owned matching-binary child with --read-only,
   * --no-resume and the one-use main-only capability. Native image/continuity acceptance
   * precedes launch. Unknown never retries, adopts another PID or falls back to normal serve. */
  startClosed(
    identity: FixedStartupIdentity,
    permit: { attempt: string; token: string },
    signal: AbortSignal,
  ): Promise<MacRestartProcess | undefined>;
}
export class MacClosedWindowValidation {
  private operation: Promise<MacRestartResult> | undefined;
  private child: MacRestartProcess["child"] | undefined;
  constructor(
    private readonly window: ClosedUpdateWindow,
    private readonly recovery: MacFixedPathRecovery,
    private readonly ports: ClosedValidationPorts,
    private readonly operationMs: number,
  ) {}
  verify(signal: AbortSignal): Promise<MacRestartResult> {
    return (this.operation ??= Promise.resolve().then(async () => {
      try {
        return await macBounded(signal, this.operationMs, async (bounded) => {
          if (!this.window.check() || this.window.snapshot.phase !== "closed")
            return { outcome: "refused", reason: "ownership" };
          const identity = await this.recovery.readStartupIdentity(bounded),
            permit = await this.window.beginMigration();
          const process = await macAbortable(() => this.ports.startClosed(identity, permit, bounded), bounded);
          if (!process || process.fenceId !== permit.attempt) return { outcome: "unknown" };
          this.child = process.child;
          const ownerCurrent = () => this.window.migrationHeld() && this.window.snapshot.attempt === permit.attempt;
          const verification = new MacRestartVerification(
            { startClosed: async () => ({ outcome: "unknown" }), check: ownerCurrent },
            this.operationMs,
          );
          const result = await verification.inspectExistingClosed(
            {
              previous: identity.previousTarget,
              candidate: identity.candidate,
              manifestBytes: Buffer.from(identity.manifestBase64, "base64"),
              storeDir: identity.storeDir,
              capabilities: ["runs.read", "runs.subscribe"],
              methods: ["hello", "maintenance", "runs.list"],
              process,
              fenceId: permit.attempt,
            },
            bounded,
          );
          // Every result stays closed while this owned read-only child is alive. The caller
          // may request its ordinary clean shutdown, then endMigration reacquires all slots.
          // Only an accepted verification can mark the captured window validated afterward.
          return result;
        });
      } catch {
        return { outcome: "unknown" };
      }
    }));
  }
  async finishAfterCleanChildExit(
    signal: AbortSignal,
    stop?: () => Promise<boolean>,
  ): Promise<"validated-closed" | "unknown"> {
    if (signal.aborted || !this.operation) return "unknown";
    const result = await this.operation;
    if (result.outcome !== "verified-closed" || signal.aborted || (stop && !(await stop()))) return "unknown";
    if (
      this.child?.exitCode !== 0 ||
      this.child.signalCode !== null ||
      this.child.pid !== result.startup.target.processId ||
      !(await this.window.endMigration()) ||
      signal.aborted
    )
      return "unknown";
    this.window.setPhase("validated");
    return "validated-closed";
  }
}
