/** Request adapter. Method registration and transport pre-validation authorization are shared wiring. */
import type { RetryOptions } from "../../core/src/model/admission-retry.js";
import {
  OrcaError,
  type SubmissionAuthority,
  type SubmissionCommand,
  type SubmissionResult,
  type SubmissionService,
} from "@orca/core";
import { executeAcceptedSubmission, type ExecutionResumeAuthority } from "@orca/engine";
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
    verifyRunAdmitted: async (runId) => {
      const principal = await check();
      await opts.authorizer.runs.ownership.verify(runId, principal.id);
      await check();
    },
    onRunAdmitted: async (runId) => {
      const principal = await check();
      const ownership = opts.authorizer.runs.ownership;
      const owner = ownership.owner(runId);
      if (owner && owner !== principal.id) throw authForbidden();
      // Attribution belongs only to the write path. Receipt inspection verifies
      // existing durable ownership through verifyRunAdmitted instead.
      opts.authorizer.attributeRun(runId, principal);
      await ownership.flush(runId);
      if (ownership.owner(runId) !== principal.id)
        throw new OrcaError("STORE_WRITE", "Request ownership could not be persisted");
    },
  };
}

export class RequestSubmissionModel {
  constructor(
    private readonly opts: {
      service: SubmissionService & {
        submit(
          command: SubmissionCommand,
          authority: SubmissionAuthority,
          retry?: RetryOptions,
        ): Promise<SubmissionResult>;
      };
      /** The worker drives/settles accepted roots; no workflow promise is awaited by the RPC. */
      execute: (runId: string, authority?: ExecutionResumeAuthority) => Promise<void>;
      /** Read-only renewal preflight. The worker rechecks when it attaches under the lease. */
      checkResumeAuthority?: (runId: string, authority?: ExecutionResumeAuthority) => Promise<void>;
      /** Report background infrastructure failures; run execution failures are already events. */
      executionFailed: (runId: string) => void;
      /** Production retry wiring restricts automatic dispatch to never-attached runs. */
      shouldDispatch?: (runId: string) => Promise<boolean>;
    },
  ) {}

  async submit(
    command: SubmissionCommand,
    authority: SubmissionAuthority,
    retry: RetryOptions = {},
  ): Promise<SubmissionResult> {
    return this.start(await this.opts.service.submit(command, authority, retry), authority);
  }
  async reconcile(
    admissionId: string,
    authority: SubmissionAuthority,
    executionAuthority?: ExecutionResumeAuthority,
  ): Promise<SubmissionResult> {
    const result = await this.opts.service.reconcile(admissionId, authority);
    if (result.state === "accepted") await this.opts.checkResumeAuthority?.(result.runId, executionAuthority);
    return this.start(result, authority, executionAuthority);
  }
  inspect(admissionId: string, authority: SubmissionAuthority): Promise<SubmissionResult> {
    return this.opts.service.inspect(admissionId, authority);
  }
  async list(authority: SubmissionAuthority): Promise<{ admissions: SubmissionResult[] }> {
    return { admissions: await this.opts.service.list(authority) };
  }
  private start(
    result: SubmissionResult,
    authority: SubmissionAuthority,
    executionAuthority?: ExecutionResumeAuthority,
  ): SubmissionResult {
    if (result.state === "accepted") {
      // Queue after returning admission. A failed/restarted client can use authorized run reads
      // and reconcile the admission to resume an accepted root whose worker never started.
      // Recovery carries the caller's verified resume authority; the original sealed actor
      // may name a bootstrap credential invalidated by the daemon restart.
      setImmediate(() => {
        void executeAcceptedSubmission(
          this.opts.service,
          result.admissionId,
          result.runId,
          authority,
          async (runId) => {
            if (!this.opts.shouldDispatch || (await this.opts.shouldDispatch(runId)))
              await this.opts.execute(runId, executionAuthority);
          },
        ).catch(() => this.opts.executionFailed(result.runId));
      });
    }
    return result;
  }
}
