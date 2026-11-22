/** Authenticated direct admission and fixed-kind receipt dispatch. No execution is awaited by admit. */
import type { RuntimeActivity } from "./runtime-activity.js";
import { OrcaError, type SubmissionAuthority } from "@orca/core";
import { ProtocolFault } from "@orca/protocol";
import {
  readAdmissionExecutionStatus,
  type CheckpointAdmissionAuthority,
  type CheckpointAdmissionCommand,
  type CheckpointAdmissionResult,
  type CheckpointAdmissionService,
  type Orchestrator,
  type ExecutionResumeAuthority,
} from "@orca/engine";
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

/**
 * A checkpoint attempt's authority (#357): a direct admission's, for the source run's workflow
 * (and its request and work item), because an attempt is a new run of it. Whether this
 * principal may recover that run at all (it started it) is the engine's own check.
 */
export function checkpointAdmissionAuthority(
  direct: DirectAdmissionAuthority,
  orchestrator: Pick<Orchestrator, "getSummary">,
): CheckpointAdmissionAuthority {
  return {
    workspaceId: direct.workspaceId,
    actor: direct.actor,
    authorize: async (command) => {
      const source = await orchestrator.getSummary(command.runId);
      await direct.authorize({
        workflowId: source.workflowId,
        ...(source.requestId ? { requestId: source.requestId } : {}),
        ...(source.workItemId ? { workItemId: source.workItemId } : {}),
      });
    },
    onRunAdmitted: (runId) => direct.onRunAdmitted(runId),
    ...(direct.verifyRunAdmitted ? { verifyRunAdmitted: (runId: string) => direct.verifyRunAdmitted!(runId) } : {}),
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
  get runtimeActivity() {
    return this.options.runtimeActivity;
  }
  get executionOrchestrator() {
    return this.options.orchestrator;
  }
  private readonly verifying = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;

  constructor(
    private readonly options: {
      runtimeActivity?: RuntimeActivity | undefined;
      claims: RegisteredRetryClaims;
      requests: RequestSubmissionService;
      direct: DirectAdmissionService;
      /** Checkpoint attempts (#357); absent means `runs.recover` is not offered. */
      checkpoints?: CheckpointAdmissionService | undefined;
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
    const release = this.options.runtimeActivity?.enter("dispatch", true);
    try {
      const response = await this.options.direct.admitRun(command, retry, authority);
      if (response.state === "resolved" && response.result.state === "accepted")
        this.dispatch(response.operationId, response.result.runId, authority);
      return response;
    } finally {
      release?.();
    }
  }
  get supportsCheckpoints(): boolean {
    return this.options.checkpoints !== undefined;
  }

  /**
   * Start a checkpoint attempt of a failed run (#357): one per idempotency key, then driven
   * here under the same first-attachment policy as an admitted run. A refused recovery
   * (`RECOVERY_BLOCKED`, `RUN_STATE`) is thrown before anything is written.
   */
  async recover(
    command: CheckpointAdmissionCommand,
    retry: RetryOptions,
    authorities: AdmissionAuthorities,
  ): Promise<RetryResult<CheckpointAdmissionResult>> {
    const checkpoints = this.options.checkpoints;
    if (!checkpoints) throw new OrcaError("NOT_SUPPORTED", "Checkpoint attempts are not configured");
    const release = this.options.runtimeActivity?.enter("dispatch", true);
    try {
      const authority = checkpointAdmissionAuthority(await authorities.direct(), this.options.orchestrator);
      const response = await checkpoints.startAttempt(command, retry, authority);
      if (response.state === "resolved" && response.result.state === "accepted")
        this.dispatchCheckpoint(response.operationId, response.result.runId, authority);
      return response;
    } finally {
      release?.();
    }
  }

  /** A direct admission's receipt by its idempotency key, or `absent`; never claims (#883). */
  async find(
    idempotencyKey: string,
    authorities: AdmissionAuthorities,
  ): Promise<{ state: "absent" } | RetryResult<unknown>> {
    await authorities.check();
    const authority = await authorities.direct();
    return this.options.direct.withRetryAuthority(authority, () =>
      this.options.claims.find("run.admit", idempotencyKey, {
        principalId: authority.actor.principalId,
        workspaceId: authority.workspaceId,
        authorize: (command: unknown) => authority.authorize(command as DirectAdmissionCommand),
      }),
    );
  }
  /**
   * Fence a direct admission's idempotency key (#883): afterwards no `runs.admit` under it can
   * admit a run. Answers the admission already under the key when there is one (so the caller
   * can cancel its run), else the fence's own `fenced` receipt.
   */
  async fence(
    idempotencyKey: string,
    workflowId: string,
    authorities: AdmissionAuthorities,
  ): Promise<{ state: "absent" } | RetryResult<unknown>> {
    const existing = await this.find(idempotencyKey, authorities);
    if (existing.state !== "absent") return existing;
    const authority = await authorities.direct();
    try {
      return await this.options.direct.fence(workflowId, { idempotencyKey }, authority);
    } catch (error) {
      // An admission claimed the key between the lookup and the fence: answer it instead.
      if ((error as { code?: string }).code !== "RETRY_CONFLICT") throw error;
      const raced = await this.find(idempotencyKey, authorities);
      if (raced.state === "absent") throw error;
      return raced;
    }
  }
  inspect(operationId: string, authorities: AdmissionAuthorities): Promise<RetryResult<unknown>> {
    return this.receipt(operationId, authorities, false);
  }
  /**
   * `newAdmission` is the maintenance fence for work that can create a run: reconciling a
   * checkpoint attempt's receipt can create its reserved run, so it is refused while new
   * admission is closed (a drain), exactly as `runs.recover` is. Inspection never needs it.
   */
  reconcile(
    operationId: string,
    authorities: AdmissionAuthorities,
    newAdmission?: () => void,
  ): Promise<RetryResult<unknown>> {
    return this.receipt(operationId, authorities, true, newAdmission);
  }
  private async receipt(
    operationId: string,
    authorities: AdmissionAuthorities,
    recover: boolean,
    newAdmission?: () => void,
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
    if (kind === "run.recover" && this.options.checkpoints) {
      const checkpoints = this.options.checkpoints;
      const authority = checkpointAdmissionAuthority(await authorities.direct(), this.options.orchestrator);
      if (recover) newAdmission?.();
      const result = await (recover
        ? checkpoints.reconcile(operationId, authority)
        : checkpoints.inspect(operationId, authority));
      if (recover && result.state === "resolved" && result.result.state === "accepted") {
        const runId = result.result.runId;
        if (await neverAttached(this.options.orchestrator, runId)) {
          await this.options.checkResumeAuthority?.(runId, authorities.executionAuthority);
          this.dispatchCheckpoint(operationId, runId, authority, authorities.executionAuthority);
        }
      }
      return result;
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
    this.attach(
      runId,
      () =>
        this.options.direct.withRetryAuthority(authority, async () => {
          const current = await this.options.claims.inspect(operationId, {
            principalId: authority.actor.principalId,
            workspaceId: authority.workspaceId,
            authorize: (command) => authority.authorize(command as DirectAdmissionCommand),
          });
          return current.state === "resolved" && (current.result as DirectAdmissionResult).state === "accepted";
        }),
      executionAuthority,
    );
  }

  private dispatchCheckpoint(
    operationId: string,
    runId: string,
    authority: CheckpointAdmissionAuthority,
    executionAuthority?: ExecutionResumeAuthority,
  ): void {
    const checkpoints = this.options.checkpoints!;
    this.attach(
      runId,
      async () => {
        const current = await checkpoints.inspect(operationId, authority);
        return current.state === "resolved" && current.result.state === "accepted";
      },
      executionAuthority,
    );
  }

  /** Verify the receipt is still accepted, then attach execution once if nothing ever has. */
  private attach(runId: string, accepted: () => Promise<boolean>, executionAuthority?: ExecutionResumeAuthority): void {
    if (this.closing) return;
    const release = this.options.runtimeActivity?.enter("dispatch");
    // Own the scheduled verification before setImmediate can run. It reads and
    // synchronizes durable evidence even for an already-started run's replay.
    const verification = new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        if (this.closing) {
          resolve();
          return;
        }
        void (async () => {
          if (!(await accepted())) return;
          if (this.closing) return;
          if (!(await neverAttached(this.options.orchestrator, runId))) return;
          if (this.closing) return;
          // Execution has its own run lease/lifecycle. Shutdown settles receipt
          // verification, without waiting for a workflow or cancelling it.
          const releaseExecution = this.options.runtimeActivity?.enter("execution");
          void this.options
            .execute(runId, executionAuthority)
            .catch(() => this.options.executionFailed(runId))
            .finally(() => releaseExecution?.());
        })().then(resolve, reject);
      });
    });
    this.verifying.add(verification);
    void verification.then(
      () => release?.(),
      () => release?.(),
    );
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

/**
 * The maintenance fence for a call that can admit new work part-way (reconciling a reserved
 * checkpoint attempt): throws, as the dispatch wrapper does for `runs.admit`, while new
 * admission is closed. Undefined when this daemon has no maintenance boundary.
 */
export function newAdmissionFence(maintenance: { admissionClosed(): boolean } | undefined): (() => void) | undefined {
  if (!maintenance) return undefined;
  return () => {
    if (maintenance.admissionClosed())
      throw new ProtocolFault("PROTOCOL_MESSAGE", "Update admission is closed; retry later");
  };
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
