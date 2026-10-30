/** Disposable typed policy fixtures; synthetic qualification references certify no installed provider. */
import type {
  ActionEvidenceV1,
  FactV1,
  JudgeRequestV1,
  JudgeResultV1,
  PolicyPortV1,
  StrictPermissionRule,
  StrictPermissionState,
} from "@orca/core";

export const NOW = Date.parse("2026-10-26T03:00:00Z");
export const complete = <T>(value: T): FactV1<T> => ({ state: "complete", value });
const absent = { state: "absent", reason: "not applicable to synthetic read" } as const;
const representation = {
  kind: "utf8-bytes",
  codecVersion: "synthetic-1",
  privateRef: "test:bytes",
  bindingRef: "test:bytes-binding",
} as const;

export function actionFixture(): ActionEvidenceV1 {
  return {
    version: 1,
    actionId: "test:action",
    bindingRef: "test:binding",
    capturedByBoundaryId: "test:boundary",
    invocation: {
      instanceId: "boot",
      sessionId: "session",
      turnId: "turn",
      invocationId: "invocation",
      runId: "run",
      rootRunId: "run",
      stepRunId: "step",
      attemptId: "attempt",
      agentId: "agent",
      hostId: "host",
      runnerId: "runner",
      principalRef: "test:principal",
    },
    coverage: {
      version: 1,
      coverageId: "test:coverage",
      boundaryId: "test:boundary",
      provider: "synthetic",
      providerVersion: "1",
      adapterVersion: "1",
      tool: "read",
      toolSchemaVersion: "1",
      hostId: "host",
      platform: "synthetic",
      level: "verified-per-execution",
      evidence: {
        sourceRefs: ["test:source"],
        installedRefs: ["test:synthetic-only"],
        independentlyObservedEffects: true,
      },
      negotiatedHook: complete("test:hook"),
      protectedConfiguration: complete("test:protected"),
      guaranteedEffects: ["synthetic-read"],
      unsupportedPaths: ["all-real-providers"],
    },
    operation: "read",
    profileRef: "test:profile",
    original: representation,
    dispatch: representation,
    transformations: [],
    rawDuplicateKeyValidation: absent,
    effectiveCwd: complete("test:cwd"),
    workspaceRef: complete("test:workspace"),
    resources: complete([{ operation: "read", physicalTargetRef: "test:resource" }]),
    executableAndInterpreter: absent,
    stdin: absent,
    environmentAndCredentialRefs: complete([]),
    relevantStateRefs: complete(["test:preimage"]),
    offeredChoices: [
      {
        optionId: "once",
        kind: "allow_once",
        effect: "this-invocation",
        qualificationRef: complete("test:choice"),
        grantScopeAndLifetime: complete({
          scopeRef: "invocation",
          expiresAt: new Date(NOW + 5000).toISOString(),
          maximumUses: 1,
        }),
      },
    ],
    authority: {
      capturedGeneration: "generation",
      currentPolicyRevision: "policy-1",
      authorityRevision: "authority-1",
      revocationEpoch: "epoch-1",
      leaseEpoch: "lease-1",
    },
    expiresAt: new Date(NOW + 10_000).toISOString(),
  };
}

export type FiniteRuleFixture = Extract<StrictPermissionRule, { expiresAt: string }>;
export function ruleFixture(action = actionFixture()): FiniteRuleFixture {
  return {
    ruleId: "rule-1",
    ruleRevision: "revision-1",
    status: "approved",
    notBefore: new Date(NOW - 1000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    decision: "allow",
    match: {
      principalRef: action.invocation.principalRef,
      agentId: action.invocation.agentId,
      hostId: action.invocation.hostId,
      runnerId: action.invocation.runnerId,
      operation: action.operation,
      profileRef: action.profileRef,
      coverageId: action.coverage.coverageId,
      effectiveCwd: "test:cwd",
      workspaceRef: "test:workspace",
      resources: [{ operation: "read", physicalTargetRef: "test:resource" }],
      environmentAndCredentialRefs: [],
    },
  };
}

export function stateFixture(action = actionFixture()): StrictPermissionState {
  return {
    authority: { ...action.authority },
    currentAuthority: complete(true),
    capturedCeiling: complete(true),
    protectedAccess: complete(true),
    coverageAndState: complete(true),
    mandatoryHuman: complete(false),
    rules: complete([ruleFixture(action)]),
    profile: complete({
      profileRef: action.profileRef,
      minimumCoverage: "verified-per-execution",
      facts: {
        rawDuplicateKeyValidation: "complete-or-absent",
        effectiveCwd: "complete",
        workspaceRef: "complete",
        resources: "complete",
        executableAndInterpreter: "complete-or-absent",
        stdin: "complete-or-absent",
        environmentAndCredentialRefs: "complete",
        relevantStateRefs: "complete",
      },
    }),
  };
}

export function reviewState(requirement: "advisory" | "required" = "required"): StrictPermissionState {
  return {
    ...stateFixture(),
    rules: complete([
      {
        ...ruleFixture(),
        delegation: {
          requirement,
          projectionPolicyRevision: "projection-1",
          destinationPolicyRef: "destination-1",
          judgeConfigRef: "judge-1",
          maximumDurationMs: 4000,
          onNotFit: "deny",
          onIndeterminate: "require-human",
          allowWhenUnavailable: requirement === "advisory",
        },
      },
    ]),
  };
}

export async function registerReview(port: PolicyPortV1, signal = new AbortController().signal) {
  const action = actionFixture();
  const evaluation = await port.evaluate(action, signal);
  if (evaluation.phase !== "needs-review") throw new Error("expected eligible review");
  const request: JudgeRequestV1 = {
    ...evaluation.review,
    approvedProjection: {
      kind: "utf8-bytes",
      codecVersion: "test:projection-codec",
      privateRef: "test:projection",
      bindingRef: "test:projection-binding",
    },
  };
  const bound = await port.bindReview(evaluation.pending, request, signal);
  const result: JudgeResultV1 = {
    version: 1,
    actionBindingRef: request.actionBindingRef,
    authority: { ...request.authority },
    coverageId: request.coverageId,
    reviewId: request.reviewId,
    reasonCode: "test:fit",
    judgeVersion: request.judgeConfigRef,
    projectionBindingRef: request.approvedProjection.bindingRef,
    execution: "evaluated",
    result: "fit",
  };
  return { action, request, bound, result, signal };
}
