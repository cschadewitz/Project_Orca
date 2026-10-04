/** Shared schema examples only. These are not handlers, authority or lifecycle evidence. */
export const operatorTarget = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  instanceId: "22222222-2222-4222-8222-222222222222",
};
export const operatorGuards = {
  workflowId: "workflow",
  workflowVersion: "1",
  expectedWorkflowRevision: "digest",
  expectedConfigGeneration: "generation",
};
export const operatorRetry = { idempotencyKey: "retained-intent" };
export const operatorOperationId = "retry_11111111-1111-4111-8111-111111111111";
export const operatorContinuationId = "ct_22222222-2222-4222-8222-222222222222";
export const operatorRevisionBoundary = {
  target: {
    runId: "run",
    stepRunId: "step",
    requestId: "input",
    destinationId: "destination",
    expectedRevision: "revision",
  },
  capability: {
    actionId: "changes",
    destinationNodeId: "agent",
    composition: "replace-revision-slot",
    payload: { kind: "text", maxBytes: 65536 },
  },
  destinationDescription: "Designated agent",
} as const;
export const operatorMutationParams = {
  "operator.submitRequest": {
    target: operatorTarget,
    command: { title: "Request", body: "Work", ...operatorGuards },
    retry: operatorRetry,
  },
  "operator.admitRun": { target: operatorTarget, command: operatorGuards, retry: operatorRetry },
  "operator.admission": { target: operatorTarget, operationId: operatorOperationId },
  "operator.reconcileAdmission": { target: operatorTarget, operationId: operatorOperationId },
  "operator.cancel": { target: operatorTarget, runId: "run" },
  "operator.answer": {
    target: operatorTarget,
    decision: {
      lifetime: "durable",
      runId: "run",
      stepRunId: "step",
      requestId: "input",
      optionId: "approve",
      resume: false,
    },
  },
  "operator.continueRun": {
    target: operatorTarget,
    command: { runId: "run", expectedBoundary: "opaque" },
    retry: operatorRetry,
  },
  "operator.continuation": { target: operatorTarget, continuationId: operatorContinuationId },
  "operator.reconcileContinuation": { target: operatorTarget, continuationId: operatorContinuationId },
  "operator.revise": {
    target: operatorTarget,
    command: {
      target: operatorRevisionBoundary.target,
      actionId: "changes",
      payload: { kind: "text", text: "Correction" },
    },
    retry: operatorRetry,
  },
} as const;
export const operatorProjectionFixture = {
  params: { target: operatorTarget, collection: "inputs", runId: "run" },
  before: {
    id: "input",
    kind: "decision",
    runId: "run",
    stepRunId: "step",
    requestId: "input",
    options: [{ id: "changes", label: "Request changes" }],
  },
  after: {
    id: "input",
    kind: "decision",
    runId: "run",
    stepRunId: "step",
    requestId: "input",
    options: [{ id: "changes", label: "Request changes" }],
    revisionActionId: "changes",
    revisionState: "available",
    revision: operatorRevisionBoundary,
  },
  declaredRevisionActionId: "changes",
} as const;
