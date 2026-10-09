/** Main-only validation of protected submitted commands; never resolves workflow defaults/secrets. */
import { z } from "zod";
import { OperatorPreflightResultSchema, RequestsSubmitParamsSchema, RunsAdmitParamsSchema } from "@orca/protocol";
import type { LaunchReview } from "../configuration-launch-contract.js";

const target = z.strictObject({ workspaceId: z.uuid(), instanceId: z.uuid(), epoch: z.number().int().nonnegative() });
const evidence = {
  target,
  configGeneration: z.string().min(1),
  evidenceId: z.string().min(1),
  repository: z.string().min(1),
  baseCommit: z.string().min(1),
  asOf: z.string().min(1),
};
const checkout = z.union([
  z.strictObject({ state: z.literal("unavailable"), reason: z.string() }),
  z.strictObject({
    ...evidence,
    state: z.literal("verified"),
    profile: z.literal("prepared-local"),
    cwd: z.string().min(1),
    branch: z.string().min(1),
  }),
  z.strictObject({
    ...evidence,
    state: z.literal("verified"),
    profile: z.literal("owned-local-linux-source"),
    commonDirectory: z.string().min(1),
    worktreeRoot: z.string().min(1),
    branchPrefix: z.string().min(1),
    hostId: z.string().min(1),
  }),
]);
const reviewSchema = z.strictObject({
  target,
  draftSequence: z.number().int().nonnegative(),
  command: z.discriminatedUnion("mode", [
    z.strictObject({
      mode: z.literal("direct"),
      params: RunsAdmitParamsSchema.omit({ idempotencyKey: true, expectedScope: true }),
    }),
    z.strictObject({ mode: z.literal("request"), params: RequestsSubmitParamsSchema.omit({ idempotencyKey: true }) }),
  ]),
  workflowId: z.string().min(1),
  workflowVersion: z.string().min(1),
  expectedWorkflowRevision: z.string().min(1),
  expectedConfigGeneration: z.string().min(1),
  checkout,
  selectionProvenance: OperatorPreflightResultSchema.pick({
    selections: true,
    itemWorkflow: true,
    templatePack: true,
  }).optional(),
});

/** JSON-only, finite, bounded user input; reject before JSON can silently drop a value. */
export function canonicalGuidedValue(value: unknown): string {
  let count = 0;
  function visit(v: unknown, depth: number): unknown {
    if (++count > 10000 || depth > 64) throw new Error("Submitted command exceeds protected storage limits.");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map((item) => visit(item, depth + 1));
    if (
      typeof v === "object" &&
      v &&
      (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
    ) {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((key) => {
            if (["__proto__", "prototype", "constructor"].includes(key))
              throw new Error("Invalid submitted command key.");
            return [key, visit((v as Record<string, unknown>)[key], depth + 1)];
          }),
      );
    }
    throw new Error("Submitted command must contain explicit JSON values.");
  }
  const text = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(text, "utf8") > 65536) throw new Error("Submitted command exceeds protected storage limits.");
  return text;
}
export function parseGuidedReview(raw: unknown): LaunchReview {
  canonicalGuidedValue(raw);
  const review = reviewSchema.parse(raw);
  const params = review.command.params;
  if (
    params.workflowId !== review.workflowId ||
    params.workflowVersion !== review.workflowVersion ||
    params.expectedWorkflowRevision !== review.expectedWorkflowRevision ||
    params.expectedConfigGeneration !== review.expectedConfigGeneration
  )
    throw new Error("Submitted command differs from its reviewed guards.");
  if (
    review.checkout.state === "verified" &&
    (review.checkout.target.workspaceId !== review.target.workspaceId ||
      review.checkout.target.instanceId !== review.target.instanceId ||
      review.checkout.target.epoch !== review.target.epoch ||
      review.checkout.configGeneration !== review.expectedConfigGeneration)
  )
    throw new Error("Checkout evidence differs from its reviewed target.");
  return review;
}
