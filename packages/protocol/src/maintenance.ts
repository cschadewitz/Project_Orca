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
