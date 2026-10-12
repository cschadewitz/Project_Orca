/** Validated workflow-draft RPC caller for main's pinned IPC handoff; accepts only the closed method inventory. */
import { WORKFLOW_DRAFT_METHOD_CONTRACTS } from "@orca/protocol";
import type { WorkflowDraftMethodName } from "../workflow-draft-bridge.js";
import type { DaemonClient } from "./daemon-client.js";
export async function callWorkflowDraft(
  client: Pick<DaemonClient, "call">,
  method: WorkflowDraftMethodName,
  params: unknown,
): Promise<unknown> {
  const contract = Object.hasOwn(WORKFLOW_DRAFT_METHOD_CONTRACTS, method)
    ? WORKFLOW_DRAFT_METHOD_CONTRACTS[method]
    : undefined;
  if (!contract) throw new Error("Workflow draft method unavailable.");
  const parsed = contract.params.parse(params);
  // The runtime discriminator binds params and result; no arbitrary generic renderer RPC.
  return client.call<unknown>(method, parsed, contract.result);
}
