/** Trusted engine/daemon handoff. No action JSON, persisted reference or UI proof is a capture. */
import type { ActionEvidenceV1, AuthorityStampV1, MutationActor } from "@orca/core";
import type { ManagedTypedStoreBinding } from "./managed-typed-store.js";
import type { CreateScopedRule } from "./typed-sidecar.js";

/** Protected approval of the generated standing command, distinct from the
 * earlier action-scoped persistence review. This is never execution authority. */
export interface StandingGrantReview {
  readonly version: 2;
  readonly result: "passed";
  readonly sourceRefs: readonly string[];
}

/** Non-executable historical scope retained while the original capture was live.
 * Its owner checks pending-run lifetime/cancellation independently of action expiry.
 * This capability is never reconstructed from these record fields or RPC JSON.
 * Embeddings must separate run/resource cancellation from the action clock to
 * support longer waits; a cancelled original owner signal remains a refusal. */
export interface PendingScopedGrant {
  readonly capturedAt: number;
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
  retire(): undefined;
}
export interface StandingGrantIntent {
  readonly version: 1;
  readonly intentId: string;
  readonly capturedAt: number;
  readonly action: ActionEvidenceV1;
  readonly command: CreateScopedRule;
  readonly actor: MutationActor;
  readonly target: ScopedCaptureTarget;
  readonly binding: Pick<ManagedTypedStoreBinding, "workspaceRef" | "rootBindingRef" | "enrollmentRef">;
}
/** Save is its own mutation, never an extension of the historical read action. */
export interface ScopedSaveAuthority {
  readonly version: 1;
  readonly authorizationId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly facts: ScopedCaptureFacts;
}
export interface StandingIntentReview {
  readonly version: 3;
  readonly result: "passed";
  readonly sourceRefs: readonly string[];
}
export interface StandingIntentReviewRequest {
  readonly intent: StandingGrantIntent;
  readonly saveAuthority: ScopedSaveAuthority;
}
/** Trusted reviewer work scope. All owned I/O uses this callback; cancellation
 * can stop an effectless wait but never abandon an already-started publication. */
export interface ScopedSaveReviewScope {
  readonly signal: AbortSignal;
  withOwnedWork<T>(work: () => Promise<T>): Promise<T>;
}

export type ScopedCaptureTarget = Pick<
  ActionEvidenceV1["invocation"],
  "instanceId" | "sessionId" | "turnId" | "invocationId" | "runId" | "stepRunId"
> & { readonly requestId: string };
declare const captureBrand: unique symbol;
export interface ScopedPermissionCapture {
  readonly [captureBrand]: true;
}
export interface ScopedCaptureFacts {
  readonly policyRevision: string;
  readonly authorityRevision: string;
  readonly revocationEpoch: string;
  readonly leaseEpoch: string;
}
export interface ScopedPermissionCapturePort {
  /** Resolve ONLY a capture already retained by the real executor for this live input.
   * Facts are observed from the canonical store/current credential/held run lease BEFORE
   * the producer captures action authority. Returning an older immutable action fails.
   */
  read(
    target: ScopedCaptureTarget,
    binding: ManagedTypedStoreBinding,
    facts: ScopedCaptureFacts,
  ): Promise<ScopedPermissionCapture>;
  /** Existing executor-retained action lookup for automatic decisions, without opening a review. */
  forAction(action: ActionEvidenceV1, binding: ManagedTypedStoreBinding): Promise<ScopedPermissionCapture>;
  snapshot(capture: ScopedPermissionCapture): {
    readonly action: ActionEvidenceV1;
    /** Absent for a closed automatic capture; there is no live query or answer target. */
    readonly target?: ScopedCaptureTarget;
    readonly binding: ManagedTypedStoreBinding;
    /** Original resource workspace; distinct from the managed policy workspace identity. */
    readonly resourceWorkspaceRef: string;
    readonly actor: MutationActor;
    /** Outcome of the actual required review, retained by its owner, never a client/model claim. */
    /** Distinct authenticated persistence review; never rewrites execution judge provenance. */
    readonly persistenceReview?: { readonly result: "passed"; readonly sourceRefs: readonly string[] };
    readonly review: {
      readonly result: "passed" | "failed" | "unavailable";
      readonly sourceRefs: readonly string[];
    };
  };
  /** Optional trusted owner capability, unavailable to RPC/JSON. Authenticate exact saved
   * persistence attestation using protected records and independently current reviewer authority. */
  verifyPersistenceReview?(
    action: ActionEvidenceV1,
    sourceRefs: readonly string[],
  ): Promise<{ assertCurrent(): undefined }>;
  /** Called only after the exact until-revoked command exists, while the original
   * Save action and reviewer are live. The result binds scope AND grant lifetime. */
  reviewStandingGrant?(capture: ScopedPermissionCapture, command: CreateScopedRule): Promise<StandingGrantReview>;
  /** Authenticate that versioned protected approval at its original acceptance
   * time and freshly verify its records/reviewer. An expired historical action
   * is not reused as a present action, capture, callback or permit. */
  verifyStandingGrantReview?(
    action: ActionEvidenceV1,
    command: CreateScopedRule,
    review: StandingGrantReview,
  ): Promise<{ assertCurrent(): undefined }>;
  /** Opt-in trusted producer: retain a non-executable intent before the original
   * capture expires. Missing any v3 port leaves existing v1/v2 behavior unchanged. */
  retainGrantIntent?(capture: ScopedPermissionCapture, command: CreateScopedRule): Promise<PendingScopedGrant>;
  /** Only explicit authenticated Save can request this new protected review. */
  reviewStandingIntent?(
    capture: ScopedPermissionCapture,
    request: StandingIntentReviewRequest,
    scope: ScopedSaveReviewScope,
  ): Promise<StandingIntentReview>;
  verifyStandingIntentReview?(
    request: StandingIntentReviewRequest,
    review: StandingIntentReview,
    scope?: ScopedSaveReviewScope,
  ): Promise<{ assertCurrent(): undefined }>;
  /** Synchronous retained executor/attempt/ceiling/expiry/lease assertion. Never deserialize a token. */
  assertCurrent(capture: ScopedPermissionCapture, authority: AuthorityStampV1): undefined;
  /** #734's actual service.refreshPolicyRevision transition: exactly once, only after
   * evaluated require-human and BEFORE ANY permit authorization started. The original
   * snapshot may change only currentPolicyRevision. Retire the old fence synchronously,
   * preserve original parameters/policy/captured ceilings/expiry/cancellation and retain
   * the returned real facade/action. Never mutate immutable evidence, resend an uncertain
   * effect or reconstruct a callback from disk. A fresh capture precedes another review.
   */
  policyChanged(capture: ScopedPermissionCapture, facts: ScopedCaptureFacts): Promise<void>;
}
