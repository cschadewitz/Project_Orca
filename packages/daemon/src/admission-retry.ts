/** Authenticated direct admission and fixed-kind receipt dispatch. No execution is awaited by admit. */
import { OrcaError, type SubmissionAuthority } from "@orca/core";
import { readAdmissionExecutionStatus, type Orchestrator, type ExecutionResumeAuthority } from "@orca/engine";
import type {
  DirectAdmissionAuthority,
  DirectAdmissionCommand,
  DirectAdmissionResult,
  RetryOptions,
  RetryResult,
} from "../../core/src/model/admission-retry.js";
import type { RegisteredRetryClaims } from "../../engine/src/admission-retry.js";
import type { DirectAdmissionService } from "../../engine/src/direct-admission.js";
import type { RequestSubmissionService } from "../../engine/src/program/request-submission.js";
import type { Authorizer } from "./auth/guard.js";
import { holds, workflowAllowed, type Principal } from "./auth/principal.js";
import { authForbidden, workflowNotFound } from "./auth/errors.js";

export function directAdmissionAuthority(options: {
  workspaceId: string;
  actor: DirectAdmissionAuthority["actor"];
  principal(): Promise<Principal>;
  authorizer: Authorizer;
}): DirectAdmissionAuthority {
  const check = async (command?: DirectAdmissionCommand) => {
    const principal = await options.principal();
    if (principal.id !== options.actor.principalId || !holds(principal, "runs.start")) throw authForbidden();
    if (command) {
      if (!workflowAllowed(principal.scope, command.workflowId)) throw workflowNotFound(command.workflowId);
      if (command.requestId && !holds(principal, "plan.read")) throw authForbidden();
      if (command.workItemId && (!holds(principal, "plan.read") || !holds(principal, "plan.write")))
        throw authForbidden();
    }
    return principal;
  };
  return {
    workspaceId: options.workspaceId,
    actor: options.actor,
    authorize: async (command) => {
      await check(command);
    },
    verifyRunAdmitted: async (runId) => {
      const principal = await check();
      await options.authorizer.runs.ownership.verify(runId, principal.id);
      await check();
    },
    onRunAdmitted: async (runId) => {
      const principal = await check();
      const ownership = options.authorizer.runs.ownership;
      if (ownership.owner(runId) && ownership.owner(runId) !== principal.id) throw authForbidden();
      options.authorizer.attributeRun(runId, principal);
      await ownership.flush(runId);
      if (ownership.owner(runId) !== principal.id)
        throw new OrcaError("STORE_WRITE", "Run ownership could not be persisted");
    },
  };
}

export interface AdmissionAuthorities {
  readonly executionAuthority?: ExecutionResumeAuthority | undefined;
  /** Rechecks live authentication/grants before an ID lookup, including missing IDs. */
  check(): Promise<void>;
  readonly principalId: string;
  readonly workspaceId: string;
  request(): Promise<SubmissionAuthority>;
  direct(): Promise<DirectAdmissionAuthority>;
}
export class AdmissionRetryModel {
  private readonly verifying = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;

  constructor(
    private readonly options: {
      claims: RegisteredRetryClaims;
      requests: RequestSubmissionService;
      direct: DirectAdmissionService;
      orchestrator: Orchestrator;
      execute(runId: string, authority?: ExecutionResumeAuthority): Promise<void>;
      checkResumeAuthority?(runId: string, authority?: ExecutionResumeAuthority): Promise<void>;
      executionFailed(runId: string): void;
    },
  ) {}
  async admit(
    command: DirectAdmissionCommand,
    retry: RetryOptions,
    authority: DirectAdmissionAuthority,
  ): Promise<DirectAdmissionResult & { operationId: string }> {
    const response = await this.admitRetry(command, retry, authority);
    if (response.state !== "resolved")
      throw new OrcaError("RUN_STATE", "Run admission is in progress", { ...response });
    return { ...response.result, operationId: response.operationId };
  }
  async admitRetry(
    command: DirectAdmissionCommand,
    retry: RetryOptions,
    authority: DirectAdmissionAuthority,
  ): Promise<RetryResult<DirectAdmissionResult>> {
    const response = await this.options.direct.admitRun(command, retry, authority);
    if (response.state === "resolved" && response.result.state === "accepted")
      this.dispatch(response.operationId, response.result.runId, authority);
    return response;
  }
  inspect(operationId: string, authorities: AdmissionAuthorities): Promise<RetryResult<unknown>> {
    return this.receipt(operationId, authorities, false);
  }
  reconcile(operationId: string, authorities: AdmissionAuthorities): Promise<RetryResult<unknown>> {
    return this.receipt(operationId, authorities, true);
  }
  private async receipt(
    operationId: string,
    authorities: AdmissionAuthorities,
    recover: boolean,
  ): Promise<RetryResult<unknown>> {
    await authorities.check();
    const kind = await this.options.claims.operationKind(operationId, authorities);
    if (kind === "request.submit") {
      const authority = await authorities.request();
      return this.options.requests.withRetryAuthority(authority, () => {
        const scope = {
          principalId: authority.actor.principalId,
          workspaceId: authority.workspaceId,
          authorize: (command: unknown) =>
            authority.authorize(command as Parameters<SubmissionAuthority["authorize"]>[0]),
        };
        return recover
          ? this.options.claims.reconcile(operationId, scope)
          : this.options.claims.inspect(operationId, scope);
      });
    }
    if (kind === "run.admit") {
      const authority = await authorities.direct();
      return this.options.direct.withRetryAuthority(authority, async () => {
        const scope = {
          principalId: authority.actor.principalId,
          workspaceId: authority.workspaceId,
          authorize: (command: unknown) => authority.authorize(command as DirectAdmissionCommand),
        };
        const result = await (recover
          ? this.options.claims.reconcile(operationId, scope)
          : this.options.claims.inspect(operationId, scope));
        if (recover && result.state === "resolved") {
          const receipt = result.result as DirectAdmissionResult;
          if (receipt.state === "accepted" && (await neverAttached(this.options.orchestrator, receipt.runId))) {
            await this.options.checkResumeAuthority?.(receipt.runId, authorities.executionAuthority);
            this.dispatch(operationId, receipt.runId, authority, authorities.executionAuthority);
          }
        }
        return result;
      });
    }
    // Revision/continuation owners provide their authenticated inspection dispatcher at integration.
    throw new OrcaError("NOT_SUPPORTED", "This operation's receipt dispatcher is not installed");
  }
  private dispatch(
    operationId: string,
    runId: string,
    authority: DirectAdmissionAuthority,
    executionAuthority?: ExecutionResumeAuthority,
  ): void {
    if (this.closing) return;
    // Own the scheduled verification before setImmediate can run. It reads and
    // synchronizes durable evidence even for an already-started run's replay.
    const verification = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        if (this.closing) {
          resolve();
          return;
        }
        void this.options.direct
          .withRetryAuthority(authority, async () => {
            const current = await this.options.claims.inspect(operationId, {
              principalId: authority.actor.principalId,
              workspaceId: authority.workspaceId,
              authorize: (command) => authority.authorize(command as DirectAdmissionCommand),
            });
            if (current.state !== "resolved" || (current.result as DirectAdmissionResult).state !== "accepted") return;
            if (this.closing) return;
            if (!(await neverAttached(this.options.orchestrator, runId))) return;
            if (this.closing) return;
            // Execution has its own run lease/lifecycle. Shutdown settles receipt
            // verification, without waiting for a workflow or cancelling it.
            void this.options.execute(runId, executionAuthority).catch(() => this.options.executionFailed(runId));
          })
          .then(resolve, reject);
      });
    });
    this.verifying.add(verification);
    void verification.then(
      () => this.verifying.delete(verification),
      () => {
        this.verifying.delete(verification);
        this.options.executionFailed(runId);
      },
    );
  }

  /** Fence automatic attachment and settle its evidence reads, including queued work. */
  close(): Promise<void> {
    this.closing ??= Promise.allSettled(this.verifying).then(() => undefined);
    return this.closing;
  }
}

/** Only verified, unattempted admission policy permits dispatch; the actual lease fence rechecks it. */
export async function neverAttached(orchestrator: Orchestrator, runId: string): Promise<boolean> {
  const status = await readAdmissionExecutionStatus(orchestrator.stores, runId);
  if (status.state !== "ready") return false;
  return !(await orchestrator.stores.leases.get(`run:${runId}`));
}

/** A client guard, never authority; reject before admission and exclude from intent comparison. */
export async function checkAdmissionScope(
  expected: { principalId: string; workspaceId: string } | undefined,
  authorities: AdmissionAuthorities,
): Promise<void> {
  await authorities.check();
  if (
    expected &&
    (expected.principalId !== authorities.principalId || expected.workspaceId !== authorities.workspaceId)
  )
    throw authForbidden();
}
