/** Fixed, non-secret preparation policy. No caller-controlled routes or ambient configuration. */
import { createHash } from "node:crypto";

export const LIMITS = Object.freeze({
  requestBytes: 4096,
  wireBufferBytes: 8192,
  responseBytes: 32768,
  sourceBytes: 16384,
  sourceRecords: 64,
  logEntries: 50,
  defaultLogEntries: 20,
  logWindowSeconds: 900,
  concurrentReads: 2,
  deadlineMs: 1000,
  staleAfterMs: 30000,
  auditEntries: 128,
});
export const SERVICES = ["orca-daemon", "orca-tunnel", "maintenance-bridge", "maintenance-tunnel"] as const;
export const CATEGORIES = ["lifecycle", "readiness", "resource"] as const;
export const OPERATIONS = [
  "maintenance_discover",
  "get_host_health",
  "get_service_health",
  "get_service_logs",
] as const;
export type ServiceAlias = (typeof SERVICES)[number];
export type Operation = (typeof OPERATIONS)[number];
export const POLICY = Object.freeze({
  version: "maintenance-readonly-v2",
  host: "agent-01",
  mounts: ["root"] as const,
  // Names are proposals, not an asserted match to a running unit or bus owner.
  services: SERVICES.map((alias) =>
    Object.freeze({
      alias,
      proposedManager: "user" as const,
      proposedUnit: `${alias}.service`,
      configuredManager: null as "user" | null,
      configuredUid: null as number | null,
      configuredUnit: null as string | null,
    }),
  ),
  categories: CATEGORIES,
  operations: OPERATIONS,
  limits: LIMITS,
  observerPreparation: {
    hostSources: ["linux-proc-boot", "linux-proc-uptime", "linux-proc-memory", "linux-root-statfs"],
    serviceSource: "same-user-systemctl-show",
    logSource: "same-user-structured-journal",
    serviceIdentitiesConfigured: false,
    deploymentHostBinding: "unverified",
  },
});
export const POLICY_ID = createHash("sha256").update(JSON.stringify(POLICY)).digest("hex");
export const BUILD = Object.freeze({
  package: "@orca/maintenance-mcp",
  version: "0.1.0",
  sourceBaseRevision: "db579fb7ac9cfce2e4e6901713088a80602311da",
  deployedRevision: null,
  attestation: "unattested-preparation" as const,
});
