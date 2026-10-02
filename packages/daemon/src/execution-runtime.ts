/** Owner-local callbacks retain the original run's current execution authority. */
import { OrcaError, type MutationActor, type RunState } from "@orca/core";
import {
  LiveHumanInput,
  type Orchestrator,
  type ExecutionResumeAuthority,
  type ExecutionResumeOrigin,
} from "@orca/engine";
import { executionEvents } from "@orca/store";
import type { CredentialStore } from "./auth/credentials.js";
import type { OwnershipStore } from "./auth/ownership.js";
import { holds, workflowAllowed } from "./auth/principal.js";
import { LiveExecutionAuthorities } from "./live-input-authority.js";
type ExecutionOrigin = ExecutionResumeOrigin;
export function daemonExecutionRuntime(options: {
  instanceId: string;
  orchestrator: Orchestrator;
  credentials: CredentialStore;
  ownership: OwnershipStore;
  revalidateMs?: number;
}) {
  const port = new LiveHumanInput(options.instanceId);
  const origins = new Map<string, ExecutionOrigin>();
  const renewed = new Map<string, { origin: ExecutionOrigin; authority: ExecutionResumeAuthority }>();
  const renewing = new Set<string>();
  const isCurrent = (origin: ExecutionOrigin | undefined, actor: MutationActor) => {
    if (!origin || !actor.credentialId || options.ownership.owner(origin.rootId) !== actor.principalId) return false;
    const current = options.credentials.current(actor.credentialId);
    return (
      current.ok &&
      current.principal.id === actor.principalId &&
      holds(current.principal, "runs.start") &&
      (!origin.request || holds(current.principal, "plan.write")) &&
      workflowAllowed(current.principal.scope, origin.workflowId)
    );
  };
  const authorities = new LiveExecutionAuthorities(
    (actor, runId) => isCurrent(origins.get(runId), actor),
    options.revalidateMs,
  );
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
  const resumeRequired = () =>
    new OrcaError(
      "RUN_STATE",
      "execution authority expired; resume explicitly with the original principal's current launch authority",
      { executionResumeRequired: true },
    );
  const sameOrigin = (a: ExecutionOrigin, b: ExecutionOrigin) =>
    a.rootId === b.rootId &&
    a.workflowId === b.workflowId &&
    a.request === b.request &&
    a.actor.principalId === b.actor.principalId &&
    a.actor.credentialId === b.actor.credentialId;
  const refuseIfAttached = (rootId: string) => {
    // Never replace the authority of an attached interpreter or its old callbacks.
    if (renewing.has(rootId) || [...origins.values()].some((entry) => entry.rootId === rootId))
      throw new OrcaError("RUN_LEASED", "execution is already attached");
  };
  const resumeBinding = async (runId: string, authority: ExecutionResumeAuthority | undefined) => {
    const origin = await originOf(runId);
    if (!origin) return;
    const prior = renewed.get(origin.rootId);
    if (prior && !sameOrigin(origin, prior.origin)) throw resumeRequired();
    if (isCurrent(origin, prior?.authority.actor ?? origin.actor)) return;
    if (!authority || authority.actor.principalId !== origin.actor.principalId) throw resumeRequired();
    refuseIfAttached(origin.rootId);
    await authority.authorize(origin);
    const current = authority.actor.credentialId
      ? options.credentials.current(authority.actor.credentialId)
      : undefined;
    if (!isCurrent(origin, authority.actor) || !current?.ok || !holds(current.principal, "runs.control"))
      throw resumeRequired();
    refuseIfAttached(origin.rootId);
    return { origin, authority };
  };
  return {
    port,
    /** Read-only preflight for asynchronous recovery; attachment rechecks before execution. */
    async checkResumeAuthority(runId: string, authority: ExecutionResumeAuthority | undefined): Promise<void> {
      await resumeBinding(runId, authority);
    },
    async withResumeAuthority(
      runId: string,
      authority: ExecutionResumeAuthority | undefined,
      operation: () => Promise<RunState>,
    ): Promise<RunState> {
      const binding = await resumeBinding(runId, authority);
      if (!binding) return operation();
      const { origin } = binding;
      // Preflight does not reserve anything. Recheck after its asynchronous return so
      // concurrent attachments cannot replace each other's verified authority.
      refuseIfAttached(origin.rootId);
      const prior = renewed.get(origin.rootId);
      renewing.add(origin.rootId);
      renewed.set(origin.rootId, binding);
      try {
        const result = await operation();
        if (["completed", "failed", "cancelled"].includes(result.run.status)) renewed.delete(origin.rootId);
        return result;
      } catch (error) {
        if (renewed.get(origin.rootId) === binding) {
          if (prior) renewed.set(origin.rootId, prior);
          else renewed.delete(origin.rootId);
        }
        throw error;
      } finally {
        renewing.delete(origin.rootId);
      }
    },
    async prepareExecution(runId: string) {
      const origin = await originOf(runId);
      if (!origin) return;
      const binding = renewed.get(origin.rootId);
      const actor = binding?.authority.actor ?? origin.actor;
      // Revocation while awaiting the lease still means explicit execution recovery,
      // including when a durable gate answer has already been recorded.
      if (!isCurrent(origin, actor)) throw resumeRequired();
      if (binding) {
        if (!sameOrigin(origin, binding.origin)) throw resumeRequired();
        try {
          await binding.authority.authorize(origin);
        } catch (error) {
          if (!isCurrent(origin, actor)) throw resumeRequired();
          throw error;
        }
      }
      if (!isCurrent(origin, actor)) throw resumeRequired();
      origins.set(runId, origin);
      authorities.bind(runId, actor);
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
      renewed.clear();
      renewing.clear();
    },
  };
}
