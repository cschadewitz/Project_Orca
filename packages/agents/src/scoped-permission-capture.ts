/** Trusted engine/daemon handoff. No action JSON, persisted reference or UI proof is a capture. */
import type { ActionEvidenceV1, AuthorityStampV1, MutationActor } from "@orca/core";
import type { ManagedTypedStoreBinding } from "./managed-typed-store.js";

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
