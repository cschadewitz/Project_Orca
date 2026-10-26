/** #700 v1 design ports only. No runtime implementation, exports or production registration. */

/** Complete means authoritative for the named attribute, not knowledge of every future effect. */
export type FactV1<T> =
  | { readonly state: "complete"; readonly value: T }
  | { readonly state: "absent"; readonly reason: string }
  | { readonly state: "unknown"; readonly reason: string };

/** References resolve only in the existing protected execution store; never public secret hashes. */
export interface RepresentationV1 {
  readonly kind: "utf8-bytes" | "parsed-json";
  readonly codecVersion: string;
  readonly privateRef: string;
  readonly bindingRef: string;
}

export interface InvocationV1 {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly rootRunId: string;
  readonly stepRunId: string;
  readonly attemptId: string;
  readonly agentId: string;
  readonly hostId: string;
  readonly runnerId: string;
  readonly principalRef: string;
}

export interface AuthorityStampV1 {
  readonly capturedGeneration: string;
  readonly currentPolicyRevision: string;
  readonly authorityRevision: string;
  readonly revocationEpoch: string;
  readonly leaseEpoch: string;
}

/** Names one exact path. No wildcard provider/version/host qualification in v1. */
export interface CoverageV1 {
  readonly version: 1;
  readonly coverageId: string;
  readonly boundaryId: string;
  readonly provider: string;
  readonly providerVersion: string;
  readonly adapterVersion: string;
  readonly tool: string;
  readonly toolSchemaVersion: string;
  readonly hostId: string;
  readonly platform: string;
  readonly level: "unknown" | "observation" | "policy-per-ask" | "verified-per-execution";
  readonly evidence: {
    readonly sourceRefs: readonly string[];
    readonly installedRefs: readonly string[];
    readonly independentlyObservedEffects: boolean;
  };
  readonly negotiatedHook: FactV1<string>;
  readonly protectedConfiguration: FactV1<string>;
  readonly guaranteedEffects: readonly string[];
  readonly unsupportedPaths: readonly string[];
}

export interface NativeChoiceV1 {
  readonly optionId: string;
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "unknown";
  /** Adapter qualification, not a conclusion inferred from the option's spelling. */
  readonly effect: "this-invocation" | "remembered" | "unknown";
  readonly qualificationRef: FactV1<string>;
  readonly grantScopeAndLifetime: FactV1<{
    readonly scopeRef: string;
    readonly expiresAt: string | null;
    readonly maximumUses: number | null;
  }>;
}

export interface ActionEvidenceV1 {
  readonly version: 1;
  readonly actionId: string;
  readonly bindingRef: string;
  readonly capturedByBoundaryId: string;
  readonly invocation: InvocationV1;
  readonly coverage: CoverageV1;
  readonly operation: string;
  readonly profileRef: string;
  readonly original: RepresentationV1;
  readonly dispatch: RepresentationV1;
  readonly transformations: readonly string[];
  readonly rawDuplicateKeyValidation: FactV1<string>;
  readonly effectiveCwd: FactV1<string>;
  readonly workspaceRef: FactV1<string>;
  readonly resources: FactV1<readonly { readonly operation: string; readonly physicalTargetRef: string }[]>;
  readonly executableAndInterpreter: FactV1<readonly string[]>;
  readonly stdin: FactV1<RepresentationV1>;
  readonly environmentAndCredentialRefs: FactV1<readonly string[]>;
  readonly relevantStateRefs: FactV1<readonly string[]>;
  readonly offeredChoices: readonly NativeChoiceV1[];
  readonly authority: AuthorityStampV1;
  readonly expiresAt: string;
}

export interface DecisionBindingV1 {
  readonly version: 1;
  readonly actionBindingRef: string;
  readonly authority: AuthorityStampV1;
  readonly coverageId: string;
}

export type PolicyVerdictV1 = DecisionBindingV1 &
  (
    | {
        readonly outcome: "allow";
        readonly authorizedBy:
          | { readonly kind: "rule"; readonly ruleId: string; readonly ruleRevision: string }
          | { readonly kind: "human"; readonly acceptedAnswerRef: string };
        readonly judgeResultRef?: string;
      }
    | { readonly outcome: "deny" | "require-human" | "indeterminate"; readonly reason: string }
  );

/** The daemon binds this internal port to verified authority; never deserialize it from RPC. */
export interface PolicyPortV1 {
  readonly version: 1;
  evaluate(action: ActionEvidenceV1, signal: AbortSignal, review?: JudgeResultV1): Promise<PolicyVerdictV1>;
}

/** Constructed only after deterministic ceilings and explicit rule-delegated judgment eligibility. */
export interface JudgeRequestV1 extends DecisionBindingV1 {
  readonly reviewId: string;
  readonly delegation: { readonly ruleId: string; readonly ruleRevision: string };
  readonly requirement: "advisory" | "required";
  readonly approvedProjection: RepresentationV1;
  readonly projectionPolicyRevision: string;
  readonly destinationPolicyRef: string;
  readonly deadlineAt: string;
}

export interface JudgeResultV1 extends DecisionBindingV1 {
  readonly reviewId: string;
  readonly result: "fit" | "not-fit" | "indeterminate";
  readonly reasonCode: string;
  readonly judgeVersion: string;
  readonly projectionBindingRef: string;
}

/** Replaceable method/transport; no credential, tool, policy-write or permit capability. */
export interface ReviewJudgeV1 {
  readonly version: 1;
  assess(request: JudgeRequestV1, signal: AbortSignal): Promise<JudgeResultV1>;
}

declare const permitBrand: unique symbol;
/** Owner-local opaque handle, not a serializable bearer token or a caller-provided action ID. */
export interface OneUsePermitV1 {
  readonly [permitBrand]: true;
}

export interface ExecutionReceiptV1 {
  readonly version: 1;
  readonly actionId: string;
  readonly state: "not-dispatched" | "completed" | "failed" | "execution-unknown";
  readonly protectedEvidenceRef: string;
}

/** Internal capability bound to one registered executor, lease and original invocation. */
export interface EnforcementPortV1 {
  readonly version: 1;
  /** Revalidate and retain a trusted captured action; a verdict alone never mints a permit. */
  authorize(
    action: ActionEvidenceV1,
    verdict: Extract<PolicyVerdictV1, { outcome: "allow" }>,
    signal: AbortSignal,
  ): Promise<OneUsePermitV1>;
  /** Recheck/consume atomically under ownership; dispatch retained bytes, never replacement arguments. */
  dispatch(permit: OneUsePermitV1, signal: AbortSignal): Promise<ExecutionReceiptV1>;
}
