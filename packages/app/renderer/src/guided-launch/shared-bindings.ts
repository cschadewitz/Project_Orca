/** Compatible mappings to the integrator's pinned shared declaration; no second persistence/retry ledger. */
import type {
  CheckoutEvidence,
  EditorTarget,
  GuidedLaunchPorts,
  LaunchResponse,
  LaunchReview as SharedLaunchReview,
  RetainedLaunch,
} from "../../../src/configuration-launch-contract.js";
import { RunsAdmitResultSchema } from "@orca/protocol";
import type {
  LaunchDraft,
  LaunchIntent,
  LaunchPorts,
  LaunchReceipt,
  LaunchResult,
  LaunchReview,
  LaunchTarget,
} from "./contracts.js";
import { LaunchPortFailure } from "./contracts.js";

export const SHARED_LAUNCH_DECLARATION_SHA = "703c422aef6df7b0af008ec53349cab3e711f2f5";
export function editorTarget(target: LaunchTarget): EditorTarget {
  return { workspaceId: target.workspaceId, instanceId: target.instanceId, epoch: target.epoch };
}
function sameEditorTarget(a: EditorTarget, b: EditorTarget): boolean {
  return a.workspaceId === b.workspaceId && a.instanceId === b.instanceId && a.epoch === b.epoch;
}
/** Real checkout evidence is required: a summary/path cannot become a verified observation. */
export function sharedLaunchReview(review: LaunchReview, checkout: CheckoutEvidence): SharedLaunchReview {
  const target = editorTarget(review.target);
  if (
    checkout.state !== "verified" ||
    !sameEditorTarget(checkout.target, target) ||
    checkout.configGeneration !== review.generation ||
    checkout.evidenceId !== review.rootRevision
  )
    throw new LaunchPortFailure("stale");
  const params = review.command.params;
  if (
    params.workflowId !== review.workflowId ||
    params.workflowVersion !== review.workflowVersion ||
    params.expectedWorkflowRevision !== review.workflowRevision ||
    params.expectedConfigGeneration !== review.generation
  )
    throw new LaunchPortFailure("stale");
  return {
    target,
    draftSequence: review.draftSequence,
    command: structuredClone(review.command),
    workflowId: review.workflowId,
    workflowVersion: review.workflowVersion,
    expectedWorkflowRevision: review.workflowRevision,
    expectedConfigGeneration: review.generation,
    checkout: structuredClone(checkout),
  };
}
/** Operator preflight has no override validation field. Any additional validation seam is explicit. */
export function sharedPreflight(
  shared: Pick<GuidedLaunchPorts, "preflight" | "checkout">,
  binding: {
    assertCurrent: (target: LaunchTarget) => void;
    configuredRootId: string;
    validateOverrides?: (draft: Pick<LaunchDraft, "overrides" | "workflowId">, generation: string) => Promise<void>;
  },
): LaunchPorts["preflight"] {
  return async (candidate) => {
    binding.assertCurrent(candidate.target);
    if (candidate.rootId !== binding.configuredRootId) throw new LaunchPortFailure("unavailable");
    if (candidate.overrides !== undefined && binding.validateOverrides === undefined)
      throw new LaunchPortFailure("unavailable");
    const target = editorTarget(candidate.target);
    const result = await shared.preflight(
      {
        target: { workspaceId: target.workspaceId, instanceId: target.instanceId },
        purpose: candidate.mode === "direct" ? "workflow" : "request",
        workflowId: candidate.workflowId,
        workflowVersion: candidate.workflowVersion,
        vars: candidate.vars,
      },
      target,
    );
    binding.assertCurrent(candidate.target);
    if (candidate.overrides !== undefined)
      await binding.validateOverrides!(
        { overrides: candidate.overrides, workflowId: candidate.workflowId },
        result.expectedConfigGeneration,
      );
    const checkout = await shared.checkout(target, result.expectedConfigGeneration);
    binding.assertCurrent(candidate.target);
    if (
      checkout.state !== "verified" ||
      !sameEditorTarget(checkout.target, target) ||
      checkout.configGeneration !== result.expectedConfigGeneration
    )
      throw new LaunchPortFailure("stale");
    return { ...result, rootId: candidate.rootId, rootRevision: checkout.evidenceId, checkout };
  };
}
/** Retry result decoding uses the canonical schema supplied by integration, never a guessed payload. */
export function sharedLaunchResult(
  response: LaunchResponse,
  mode: LaunchDraft["mode"],
  decodeRetryReceipt: (raw: unknown, mode: LaunchDraft["mode"], operationId?: string) => LaunchReceipt,
): LaunchResult {
  if (response.kind === "direct") {
    if (mode !== "direct") throw new LaunchPortFailure("unavailable");
    RunsAdmitResultSchema.parse(response.receipt);
    return response.receipt;
  }
  if (response.kind === "request") {
    if (mode !== "request") throw new LaunchPortFailure("unavailable");
    return response.receipt;
  }
  if (response.receipt.state === "in-progress") return response.receipt;
  const receipt = decodeRetryReceipt(response.receipt.result, mode, response.receipt.operationId);
  if ((mode === "request") !== "requestId" in receipt) throw new LaunchPortFailure("unavailable");
  return { ...response.receipt, result: receipt };
}
export function retainedLaunchHandle(
  retained: RetainedLaunch,
  target: LaunchTarget,
  mode: LaunchDraft["mode"],
  workflowId: string,
): LaunchIntent {
  if (
    !sameEditorTarget(retained.target, editorTarget(target)) ||
    retained.mode !== mode ||
    retained.workflowId !== workflowId
  )
    throw new LaunchPortFailure("stale");
  return { id: retained.intentId };
}
/** Canonical recovery may return any declared response kind; never fabricate a missing envelope. */
export function sharedRecovery(
  shared: Pick<GuidedLaunchPorts, "recover">,
  binding: {
    target: LaunchTarget;
    mode: LaunchDraft["mode"];
    action: "inspect" | "reconcile";
    assertCurrent: (target: LaunchTarget) => void;
    decodeRetryReceipt: (raw: unknown, mode: LaunchDraft["mode"], operationId?: string) => LaunchReceipt;
  },
): LaunchPorts["recover"] {
  return async (intent) => {
    binding.assertCurrent(binding.target);
    const response = await shared.recover(intent.id, binding.action);
    binding.assertCurrent(binding.target);
    return sharedLaunchResult(response, binding.mode, binding.decodeRetryReceipt);
  };
}
/** Compatible atomic owner submission. It does not infer a missing handle from retained() metadata. */
export function sharedSubmission(
  shared: Pick<GuidedLaunchPorts, "submit">,
  binding: {
    assertCurrent: (target: LaunchTarget) => void;
    decodeRetryReceipt: (raw: unknown, mode: LaunchDraft["mode"], operationId?: string) => LaunchReceipt;
  },
): NonNullable<LaunchPorts["launch"]> {
  return async (review) => {
    binding.assertCurrent(review.target);
    if (review.checkout === undefined) throw new LaunchPortFailure("unavailable");
    const result = await shared.submit(sharedLaunchReview(review, review.checkout));
    // Keep the known retained handle even if the renderer changed target while waiting;
    // the UI controller fences navigation and requires original-target review for recovery.
    const intent = retainedLaunchHandle(result.intent, review.target, review.command.mode, review.workflowId);
    return { intent, response: sharedLaunchResult(result.response, review.command.mode, binding.decodeRetryReceipt) };
  };
}
