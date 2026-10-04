/** Revision drafts retain their intent key across response loss and never follow a switched target. */
import type {
  RevisionBoundaryView,
  RevisionPayload,
  RevisionReceipt,
  PendingRevisionTarget,
} from "../../../../protocol/src/revision-input.js";

export function revisionDraftScope(connectionScope: string, boundary: RevisionBoundaryView): string {
  const { runId, stepRunId, requestId, destinationId } = boundary.target;
  return JSON.stringify([connectionScope, runId, stepRunId, requestId, destinationId]);
}
export function pendingTarget(receipt: RevisionReceipt): PendingRevisionTarget {
  return {
    runId: receipt.target.runId,
    revisionId: receipt.revisionId,
    destinationId: receipt.target.destinationId,
    attemptId: receipt.attemptId,
  };
}
export function revisionDraftPayload(text: string, kind: "text" | "values", maxBytes: number): RevisionPayload {
  if (!text.trim()) throw new Error("Enter a correction first.");
  if (new TextEncoder().encode(text).length > maxBytes) throw new Error("The correction exceeds the workflow limit.");
  if (kind === "text") return { kind, text };
  let values: unknown;
  try {
    values = JSON.parse(text);
  } catch {
    throw new Error("Enter a JSON object for the correction values.");
  }
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error("Enter a JSON object for the correction values.");
  return { kind, values: values as Record<string, unknown> };
}
export const REVISION_LABELS = {
  pending: "Pending",
  delivered: "Delivered",
  rejected: "Rejected",
  superseded: "Superseded",
} as const;
export const REVISION_REASONS = {
  delivered: "The agent has already received this correction. It cannot be replaced.",
  "target-changed": "The destination or active correction changed. Review the current correction before submitting.",
  cancelled: "The run was cancelled. This correction will not be delivered.",
  "delivery-uncertain":
    "A handoff was claimed. Delivery is not confirmed; replacement and automatic replay are blocked.",
} as const;
