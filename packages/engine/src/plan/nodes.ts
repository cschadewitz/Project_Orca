/** Builtin plan-node fields. Policy overrides deliberately do not acquire plan defaults. */
import { PriorityWeightsSchema, SchedulingPolicySchema } from "@orca/core";
import { z } from "zod";

const weights = PriorityWeightsSchema.shape;
const policy = SchedulingPolicySchema.shape;
const PolicyOverridesSchema = z
  .object({
    strategy: policy.strategy.unwrap().optional(),
    weights: z
      .object({
        criticalPath: weights.criticalPath.unwrap().optional(),
        dependents: weights.dependents.unwrap().optional(),
        risk: weights.risk.unwrap().optional(),
        mitigation: weights.mitigation.unwrap().optional(),
        priority: weights.priority.unwrap().optional(),
        age: weights.age.unwrap().optional(),
      })
      .optional(),
    concurrency: policy.concurrency.unwrap().optional(),
    riskAppetite: policy.riskAppetite.unwrap().optional(),
    holdAboveAppetite: policy.holdAboveAppetite.unwrap().optional(),
    mitigateFirst: policy.mitigateFirst.unwrap().optional(),
    orderSoftDependencies: policy.orderSoftDependencies.unwrap().optional(),
  })
  .transform((value) => ({
    // An explicitly undefined override must not erase the plan's existing value.
    ...(value.strategy !== undefined ? { strategy: value.strategy } : {}),
    ...(value.weights !== undefined ? { weights: value.weights } : {}),
    ...(value.concurrency !== undefined ? { concurrency: value.concurrency } : {}),
    ...(value.riskAppetite !== undefined ? { riskAppetite: value.riskAppetite } : {}),
    ...(value.holdAboveAppetite !== undefined ? { holdAboveAppetite: value.holdAboveAppetite } : {}),
    ...(value.mitigateFirst !== undefined ? { mitigateFirst: value.mitigateFirst } : {}),
    ...(value.orderSoftDependencies !== undefined ? { orderSoftDependencies: value.orderSoftDependencies } : {}),
  }));

// Common node fields and extension metadata are checked by the core workflow schema.
// These schemas only parse the fields consumed by these executors.
export const PlanRegisterNodeSchema = z.object({
  type: z.literal("custom:plan-register"),
  artifact: z.string().min(1).default("decomposition"),
  plan: z.string().optional(),
  planName: z.string().optional(),
});

export const DecisionMatrixNodeSchema = z.object({
  type: z.literal("custom:decision-matrix"),
  artifact: z.string().min(1).default("decisionMatrix"),
  decision: z.string().optional(),
});

export const PlanScheduleNodeSchema = z.object({
  type: z.literal("custom:plan-schedule"),
  plan: z.string().optional(),
  artifactPath: z.string().default(".orca/plans/{{ vars.plan }}/schedule.md"),
  policy: PolicyOverridesSchema.optional(),
  record: z.boolean().default(true),
});

export const PlanDispatchNodeSchema = z.object({
  type: z.literal("custom:plan-dispatch"),
  workflow: z.string().min(1).optional(),
  concurrency: z.number().int().positive().optional(),
  scope: z.enum(["request", "plan"]).default("request"),
  leavesOnly: z.boolean().default(true),
  failFast: z.boolean().default(false),
  onWaiting: z.enum(["defer", "wait"]).default("defer"),
  pollMs: z.number().int().positive().default(5_000),
  waitTimeoutMs: z
    .number()
    .int()
    .nonnegative()
    .default(30 * 60_000),
  policy: PolicyOverridesSchema.optional(),
});

export const PlanAwaitNodeSchema = z.object({
  type: z.literal("custom:plan-await"),
  phase: z.string().min(1).default("build"),
  pollMs: z.number().int().positive().default(2_000),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60_000),
});
