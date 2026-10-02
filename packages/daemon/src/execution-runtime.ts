/** Owner-local callbacks retain the original run's current execution authority. */
import { OrcaError, type MutationActor } from "@orca/core";
import { LiveHumanInput, type Orchestrator } from "@orca/engine";
import { executionEvents } from "@orca/store";
import type { CredentialStore } from "./auth/credentials.js";
import type { OwnershipStore } from "./auth/ownership.js";
import { holds, workflowAllowed } from "./auth/principal.js";
import { LiveExecutionAuthorities } from "./live-input-authority.js";
interface ExecutionOrigin {
  rootId: string;
  workflowId: string;
  request: boolean;
  actor: MutationActor;
}
export function daemonExecutionRuntime(options: {
  instanceId: string;
  orchestrator: Orchestrator;
  credentials: CredentialStore;
  ownership: OwnershipStore;
  revalidateMs?: number;
}) {
  const port = new LiveHumanInput(options.instanceId);
  const origins = new Map<string, ExecutionOrigin>();
  const authorities = new LiveExecutionAuthorities((actor, runId) => {
    const origin = origins.get(runId);
    if (!origin || !actor.credentialId || options.ownership.owner(origin.rootId) !== actor.principalId) return false;
    const current = options.credentials.current(actor.credentialId);
    return (
      current.ok &&
      current.principal.id === actor.principalId &&
      holds(current.principal, "runs.start") &&
      (!origin.request || holds(current.principal, "plan.write")) &&
      workflowAllowed(current.principal.scope, origin.workflowId)
    );
  }, options.revalidateMs);
  const originOf = async (runId: string): Promise<ExecutionOrigin | undefined> => {
    const seen = new Set<string>();
    for (let id = runId; ;) {
      if (seen.has(id)) throw new OrcaError("RUN_STATE", "execution lineage is unavailable");
      seen.add(id);
      const publicEvents = await options.orchestrator.stores.events.readRange(id, { limit: 1 });
      const first = publicEvents[0];
      if (!first || first.type !== "run.created") throw new OrcaError("RUN_STATE", "execution origin is unavailable");
      if (!first.executionPayloadRef) {
        // Unsealed public metadata is never execution authority, even if a marker was
        // removed. Legacy actorless work remains recoverable without a live callback.
        const protectedInputs = await options.orchestrator.stores.execution.getInputs(id);
        if (protectedInputs || first.payload.executionInputsStored)
          throw new OrcaError("RUN_STATE", "authenticated execution origin is unavailable");
        return undefined;
      }
      const event = (await executionEvents(publicEvents, options.orchestrator.stores.execution))[0];
      if (!event || event.type !== "run.created") throw new OrcaError("RUN_STATE", "execution origin is unavailable");
      if (event.payload.parentRunId) {
        id = event.payload.parentRunId;
        continue;
      }
      if (!event.payload.actor?.credentialId) return undefined;
      return {
        rootId: id,
        actor: event.payload.actor,
        workflowId: event.payload.workflowId,
        request: "requestAdmissionId" in event.payload,
      };
    }
  };
  return {
    port,
    async prepareExecution(runId: string) {
      const origin = await originOf(runId);
      if (!origin) return;
      origins.set(runId, origin);
      authorities.bind(runId, origin.actor);
      // Revocation expires live tool callbacks, while current authorized durable gate recovery remains possible.
    },
    executionSignal: (runId: string) =>
      origins.has(runId) ? authorities.signalFor(runId) : AbortSignal.abort("no verified execution authority"),
    releaseExecution(runId: string) {
      authorities.forget(runId);
      origins.delete(runId);
    },
    close() {
      authorities.close();
      port.close();
      origins.clear();
    },
  };
}
