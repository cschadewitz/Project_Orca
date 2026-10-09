/** Compose the existing signed native handoff with durable complete-pair recovery. Disabled by default. */
import type { MacNativeCommitOwner, MacNativeCommitRequest } from "./mac-native-handoff.js";
import {
  MacReplacementRecovery,
  type MacProtectedOwner,
  type MacRecoveryJournal,
  type MacReplacementPorts,
} from "./mac-replacement-recovery.js";
import type { RuntimeMaintenanceTargetSchema } from "@orca/protocol";
import type { z } from "zod";
import { macAbortable, macBounded } from "./mac-candidate-download.js";

export interface MacReplacementAuthorization {
  readonly token: string;
  readonly previousTarget: z.infer<typeof RuntimeMaintenanceTargetSchema>;
  readonly previousManifestSha256: string;
}
export interface MacReplacementCommitPorts {
  /** Current exact approval, trusted candidate/compatibility, drafts/admission and accepted signed
   * native lifecycle. Returns no authorization if any independent production gate is unproven. */
  authorize(
    this: void,
    request: MacNativeCommitRequest,
    signal: AbortSignal,
  ): Promise<MacReplacementAuthorization | undefined>;
  /** Captures every configured protected writer (including app intent/preferences/diagnostics,
   * daemon, CLI/ACP and migration) under the same durable replacement admission owner. */
  acquireWriters(
    this: void,
    authorization: MacReplacementAuthorization,
    signal: AbortSignal,
  ): Promise<MacProtectedOwner | undefined>;
  readonly journal: MacRecoveryJournal;
  readonly replacement: MacReplacementPorts;
}

/** One process-local attempt. After acquiring writers/starting stop, any failure is unknown;
 * ordinary quit cannot escalate it. Missing accepted native/recovery ownership refuses untouched.
 */
export class MacReplacementCommit implements MacNativeCommitOwner {
  private identity: string | undefined;
  private lease: MacNativeCommitRequest["lease"] | undefined;
  private attempt: Promise<"ready" | "refused" | "unknown"> | undefined;
  constructor(
    private readonly ports?: MacReplacementCommitPorts,
    private readonly operationMs = 0,
  ) {}
  prepare(request: MacNativeCommitRequest): Promise<"ready" | "refused" | "unknown"> {
    const identity = JSON.stringify([
      request.prepared.binding.candidate,
      request.prepared.target,
      request.lease.target,
    ]);
    if (this.attempt)
      return identity === this.identity && request.lease === this.lease ? this.attempt : Promise.resolve("unknown");
    if (!this.ports || !request.lease.stopOwned || !Number.isSafeInteger(this.operationMs) || this.operationMs <= 0)
      return Promise.resolve("refused");
    this.identity = identity;
    this.lease = request.lease;
    this.attempt = Promise.resolve().then(async () => {
      try {
        return await macBounded(new AbortController().signal, this.operationMs, async (signal) => {
          const authorize = this.ports!.authorize;
          const approval = await macAbortable(() => authorize(request, signal), signal);
          if (!approval) return "refused";
          if (request.lease.token !== approval.token) return "unknown";
          const captured = Object.freeze(structuredClone(approval));
          const writers = await macAbortable(() => this.ports!.acquireWriters(captured, signal), signal);
          if (!writers || !writers.check()) return "unknown";
          const fresh = await macAbortable(() => authorize(request, signal), signal);
          if (!fresh || JSON.stringify(fresh) !== JSON.stringify(captured) || !writers.check()) return "unknown";
          const stopped = await request.lease.stopOwned!(signal, this.operationMs);
          if (
            stopped.outcome !== "stopped" ||
            !writers.check() ||
            !writers.stopped() ||
            JSON.stringify(stopped.receipt.target) !== JSON.stringify(captured.previousTarget)
          )
            return "unknown";
          const final = await macAbortable(() => authorize(request, signal), signal);
          if (!final || JSON.stringify(final) !== JSON.stringify(captured) || !writers.check()) return "unknown";
          const recovery = new MacReplacementRecovery(
            this.ports!.journal,
            writers,
            this.ports!.replacement,
            this.operationMs,
          );
          const result = await recovery.prepare({ candidate: request.prepared.binding.candidate, ...captured }, signal);
          if (result.outcome !== "prepared-closed") return "unknown";
          const last = await macAbortable(() => authorize(request, signal), signal);
          return last && JSON.stringify(last) === JSON.stringify(captured) && writers.check() && !signal.aborted
            ? "ready"
            : "unknown";
        });
      } catch {
        return "unknown";
      }
    });
    return this.attempt;
  }
}
