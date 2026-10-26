/** Inactive #706 display/audit projection. No record adapter, policy evaluation, RPC or UI registration. */
import { z } from "zod";
import type { CoverageV1, ExecutionReceiptV1, FactV1, JudgeResultV1, PolicyVerdictV1 } from "@orca/core";

type ReferenceKind = "coverage" | "rule" | "revision" | "authorizer" | "review" | "receipt" | "observation";
const safeReference = z.strictObject({ id: z.uuid() });
export type GuardSafeReference = z.infer<typeof safeReference>;

/** Trusted sensitivity owner supplies destination-specific approval, never an identity/string sanitizer.
 * IDs must be independently assigned public opaque references, not secret hashes or encoded private values.
 * This capability neither reads protected records nor authorizes an action. Production binding needs privacy review.
 */
export interface GuardProjectionDisclosure {
  requiredDisclosure(snapshot: unknown): "complete" | "unavailable";
  reference(kind: ReferenceKind, privateRef: string): GuardSafeReference | undefined;
}

type Observation = {
  readonly status: "observed" | "not-observed";
  readonly sourceRef: string;
  readonly observedAt: string;
};
export interface GuardDecisionProjectionInput {
  readonly coverage?: CoverageV1;
  readonly unsupported?: FactV1<boolean>;
  readonly verdict?: PolicyVerdictV1;
  readonly review?: JudgeResultV1;
  readonly reviewRef?: string;
  readonly receipt?: ExecutionReceiptV1;
  readonly currentAuthority?: FactV1<boolean>;
  readonly authorityKind?: FactV1<"one-shot" | "stored-rule">;
  readonly expiresAt?: FactV1<string | null>;
  readonly revocation?: FactV1<"active" | "revoked">;
  readonly revocationLatencyMs?: FactV1<number>;
  readonly observations?: Partial<Record<"recording" | "delivery" | "dispatch" | "effect", FactV1<Observation>>>;
}

// Parse only named fields; never copy arbitrary reasons, scope, labels, commands, paths or model output.
const privateRef = z.string().min(1).max(4096);
const timestamp = z.iso.datetime();
const fact = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("state", [
    z.object({ state: z.literal("complete"), value }),
    z.object({ state: z.literal("absent"), reason: z.string().max(4096) }),
    z.object({ state: z.literal("unknown"), reason: z.string().max(4096) }),
  ]);
const authorityStamp = z.object({
  capturedGeneration: privateRef,
  currentPolicyRevision: privateRef,
  authorityRevision: privateRef,
  revocationEpoch: privateRef,
  leaseEpoch: privateRef,
});
const binding = z.object({
  version: z.literal(1),
  actionBindingRef: privateRef,
  coverageId: privateRef,
  authority: authorityStamp,
});
const verdict = z.discriminatedUnion("outcome", [
  binding.extend({
    outcome: z.literal("allow"),
    authorizedBy: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("rule"), ruleId: privateRef, ruleRevision: privateRef }),
      z.object({ kind: z.literal("human"), acceptedAnswerRef: privateRef }),
    ]),
    judgeResultRef: privateRef.optional(),
  }),
  binding.extend({ outcome: z.enum(["deny", "require-human", "indeterminate"]), reason: z.string().max(4096) }),
]);
const review = binding.extend({
  reviewId: privateRef,
  judgeVersion: privateRef,
  projectionBindingRef: privateRef,
  reasonCode: z.string().max(4096),
  execution: z.enum(["evaluated", "unavailable"]),
  result: z.enum(["fit", "not-fit", "indeterminate"]),
});
const coverage = z.object({
  version: z.literal(1),
  coverageId: privateRef,
  boundaryId: privateRef,
  provider: privateRef,
  providerVersion: privateRef,
  adapterVersion: privateRef,
  tool: privateRef,
  toolSchemaVersion: privateRef,
  hostId: privateRef,
  platform: privateRef,
  level: z.enum(["unknown", "observation", "policy-per-ask", "verified-per-execution"]),
  evidence: z.object({
    sourceRefs: z.array(privateRef).max(256),
    installedRefs: z.array(privateRef).max(256),
    independentlyObservedEffects: z.boolean(),
  }),
  negotiatedHook: fact(privateRef),
  protectedConfiguration: fact(privateRef),
  guaranteedEffects: z.array(privateRef).max(256),
  unsupportedPaths: z.array(privateRef).max(256),
});
const observedFact = fact(
  z.object({ status: z.enum(["observed", "not-observed"]), sourceRef: privateRef, observedAt: timestamp }),
).optional();
const inputSchema = z.object({
  coverage: coverage.optional(),
  unsupported: fact(z.boolean()).optional(),
  verdict: verdict.optional(),
  review: review.optional(),
  reviewRef: privateRef.optional(),
  receipt: z
    .object({
      version: z.literal(1),
      actionId: privateRef,
      state: z.enum(["not-dispatched", "completed", "failed", "execution-unknown"]),
      protectedEvidenceRef: privateRef,
    })
    .optional(),
  currentAuthority: fact(z.boolean()).optional(),
  authorityKind: fact(z.enum(["one-shot", "stored-rule"])).optional(),
  expiresAt: fact(timestamp.nullable()).optional(),
  revocation: fact(z.enum(["active", "revoked"])).optional(),
  revocationLatencyMs: fact(z.number().finite().nonnegative()).optional(),
  observations: z
    .object({ recording: observedFact, delivery: observedFact, dispatch: observedFact, effect: observedFact })
    .optional(),
});

interface ProjectedObservation {
  readonly status: "observed" | "not-observed" | "unknown";
  readonly source?: GuardSafeReference;
  readonly observedAt?: string;
}
export interface GuardDecisionView {
  readonly disclosure: "complete" | "unavailable";
  readonly diagnostic: "none" | "invalid-input" | "projection-unavailable";
  /** Reported evidence tier only; this helper cannot certify installed support. */
  readonly coverage: { readonly tier: CoverageV1["level"]; readonly reference?: GuardSafeReference };
  readonly support: "unsupported" | "unknown";
  readonly decision: PolicyVerdictV1["outcome"] | "unknown";
  readonly authorizer: "rule" | "human" | "unknown";
  readonly authorizerReference?: GuardSafeReference;
  readonly matchedRule?: { readonly rule: GuardSafeReference; readonly revision: GuardSafeReference };
  readonly authorityKind: "one-shot" | "stored-rule" | "unknown";
  readonly authority: "current" | "expired" | "revoked" | "unknown";
  readonly expiry: { readonly state: "bounded"; readonly at: string } | { readonly state: "unbounded" | "unknown" };
  readonly revocation: "active" | "revoked" | "unknown";
  readonly revocationLatencyMs?: number;
  readonly review: "fit" | "not-fit" | "indeterminate" | "unavailable" | "unknown";
  readonly reviewReference?: GuardSafeReference;
  readonly execution: ExecutionReceiptV1["state"];
  readonly observations: Readonly<Record<"recording" | "delivery" | "dispatch" | "effect", ProjectedObservation>>;
}

const unknownView = (diagnostic: GuardDecisionView["diagnostic"]): GuardDecisionView => ({
  disclosure: "unavailable",
  diagnostic,
  coverage: { tier: "unknown" },
  support: "unknown",
  decision: "unknown",
  authorizer: "unknown",
  authorityKind: "unknown",
  authority: "unknown",
  expiry: { state: "unknown" },
  revocation: "unknown",
  review: "unknown",
  execution: "execution-unknown",
  observations: {
    recording: { status: "unknown" },
    delivery: { status: "unknown" },
    dispatch: { status: "unknown" },
    effect: { status: "unknown" },
  },
});

/** Total unknown-input boundary with fixed diagnostics. Recompute each snapshot; no cache, merge or replay.
 * Canonical facts must eventually come from an authorized, binding-validated owner, not caller RPC fields.
 * The view is descriptive and must never be used as a permit, policy input or positive-choice eligibility.
 */
export function projectGuardDecision(
  input: unknown,
  disclosure: GuardProjectionDisclosure,
  now: number,
): GuardDecisionView {
  try {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success || !Number.isFinite(now)) return unknownView("invalid-input");
    const data = parsed.data;
    // Approval can inspect the exact parsed snapshot but cannot mutate the retained projection input.
    if (disclosure.requiredDisclosure(structuredClone(data)) !== "complete")
      return unknownView("projection-unavailable");
    const reference = (kind: ReferenceKind, value: string | undefined): GuardSafeReference | undefined => {
      if (!value) return undefined;
      const approved = safeReference.safeParse(disclosure.reference(kind, value));
      return approved.success && approved.data.id !== value ? { id: approved.data.id } : undefined;
    };
    const value = <T>(f: FactV1<T> | undefined): T | undefined => (f?.state === "complete" ? f.value : undefined);
    const cov = data.coverage;
    const coverageReference = reference("coverage", cov?.coverageId);
    const hasCoverage =
      !!coverageReference &&
      !!cov &&
      (cov.level === "unknown" ||
        (cov.evidence.sourceRefs.length > 0 &&
          (cov.level !== "verified-per-execution" ||
            (cov.evidence.installedRefs.length > 0 &&
              cov.evidence.independentlyObservedEffects &&
              !!value(cov.negotiatedHook) &&
              !!value(cov.protectedConfiguration)))));
    const expiry = value(data.expiresAt);
    const revocation = value(data.revocation) ?? "unknown";
    const revocationLatencyMs = value(data.revocationLatencyMs);
    const authority =
      revocation === "revoked"
        ? "revoked"
        : typeof expiry === "string" && Date.parse(expiry) <= now
          ? "expired"
          : revocation === "active" && value(data.currentAuthority) === true && expiry !== undefined
            ? "current"
            : "unknown";
    const v = data.verdict;
    const auth = v?.outcome === "allow" ? v.authorizedBy : undefined;
    const rule = auth?.kind === "rule" ? reference("rule", auth.ruleId) : undefined;
    const revision = auth?.kind === "rule" ? reference("revision", auth.ruleRevision) : undefined;
    const authorizerReference =
      auth?.kind === "human" ? reference("authorizer", auth.acceptedAnswerRef) : rule && revision ? rule : undefined;
    const authorityKind = value(data.authorityKind) ?? "unknown";
    const boundCoverage =
      hasCoverage &&
      (cov?.level === "policy-per-ask" || cov?.level === "verified-per-execution") &&
      cov.coverageId === v?.coverageId;
    const r = data.review;
    const reviewReference = reference("review", data.reviewRef);
    const reviewBound =
      r &&
      v &&
      r.actionBindingRef === v.actionBindingRef &&
      r.coverageId === v.coverageId &&
      (Object.keys(v.authority) as (keyof typeof v.authority)[]).every((key) => r.authority[key] === v.authority[key]);
    const normalizedReview = reviewBound && !(r.execution === "unavailable" && r.result !== "indeterminate");
    const referencedReviewVisible =
      v?.outcome !== "allow" ||
      v.judgeResultRef === undefined ||
      (v.judgeResultRef === data.reviewRef && !!reviewReference && normalizedReview);
    const allowVisible =
      authority === "current" &&
      boundCoverage &&
      value(data.unsupported) === false &&
      !!authorizerReference &&
      authorityKind !== "unknown" &&
      (authorityKind !== "one-shot" || typeof expiry === "string") &&
      (authorityKind !== "stored-rule" || !!(rule && revision)) &&
      referencedReviewVisible;
    const reviewState =
      reviewReference && normalizedReview
        ? r.execution === "unavailable"
          ? "unavailable"
          : r.result === "fit" && !allowVisible
            ? "unknown"
            : r.result
        : "unknown";
    const observation = (key: keyof GuardDecisionView["observations"]): ProjectedObservation => {
      const observed = value(data.observations?.[key]);
      const source = reference("observation", observed?.sourceRef);
      return observed && source && Date.parse(observed.observedAt) <= now
        ? { status: observed.status, source, observedAt: observed.observedAt }
        : { status: "unknown" };
    };
    return {
      disclosure: "complete",
      diagnostic: "none",
      coverage: hasCoverage ? { tier: cov.level, reference: coverageReference } : { tier: "unknown" },
      support: value(data.unsupported) === true ? "unsupported" : "unknown",
      decision: v?.outcome === "allow" ? (allowVisible ? "allow" : "indeterminate") : (v?.outcome ?? "unknown"),
      authorizer: authorizerReference ? (auth?.kind ?? "unknown") : "unknown",
      ...(authorizerReference ? { authorizerReference } : {}),
      ...(rule && revision ? { matchedRule: { rule, revision } } : {}),
      authorityKind:
        authorizerReference && (authorityKind !== "stored-rule" || (rule && revision)) ? authorityKind : "unknown",
      authority: allowVisible ? "current" : authority === "current" ? "unknown" : authority,
      expiry:
        expiry === null ? { state: "unbounded" } : expiry ? { state: "bounded", at: expiry } : { state: "unknown" },
      revocation,
      ...(revocationLatencyMs !== undefined ? { revocationLatencyMs } : {}),
      review: reviewState,
      ...(reviewReference ? { reviewReference } : {}),
      execution: reference("receipt", data.receipt?.protectedEvidenceRef)
        ? (data.receipt?.state ?? "execution-unknown")
        : "execution-unknown",
      observations: {
        recording: observation("recording"),
        delivery: observation("delivery"),
        dispatch: observation("dispatch"),
        effect: observation("effect"),
      },
    };
  } catch {
    return unknownView("projection-unavailable");
  }
}
