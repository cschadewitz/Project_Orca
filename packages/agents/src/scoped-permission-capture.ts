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
    readonly target: ScopedCaptureTarget;
    readonly binding: ManagedTypedStoreBinding;
    readonly actor: MutationActor;
    /** Outcome of the actual required review, retained by its owner, never a client/model claim. */
    readonly review: {
      readonly result: "passed" | "failed" | "unavailable";
      readonly sourceRefs: readonly string[];
    };
  };
  /** Synchronous retained executor/attempt/ceiling/expiry/lease assertion. Never deserialize a token. */
  assertCurrent(capture: ScopedPermissionCapture, authority: AuthorityStampV1): undefined;
  /** After confirmed publication, retire every unconsumed old decision/permit and create
   * a fresh decision attempt under the ORIGINAL invocation/captured ceilings. Never change
   * an immutable action, resend an uncertain effect or reconstruct a callback from disk.
   * A started/uncertain dispatch must refuse. A fresh capture must precede another review.
   */
  policyChanged(capture: ScopedPermissionCapture, facts: ScopedCaptureFacts): Promise<void>;
}
