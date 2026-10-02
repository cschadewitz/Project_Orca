/** Ephemeral callback state travels through the existing authorized subscription channel. */
import { INPUT_INVALIDATED, type DaemonNotification, type LiveDecisionTarget } from "@orca/protocol";
/** Structurally satisfied by LiveHumanInput; no durable event-store writes or replay. */
export interface LiveInputChangeSource {
  onInvalidated(listener: (target: LiveDecisionTarget) => void): () => void;
}
export function liveInputInvalidated(
  target: LiveDecisionTarget,
  subscriptionId: string,
  at = new Date().toISOString(),
): Extract<DaemonNotification, { method: typeof INPUT_INVALIDATED }> {
  return { method: INPUT_INVALIDATED, params: { subscriptionId, runId: target.runId, target: { ...target }, at } };
}
