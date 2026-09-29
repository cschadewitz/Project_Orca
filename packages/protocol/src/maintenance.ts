/** Admission only: never installs software or accepts paths/commands over the wire. */
import { z } from "zod";
export const MaintenanceParamsSchema = z.object({ action: z.enum(["prepare", "resume"]), token: z.string().min(1) });
export const MaintenanceResultSchema = z.object({ ready: z.boolean(), active: z.array(z.string()) });
export type MaintenanceParams = z.infer<typeof MaintenanceParamsSchema>;
export type MaintenanceResult = z.infer<typeof MaintenanceResultSchema>;
