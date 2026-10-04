/** Failure-only evidence: never serialize event payloads, error messages or receipt identities. */
import type { ContinuationReceiptSchema } from "@orca/protocol";
import type { z } from "zod";

export function continuationDiagnostics(
  events: { seq: number; type: string; payload: Record<string, unknown> }[],
  receipt: z.infer<typeof ContinuationReceiptSchema> | undefined,
  leaseFilePresent: boolean | "unavailable",
  error: unknown,
) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const knownCodes = ["RUN_STATE", "RUN_LEASED", "CONTINUATION_STALE", "AUTH_FORBIDDEN", "AUTH_UNAUTHORIZED"];
  const milestones = events.filter((event) =>
    ["continuation.recorded", "run.resumed", "run.paused", "run.completed", "run.failed", "run.cancelled"].includes(
      event.type,
    ),
  );
  return {
    errorCode: typeof code === "string" && knownCodes.includes(code) ? code : "OTHER",
    receiptState: receipt?.state,
    blockedReason: receipt?.blockedReason,
    leaseFilePresent,
    // The public accepted/accepted/settled markers expose dispatch milestones
    // without opening the protected entry. Keep only the last 32 milestones.
    milestones: milestones.slice(-32).map((event) => ({
      seq: event.seq,
      type: event.type,
      ...(event.type === "continuation.recorded" &&
      ["prepared", "accepted", "blocked", "settled"].includes(String(event.payload.state))
        ? { state: event.payload.state }
        : {}),
    })),
    truncated: milestones.length > 32,
  };
}
