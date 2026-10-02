/** Request adapter. Method registration and transport pre-validation authorization are shared wiring. */
import {
  OrcaError,
  type SubmissionAuthority,
  type SubmissionCommand,
  type SubmissionResult,
  type SubmissionService,
} from "@orca/core";
import { executeAcceptedSubmission } from "@orca/engine";
import { authForbidden, workflowNotFound } from "./auth/errors.js";
import { holds, workflowAllowed, type Principal } from "./auth/principal.js";
import type { Authorizer } from "./auth/guard.js";

/** Live verified principal lookup: credentials/revocation must be checked on every invocation. */
export function submissionAuthority(opts: {
  workspaceId: string;
  principal: () => Promise<Principal>;
  authorizer: Authorizer;
  actor: SubmissionAuthority["actor"];
}): SubmissionAuthority {
  const check = async (command?: SubmissionCommand): Promise<Principal> => {
    const principal = await opts.principal();
    if (principal.id !== opts.actor.principalId || !holds(principal, "runs.start") || !holds(principal, "plan.write"))
      throw authForbidden();
    if (command?.workflowId && !workflowAllowed(principal.scope, command.workflowId))
      throw workflowNotFound(command.workflowId);
    return principal;
  };
  return {
    workspaceId: opts.workspaceId,
    actor: opts.actor,
    authorize: async (command) => {
      await check(command);
    },
    onRunAdmitted: async (runId) => {
      const principal = await check();
      const ownership = opts.authorizer.runs.ownership;
      const owner = ownership.owner(runId);
      if (owner && owner !== principal.id) throw authForbidden();
      // The existing ownership store does not retry a failed write for an already-known id.
      // Refuse it here: restart reloads only durable ownership and reconciliation can retry.
      opts.authorizer.attributeRun(runId, principal);
      await ownership.flush();
      if (ownership.lastError) throw new OrcaError("STORE_WRITE", "Request ownership could not be persisted");
    },
  };
}

export class RequestSubmissionModel {
  constructor(
    private readonly opts: {
      service: SubmissionService;
      /** The worker drives/settles accepted roots; no workflow promise is awaited by the RPC. */
      execute: (runId: string) => Promise<void>;
      /** Report background infrastructure failures; run execution failures are already events. */
      executionFailed: (runId: string) => void;
    },
  ) {}

  async submit(command: SubmissionCommand, authority: SubmissionAuthority): Promise<SubmissionResult> {
    return this.start(await this.opts.service.submit(command, authority), authority);
  }
  async reconcile(admissionId: string, authority: SubmissionAuthority): Promise<SubmissionResult> {
    return this.start(await this.opts.service.reconcile(admissionId, authority), authority);
  }
  inspect(admissionId: string, authority: SubmissionAuthority): Promise<SubmissionResult> {
    return this.opts.service.inspect(admissionId, authority);
  }
  async list(authority: SubmissionAuthority): Promise<{ admissions: SubmissionResult[] }> {
    return { admissions: await this.opts.service.list(authority) };
  }
  private start(result: SubmissionResult, authority: SubmissionAuthority): SubmissionResult {
    if (result.state === "accepted") {
      // Queue after returning admission. A failed/restarted client can use authorized run reads
      // and reconcile the admission to resume an accepted root whose worker never started.
      setImmediate(() => {
        void executeAcceptedSubmission(
          this.opts.service,
          result.admissionId,
          result.runId,
          authority,
          this.opts.execute,
        ).catch(() => this.opts.executionFailed(result.runId));
      });
    }
    return result;
  }
}
