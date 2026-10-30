/** Opaque owner-local review handles, never private commands or durable authority. */
import { z } from "zod";
import { OperatorTargetSchema } from "./operator-reads.js";
import { LiveDecisionTargetSchema } from "./live-input.js";
const ref = z.strictObject({ id: z.uuid() });
const observation = z.strictObject({
  status: z.enum(["observed", "not-observed", "unknown"]),
  source: ref.optional(),
  observedAt: z.iso.datetime().optional(),
});
export const GuardDecisionViewSchema = z.strictObject({
  disclosure: z.enum(["complete", "unavailable"]),
  diagnostic: z.enum(["none", "invalid-input", "projection-unavailable"]),
  coverage: z.strictObject({
    tier: z.enum(["unknown", "observation", "policy-per-ask", "verified-per-execution"]),
    reference: ref.optional(),
  }),
  support: z.enum(["unsupported", "unknown"]),
  decision: z.enum(["allow", "deny", "require-human", "indeterminate", "unknown"]),
  authorizer: z.enum(["rule", "human", "unknown"]),
  authorizerReference: ref.optional(),
  matchedRule: z.strictObject({ rule: ref, revision: ref }).optional(),
  authorityKind: z.enum(["one-shot", "stored-rule", "unknown"]),
  authority: z.enum(["current", "expired", "revoked", "unknown"]),
  expiry: z.union([
    z.strictObject({ state: z.literal("bounded"), at: z.iso.datetime() }),
    z.strictObject({ state: z.enum(["unbounded", "unknown"]) }),
  ]),
  revocation: z.enum(["active", "revoked", "unknown"]),
  revocationLatencyMs: z.number().finite().nonnegative().optional(),
  review: z.enum(["fit", "not-fit", "indeterminate", "unavailable", "unknown"]),
  reviewReference: ref.optional(),
  execution: z.enum(["not-dispatched", "completed", "failed", "execution-unknown"]),
  observations: z.strictObject({
    recording: observation,
    delivery: observation,
    dispatch: observation,
    effect: observation,
  }),
});
export const ScopedPermissionScopeSchema = z.strictObject(
  Object.fromEntries(
    ["principal", "operation", "resources", "environment", "lifetime", "limits", "authorizer", "coverage"].map((k) => [
      k,
      z.string().min(1).max(4096),
    ]),
  ) as Record<
    "principal" | "operation" | "resources" | "environment" | "lifetime" | "limits" | "authorizer" | "coverage",
    z.ZodString
  >,
);
const handle = z.strictObject({ target: OperatorTargetSchema, handle: z.uuid() });
const outcome = z.enum(["ready", "pending", "saved", "refused", "uncertain", "answered", "cancelled"]);
export const SCOPED_PERMISSION_CONTRACTS = {
  "scopedPermissions.review": {
    params: z.strictObject({ target: OperatorTargetSchema, input: LiveDecisionTargetSchema.strict() }),
    result: z.strictObject({
      handle: z.uuid(),
      reviewUntil: z.number().finite(),
      scope: ScopedPermissionScopeSchema,
      requiredReview: z.enum(["passed", "failed", "unavailable"]),
      standingReview: z.enum(["available", "unavailable"]).optional(),
      decision: GuardDecisionViewSchema,
    }),
  },
  "scopedPermissions.choose": {
    params: handle.extend({ choice: z.enum(["save", "allow-once", "deny"]) }),
    result: z.strictObject({ outcome }),
  },
  "scopedPermissions.inspect": { params: handle, result: z.strictObject({ outcome, retainedRule: z.boolean() }) },
  "scopedPermissions.cancel": { params: handle, result: z.strictObject({ outcome: z.literal("cancelled") }) },
} as const;
export type ScopedPermissionMethod = keyof typeof SCOPED_PERMISSION_CONTRACTS;
