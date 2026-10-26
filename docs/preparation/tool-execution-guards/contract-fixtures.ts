/** Static consumer fixtures; compile-time separation only, never enforcement/effect evidence. */
import type {
  ActionEvidenceV1,
  AuthorityStampV1,
  CoverageV1,
  EnforcementPortV1,
  FactV1,
  JudgeResultV1,
  NativeChoiceV1,
  OneUsePermitV1,
  PolicyVerdictV1,
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

// These declarations are never emitted or run. @ts-expect-error must fail if the boundary widens.
function negativeFixtures(port: EnforcementPortV1): void {
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
  void [unauthorized, forged, unknown, once];
}
void negativeFixtures;
