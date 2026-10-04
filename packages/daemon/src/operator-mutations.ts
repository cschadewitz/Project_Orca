/** MCP aliases compose existing authenticated services; they own no durable lifecycle. */
import { OrcaError } from "@orca/core";
import { OperatorMutationContracts, type OperatorMutationName, type OperatorMutationParams } from "@orca/protocol";
import type { MethodContext, MethodTable } from "./methods.js";
import { revisionAuthority } from "./revision-input.js";

export interface OperatorMutationComposition {
  /** Refreshes the invocation's original credential. Never accepts caller authority. */
  current(invocation: MethodContext, method: OperatorMutationName): Promise<MethodContext>;
  /** Uses the installed guarded legacy method with current authentication and resource checks. */
  invokeLegacy(
    name: "inputs.answer" | "runs.cancel",
    params: unknown,
    invocation: MethodContext,
    expected?: MethodContext["operatorDecisionTarget"],
  ): Promise<unknown>;
}

export function createOperatorMutationMethods(ctx: MethodContext): MethodTable {
  const composition = ctx.operatorMutations;
  if (!composition || !ctx.identity || !ctx.operatorReads) return {};
  const table: MethodTable = {};
  const add = <N extends OperatorMutationName>(
    name: N,
    action: (params: OperatorMutationParams<N>, invocation: MethodContext) => Promise<unknown>,
  ) => {
    const contract = OperatorMutationContracts[name];
    table[name] = {
      params: contract.params,
      handle: async (raw: unknown, invocation: MethodContext) => {
        const params = contract.params.parse(raw) as OperatorMutationParams<N>;
        const current = await composition.current(invocation, name);
        if (
          params.target.workspaceId !== ctx.identity!.workspaceId ||
          params.target.instanceId !== ctx.identity!.instanceId
        )
          throw new OrcaError("RUN_STATE", "Target changed; discover the deployment again");
        const result = await action(params, current);
        await composition.current(invocation, name);
        return contract.result.parse(result);
      },
    };
  };
  if (
    ctx.control &&
    ctx.requestSubmissions?.canSubmitRetry() &&
    ctx.requestSubmissionAuthority &&
    ctx.admissionRetries
  ) {
    add("operator.submitRequest", (p, call) =>
      ctx.requestSubmissionAuthority!(call).then((authority) =>
        ctx.requestSubmissions!.submitRetry(p.command, authority, p.retry),
      ),
    );
  }
  if (ctx.control && ctx.admissionRetries && ctx.admissionAuthorities) {
    add("operator.admitRun", async (p, call) => {
      const authorities = await ctx.admissionAuthorities!(call);
      return ctx.admissionRetries!.admitRetry(p.command, p.retry, await authorities.direct());
    });
    add("operator.admission", async (p, call) =>
      ctx.admissionRetries!.inspect(p.operationId, await ctx.admissionAuthorities!(call)),
    );
    add("operator.reconcileAdmission", async (p, call) => {
      const response = OperatorMutationContracts["operator.reconcileAdmission"].result.parse(
        await ctx.admissionRetries!.reconcile(p.operationId, await ctx.admissionAuthorities!(call)),
      );
      if (response.state === "resolved" && response.result.state === "accepted" && "requestId" in response.result) {
        if (!ctx.requestSubmissions || !ctx.requestSubmissionAuthority)
          throw new OrcaError("NOT_SUPPORTED", "Request execution reconciliation is unavailable");
        const settledAdmission = await ctx.requestSubmissions.reconcile(
          response.result.admissionId,
          await ctx.requestSubmissionAuthority(call),
          call.executionResumeAuthority,
        );
        if (
          settledAdmission.state !== "accepted" ||
          settledAdmission.runId !== response.result.runId ||
          settledAdmission.requestId !== response.result.requestId
        )
          throw new OrcaError("RUN_STATE", "Request admission could not be verified");
      }
      return response;
    });
  }
  if (ctx.control) {
    add("operator.cancel", async (p, call) => {
      await composition.invokeLegacy(
        "runs.cancel",
        { runId: p.runId, ...(p.reason !== undefined ? { reason: p.reason } : {}) },
        call,
      );
      return { runId: p.runId, asOf: new Date().toISOString() };
    });
    if (ctx.reads)
      add("operator.answer", async (p, call) => {
        const decision = p.decision;
        const target = decision.lifetime === "live" ? decision.live : decision;
        await composition.invokeLegacy(
          "inputs.answer",
          {
            runId: target.runId,
            requestId: target.requestId,
            optionId: decision.optionId,
            ...(decision.note !== undefined ? { note: decision.note } : {}),
            ...(decision.lifetime === "live" ? { live: decision.live, resume: true } : { resume: false }),
          },
          call,
          {
            runId: target.runId,
            requestId: target.requestId,
            stepRunId: target.stepRunId,
            kind: decision.lifetime === "live" ? "permission" : "decision",
          },
        );
        return { runId: target.runId, requestId: target.requestId, asOf: new Date().toISOString() };
      });
  }
  if (ctx.continuationAdmissions && ctx.continuationAccess) {
    add("operator.continuation", async (p, call) =>
      ctx.continuationAdmissions!.inspect(p.continuationId, await ctx.continuationAccess!(call)),
    );
    if (ctx.control) {
      add("operator.continueRun", async (p, call) =>
        ctx.continuationAdmissions!.admit(
          {
            runId: p.command.runId,
            expectedBoundary: p.command.expectedBoundary,
            ...(p.command.decision
              ? {
                  decision: {
                    requestId: p.command.decision.requestId,
                    optionId: p.command.decision.optionId,
                    ...(p.command.decision.note !== undefined ? { note: p.command.decision.note } : {}),
                  },
                }
              : {}),
          },
          p.retry,
          await ctx.continuationAccess!(call),
        ),
      );
      add("operator.reconcileContinuation", async (p, call) =>
        ctx.continuationAdmissions!.reconcile(p.continuationId, await ctx.continuationAccess!(call)),
      );
    }
  }
  if (ctx.control && ctx.revisionInputs)
    add("operator.revise", async (p, call) => {
      const { service, access } = await ctx.revisionInputs!(call);
      return service.submit(
        {
          target: p.command.target,
          actionId: p.command.actionId,
          payload: p.command.payload,
          ...(p.command.supersedesRevisionId !== undefined
            ? { supersedesRevisionId: p.command.supersedesRevisionId }
            : {}),
        },
        p.retry,
        revisionAuthority(access),
      );
    });
  return table;
}
