/** Authenticated revision authority. The transport must check both mutation grants before schema diagnostics. */
import type { MutationActor } from "@orca/core";
import type { RevisionAccess, RetryAuthority } from "../../engine/src/revision-input.js";
import type { Authorizer } from "./auth/guard.js";
import { holds, type Principal } from "./auth/principal.js";
import { authForbidden, runNotFound } from "./auth/errors.js";

export function revisionAccess(opts: {
  workspaceId: string;
  principalId: string;
  currentPrincipal: () => Promise<Principal>;
  authorizer: Authorizer;
}): RevisionAccess {
  const principal = async () => {
    const current = await opts.currentPrincipal();
    if (current.id !== opts.principalId) throw authForbidden();
    return current;
  };
  const mutation = (current: Principal) => holds(current, "inputs.answer") && holds(current, "runs.control");
  const resource = async (current: Principal, runId: string) => {
    if (!(await opts.authorizer.runs.allows(current, runId))) throw runNotFound(runId);
  };
  return {
    workspaceId: opts.workspaceId,
    principalId: opts.principalId,
    actor: async (): Promise<MutationActor> => {
      const current = await principal();
      return { principalId: current.id, ...(current.credentialId ? { credentialId: current.credentialId } : {}) };
    },
    mutate: async (runId) => {
      const current = await principal();
      if (!mutation(current)) throw authForbidden();
      await resource(current, runId);
    },
    read: async (runId) => {
      const current = await principal();
      if (!holds(current, "runs.read")) throw authForbidden();
      await resource(current, runId);
      return { content: mutation(current), mutate: mutation(current) };
    },
  };
}
export function revisionAuthority<C extends { target: { runId: string } }>(access: RevisionAccess): RetryAuthority<C> {
  return {
    principalId: access.principalId,
    workspaceId: access.workspaceId,
    authorize: (command) => access.mutate(command.target.runId),
  };
}
