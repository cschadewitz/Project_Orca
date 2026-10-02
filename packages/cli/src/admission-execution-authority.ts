/** Local execution uses only authorities explicitly configured by this process. */
import { OrcaError, type DirectAdmissionAuthority, type SubmissionAuthority } from "@orca/core";
import type { AdmissionExecutionPolicy, Orchestrator } from "@orca/engine";

type Authority = DirectAdmissionAuthority | SubmissionAuthority;
const bindings = new WeakMap<Orchestrator, Map<string, Authority>>();
function key(kind: "direct" | "request", authority: Pick<Authority, "workspaceId" | "actor">): string {
  return JSON.stringify([
    kind,
    authority.workspaceId,
    authority.actor.principalId,
    authority.actor.credentialId ?? null,
  ]);
}
/** A fresh local intent may register its own actor; it never renews another sealed actor. */
export function bindLocalAdmissionExecution(
  orchestrator: Orchestrator,
  kind: "direct" | "request",
  authority: Authority,
): void {
  let bound = bindings.get(orchestrator);
  if (!bound) {
    bound = new Map();
    bindings.set(orchestrator, bound);
    const authorities = bound;
    orchestrator.admissionExecution = {
      authorize: async (policy: Readonly<AdmissionExecutionPolicy>) => {
        const binding = policy.binding;
        const identity = key(binding.kind, binding);
        const current = authorities.get(identity);
        if (!current?.verifyRunAdmitted || key(binding.kind, current) !== identity)
          throw new OrcaError("RUN_STATE", "the original local admission authority is unavailable");
        const command = {
          workflowId: binding.workflow.id,
          ...(binding.requestId ? { requestId: binding.requestId } : {}),
          ...(binding.workItemId ? { workItemId: binding.workItemId } : {}),
        };
        const authorize = () =>
          binding.kind === "request"
            ? (current as SubmissionAuthority).authorize({ title: "", body: "", workflowId: binding.workflow.id })
            : (current as DirectAdmissionAuthority).authorize(command);
        await authorize();
        await current.verifyRunAdmitted(binding.runId);
        await authorize();
      },
    };
  }
  bound.set(key(kind, authority), authority);
}
