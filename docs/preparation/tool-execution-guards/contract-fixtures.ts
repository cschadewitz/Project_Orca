/** Static consumer fixtures; compile-time separation only, never enforcement/effect evidence. */
import type {
  ActionEvidenceV1,
  ApprovedJudgePayloadV1,
  AuthorityStampV1,
  BoundReviewV1,
  CoverageV1,
  EnforcementPortV1,
  FactV1,
  JudgeRequestV1,
  JudgeResultV1,
  NativeChoiceV1,
  OneUsePermitV1,
  PendingReviewV1,
  PolicyEvaluationV1,
  PolicyPortV1,
  PolicyVerdictV1,
  ReviewJudgeV1,
} from "./contract.js";

const authority = {
  capturedGeneration: "synthetic-captured-1",
  currentPolicyRevision: "synthetic-policy-2",
  authorityRevision: "synthetic-authority-1",
  revocationEpoch: "synthetic-revocation-1",
  leaseEpoch: "synthetic-lease-1",
} as const satisfies AuthorityStampV1;

const coverage = {
  version: 1,
  coverageId: "synthetic-observation-only",
  boundaryId: "synthetic-fs-read",
  provider: "synthetic",
  providerVersion: "fixture-1",
  adapterVersion: "fixture-1",
  tool: "fs/read_text_file",
  toolSchemaVersion: "fixture-1",
  hostId: "synthetic-host",
  platform: "fixture",
  level: "observation",
  evidence: { sourceRefs: [], installedRefs: [], independentlyObservedEffects: false },
  negotiatedHook: { state: "unknown", reason: "not installed" },
  protectedConfiguration: { state: "unknown", reason: "not installed" },
  guaranteedEffects: [],
  unsupportedPaths: ["all execution: type-only preparation"],
} as const satisfies CoverageV1;

const action = {
  version: 1,
  actionId: "synthetic-action-1",
  bindingRef: "synthetic-private-binding-1",
  capturedByBoundaryId: coverage.boundaryId,
  invocation: {
    instanceId: "synthetic-boot",
    sessionId: "synthetic-session",
    turnId: "synthetic-turn",
    invocationId: "synthetic-invocation",
    runId: "synthetic-run",
    rootRunId: "synthetic-run",
    stepRunId: "synthetic-step",
    attemptId: "synthetic-attempt",
    agentId: "synthetic-agent",
    hostId: coverage.hostId,
    runnerId: "synthetic-runner",
    principalRef: "synthetic-principal",
  },
  coverage,
  operation: "read",
  profileRef: "synthetic-profile-1",
  original: {
    kind: "parsed-json",
    codecVersion: "fixture-1",
    privateRef: "synthetic-args",
    bindingRef: "synthetic-args-binding",
  },
  dispatch: {
    kind: "parsed-json",
    codecVersion: "fixture-1",
    privateRef: "synthetic-args",
    bindingRef: "synthetic-args-binding",
  },
  transformations: [],
  rawDuplicateKeyValidation: { state: "unknown", reason: "SDK supplied parsed JSON" },
  effectiveCwd: { state: "complete", value: "/synthetic/work" },
  workspaceRef: { state: "complete", value: "synthetic-worktree" },
  resources: { state: "unknown", reason: "physical target not captured" },
  executableAndInterpreter: { state: "absent", reason: "typed read has no process" },
  stdin: { state: "absent", reason: "typed read has no stdin" },
  environmentAndCredentialRefs: { state: "complete", value: [] },
  relevantStateRefs: { state: "unknown", reason: "no stable file handle" },
  offeredChoices: [],
  authority,
  expiresAt: "2026-10-26T03:00:00Z",
} as const satisfies ActionEvidenceV1;

const binding = {
  version: 1,
  actionBindingRef: action.bindingRef,
  authority,
  coverageId: coverage.coverageId,
} as const;
const indeterminate = {
  ...binding,
  outcome: "indeterminate",
  reason: "unqualified-boundary",
} as const satisfies PolicyVerdictV1;
const judge = {
  ...binding,
  reviewId: "synthetic-review",
  execution: "evaluated",
  result: "fit",
  reasonCode: "synthetic-fit",
  judgeVersion: "fixture-1",
  projectionBindingRef: "synthetic-projection",
} as const satisfies JudgeResultV1;
const remembered = {
  optionId: "synthetic-always",
  kind: "allow_always",
  effect: "remembered",
  qualificationRef: { state: "unknown", reason: "not qualified" },
  grantScopeAndLifetime: { state: "unknown", reason: "native lifetime not qualified" },
} as const satisfies NativeChoiceV1;

// Positive phase fixture: engine consumes eligibility, projects, registers, schedules, then completes.
// Declared for type checking only; no private store, judge or policy implementation is called.
async function reviewPhases(policy: PolicyPortV1, reviewer: ReviewJudgeV1): Promise<PolicyVerdictV1> {
  const signal = new AbortController().signal;
  const evaluation = await policy.evaluate(action, signal);
  if (evaluation.phase === "final") return evaluation.verdict;
  const request = {
    ...evaluation.review,
    approvedProjection: {
      kind: "parsed-json",
      codecVersion: "fixture-1",
      privateRef: "synthetic-safe-projection",
      bindingRef: "synthetic-projection",
    },
  } as const satisfies JudgeRequestV1;
  const bound = await policy.bindReview(evaluation.pending, request, signal);
  const payload = {
    version: 1,
    bindingRef: request.approvedProjection.bindingRef,
    schemaVersion: "fixture-1",
    content: '{"synthetic":"safe"}',
  } as const satisfies ApprovedJudgePayloadV1;
  const result = await reviewer.assess(request, payload, signal);
  return policy.completeReview(bound, result, signal);
}
void reviewPhases;

// These declarations are never emitted or run. @ts-expect-error must fail if the boundary widens.
function negativeFixtures(port: EnforcementPortV1, policy: PolicyPortV1, evaluation: PolicyEvaluationV1): void {
  // @ts-expect-error A model fit result is not a policy authorization.
  const unauthorized: PolicyVerdictV1 = judge;
  // @ts-expect-error Non-allow outcomes cannot be passed as permit-eligible verdicts.
  void port.authorize(action, indeterminate, new AbortController().signal);
  // @ts-expect-error Public correlation fields cannot construct the private permit brand.
  const forged: OneUsePermitV1 = { actionId: action.actionId };
  // @ts-expect-error Unknown facts cannot quietly carry an authoritative value.
  const unknown: FactV1<string> = { state: "unknown", value: "guessed" };
  // @ts-expect-error Dispatch accepts only a retained permit, not substituted action bytes.
  void port.dispatch(action, new AbortController().signal);
  // @ts-expect-error A remembered grant is not a this-invocation effect.
  const once: NativeChoiceV1 & { effect: "this-invocation" } = remembered;
  // @ts-expect-error Evaluation no longer accepts an unregistered optional review result.
  void policy.evaluate(action, new AbortController().signal, judge);
  // @ts-expect-error A public review ID cannot construct a policy-owned pending ticket.
  const pending: PendingReviewV1 = { reviewId: judge.reviewId };
  // @ts-expect-error Eligibility is not the retained exact-request registration.
  const bound: BoundReviewV1 = pending;
  // @ts-expect-error Completing review requires a registered request, never a result as authority.
  void policy.completeReview(judge, judge, new AbortController().signal);
  if (evaluation.phase === "needs-review") {
    // @ts-expect-error Needs-review is not a final verdict eligible to authorize dispatch.
    void port.authorize(action, evaluation, new AbortController().signal);
  }
  // @ts-expect-error Unavailable review cannot carry fit advice.
  const unavailableFit: JudgeResultV1 = { ...judge, execution: "unavailable" };
  // @ts-expect-error A protected reference is not materialized approved payload content.
  const unmaterialized: ApprovedJudgePayloadV1 = action.original;
  void [unauthorized, forged, unknown, once, bound, unavailableFit, unmaterialized];
}
void negativeFixtures;
