/**
 * `hello` - the first exchange on every connection. The client says who it is and which
 * protocol it speaks; the daemon answers with its own version, the ORCA version it runs,
 * where its store lives and which capabilities it offers, so a client can degrade
 * (read-only, no subscriptions, …) instead of failing on the first real call.
 */
import { z } from "zod";
import { ProtocolVersionSchema } from "./version.js";

export const HELLO_METHOD = "hello";

export const HelloParamsSchema = z.object({
  /** Client identity for logs and the daemon's session list, e.g. `orca-app/0.3.1`. */
  client: z.string().min(1),
  protocol: ProtocolVersionSchema,
});
export type HelloParams = z.infer<typeof HelloParamsSchema>;

/** What a daemon can do; a client checks these rather than the ORCA version. */
export const DAEMON_CAPABILITIES = ["runs.read", "runs.subscribe", "runs.control", "plan.read", "plan.write"] as const;
export const DaemonCapabilitySchema = z.enum(DAEMON_CAPABILITIES);
export type DaemonCapability = z.infer<typeof DaemonCapabilitySchema>;

export const HelloResultSchema = z.object({
  protocol: ProtocolVersionSchema,
  orcaVersion: z.string(),
  /** Absolute path of the `.orca` store the daemon serves, for a client that also reads files. */
  storeDir: z.string().optional(),
  capabilities: z.array(DaemonCapabilitySchema),
});
export type HelloResult = z.infer<typeof HelloResultSchema>;
