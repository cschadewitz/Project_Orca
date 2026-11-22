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

/**
 * Composition (#398). The runtime keeps one pending correction per slot; composing is a draft
 * convenience on top of it, never a second queue. Append keeps the pending text and adds the
 * draft after it; replace sends the draft alone. Either way the result is one payload, shown
 * whole before submission.
 */
export type RevisionComposeMode = "append" | "replace";
export const REVISION_APPEND_SEPARATOR = "\n\n";
/** Values are an object, not prose: appending one to another would be a semantic merge (a non-goal). */
export function composeModes(kind: "text" | "values", pending: RevisionPayload | undefined): RevisionComposeMode[] {
  return kind === "text" && pending?.kind === "text" ? ["append", "replace"] : ["replace"];
}
export function composeRevisionText(
  pending: RevisionPayload | undefined,
  draft: string,
  mode: RevisionComposeMode,
): string {
  if (mode === "replace" || pending?.kind !== "text" || !pending.text.trim()) return draft;
  if (!draft.trim()) return pending.text;
  return `${pending.text.replace(/\s+$/, "")}${REVISION_APPEND_SEPARATOR}${draft}`;
}
/** The text a payload reads as in an editor: prose as written, values as indented JSON. */
export function revisionPayloadText(payload: RevisionPayload): string {
  return payload.kind === "text" ? payload.text : JSON.stringify(payload.values, null, 2);
}
/** Text added to a draft from history goes after what is already there; it never overwrites it. */
export function addToDraft(draft: string, text: string): string {
  return draft.trim() ? `${draft.replace(/\s+$/, "")}${REVISION_APPEND_SEPARATOR}${text}` : text;
}

/**
 * A correction version this window has read. History is what the protected pending read has
 * shown here, held in memory for the card's lifetime: never persisted, never sent anywhere,
 * never resubmitted on its own. It is a source of text to copy, not a second ledger.
 */
export interface RevisionVersionSeen {
  key: string;
  revisionId: string;
  state: RevisionReceipt["state"];
  payload: RevisionPayload;
}
export const REVISION_HISTORY_LIMIT = 10;
export function recordRevisionVersion(
  history: readonly RevisionVersionSeen[],
  pending:
    | {
        target: PendingRevisionTarget;
        expectedRevision: string;
        state: RevisionReceipt["state"];
        payload?: RevisionPayload | undefined;
      }
    | undefined,
): readonly RevisionVersionSeen[] {
  if (!pending?.payload) return history;
  const key = JSON.stringify([pending.target.revisionId, pending.expectedRevision]);
  const text = JSON.stringify(pending.payload);
  const existing = history.find((entry) => entry.key === key);
  if (existing && existing.state === pending.state && JSON.stringify(existing.payload) === text) return history;
  const entry = { key, revisionId: pending.target.revisionId, state: pending.state, payload: pending.payload };
  const rest = history.filter((item) => item.key !== key);
  return [entry, ...rest].slice(0, REVISION_HISTORY_LIMIT);
}

/**
 * Provenance for text copied into a draft from a protected read (#398 review). Positions in a
 * freely edited string cannot say who wrote what, so this records only what is certain: the
 * draft as the person left it before the first copy (`base`), and the draft as the last copy
 * left it (`after`). While the draft still equals `after`, `base` is exactly the person's own
 * text. Any edit after a copy makes the mix ambiguous (`base: null`).
 */
export interface ImportedDraft {
  base: string | null;
  after: string;
}
export function recordImport(previous: ImportedDraft | undefined, draft: string, next: string): ImportedDraft {
  const base = !previous ? draft : draft === previous.after ? previous.base : null;
  return { base, after: next };
}
/** What may stay in the draft once the copied text's source is gone: only independently authored text. */
export function draftAfterSourceLoss(draft: string, imported: ImportedDraft | undefined): string {
  if (!imported) return draft;
  return imported.base !== null && draft === imported.after ? imported.base : "";
}
