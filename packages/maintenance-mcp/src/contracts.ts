/** Closed tool inputs and allowlisted observation fields; no arbitrary text survives projection. */
import { z } from "zod";
import { CATEGORIES, LIMITS, SERVICES } from "./policy.js";

const host = z.literal("agent-01");
const service = z.enum(SERVICES);
export const INPUTS = {
  maintenance_discover: z.strictObject({}),
  get_host_health: z.strictObject({ host }),
  get_service_health: z.strictObject({ host, service }),
  get_service_logs: z.strictObject({
    host,
    service,
    category: z.enum(CATEGORIES).optional(),
    limit: z.number().int().min(1).max(LIMITS.logEntries).default(LIMITS.defaultLogEntries),
  }),
};
export const Timestamp = z.iso.datetime({ precision: 3 });
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const HostObservation = z
  .strictObject({
    observedAt: Timestamp,
    bootId: z.uuid(),
    uptimeSeconds: count,
    memoryTotalBytes: count,
    memoryAvailableBytes: count,
    rootTotalBytes: count,
    rootAvailableBytes: count,
  })
  .refine((v) => v.memoryAvailableBytes <= v.memoryTotalBytes && v.rootAvailableBytes <= v.rootTotalBytes);
export const ServiceObservation = z.strictObject({
  observedAt: Timestamp,
  state: z.enum(["active", "inactive", "failed"]),
});
// Strip unknown fields rather than copy them. All surviving values are enums, numbers or timestamps.
export const LogRecord = z.discriminatedUnion("category", [
  z.object({
    observedAt: Timestamp,
    category: z.literal("lifecycle"),
    state: z.enum(["started", "stopped", "failed"]),
  }),
  z.object({ observedAt: Timestamp, category: z.literal("readiness"), ready: z.boolean() }),
  z.object({
    observedAt: Timestamp,
    category: z.literal("resource"),
    resource: z.enum(["memory", "root"]),
    usedPercent: z.number().min(0).max(100),
  }),
]);
export const LogBatch = z.strictObject({
  observedAt: Timestamp,
  records: z.array(z.unknown()).max(LIMITS.sourceRecords),
  truncated: z.boolean(),
});
export type SafeLogRecord = z.infer<typeof LogRecord>;
export type LogsInput = z.infer<typeof INPUTS.get_service_logs>;
