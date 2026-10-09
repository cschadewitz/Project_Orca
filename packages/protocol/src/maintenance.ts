/** Admission only: never installs software or accepts paths/commands over the wire. */
import { z } from "zod";
export const MaintenanceParamsSchema = z.object({ action: z.enum(["prepare", "resume"]), token: z.string().min(1) });
export const MaintenanceResultSchema = z.object({ ready: z.boolean(), active: z.array(z.string()) });
export type MaintenanceParams = z.infer<typeof MaintenanceParamsSchema>;
export type MaintenanceResult = z.infer<typeof MaintenanceResultSchema>;

/** Additive owner-only proof method; legacy maintenance never implies runtime idle. */
export const MAINTENANCE_RUNTIME_METHOD = "maintenance.runtime";
export const RuntimeActivityReasonSchema = z.enum([
  "rpc",
  "execution",
  "callback",
  "renewal",
  "dispatch",
  "continuation",
  "recovery",
  "unavailable",
]);
export type RuntimeActivityReason = z.infer<typeof RuntimeActivityReasonSchema>;
export const RuntimeMaintenanceTargetSchema = z
  .object({ workspaceId: z.uuid(), instanceId: z.uuid(), processId: z.number().int().positive() })
  .strict();
export const RuntimeMaintenanceParamsSchema = MaintenanceParamsSchema.extend({
  target: RuntimeMaintenanceTargetSchema,
}).strict();
export const RuntimeMaintenanceResultSchema = z
  .object({
    proof: z.literal("runtime-v1"),
    target: RuntimeMaintenanceTargetSchema,
    outcome: z.enum(["held", "blocked", "released"]),
    active: z.array(RuntimeActivityReasonSchema),
  })
  .strict()
  .refine((value) => value.outcome === "blocked" || value.active.length === 0, "Held/released proof must be idle");
export type RuntimeMaintenanceParams = z.infer<typeof RuntimeMaintenanceParamsSchema>;
export type RuntimeMaintenanceResult = z.infer<typeof RuntimeMaintenanceResultSchema>;

/** Drain is distinct from idle proof: existing work may still need answers or continuation. */
export const RuntimeDrainParamsSchema = RuntimeMaintenanceParamsSchema.extend({
  action: z.enum(["drain", "defer"]),
});
export const RuntimeMaintenanceRequestSchema = z.union([RuntimeMaintenanceParamsSchema, RuntimeDrainParamsSchema]);
export const RuntimeDrainResultSchema = z
  .object({
    proof: z.literal("runtime-drain-v1"),
    target: RuntimeMaintenanceTargetSchema,
    outcome: z.enum(["draining", "held", "blocked", "released"]),
    active: z.array(RuntimeActivityReasonSchema),
    unfinished: z
      .array(
        z
          .object({
            status: z.enum(["created", "running", "waiting", "paused"]),
            count: z.number().int().positive().max(4096),
          })
          .strict(),
      )
      .max(4),
    truncated: z.boolean(),
  })
  .strict()
  .refine(
    (value) => value.outcome !== "held" || (!value.active.length && !value.unfinished.length && !value.truncated),
    "Held drain proof must be quiescent",
  );
export type RuntimeDrainParams = z.infer<typeof RuntimeDrainParamsSchema>;
export type RuntimeDrainResult = z.infer<typeof RuntimeDrainResultSchema>;
