/**
 * `hello` - the first exchange on every connection. The client says who it is and which
 * protocol it speaks; the daemon answers with its own version, the ORCA version it runs,
 * where its store lives and which capabilities it offers, so a client can degrade
 * (read-only, no subscriptions, …) instead of failing on the first real call.
 */
import { z } from "zod";
import { ProtocolVersionSchema } from "./version.js";
import { CLAIMS_LIST_METHOD } from "./claims.js";
import { INPUTS_LIST_METHOD } from "./inputs.js";
import { RUNS_EVENTS_METHOD, RUNS_GET_METHOD, RUNS_LIST_METHOD } from "./runs.js";
import { SUBSCRIBE_METHOD, UNSUBSCRIBE_METHOD } from "./subscriptions.js";

export const HELLO_METHOD = "hello";

/**
 * The methods behind the `runs.read` capability. A capability says a daemon has a class of
 * functionality; `HelloResult.methods` says exactly which calls it answers, so a newer
 * client can light up one screen against an older daemon instead of the whole surface or
 * none of it.
 */
export const READ_METHODS = [
  RUNS_LIST_METHOD,
  RUNS_GET_METHOD,
  RUNS_EVENTS_METHOD,
  INPUTS_LIST_METHOD,
  CLAIMS_LIST_METHOD,
] as const;

/**
 * The methods behind the `runs.subscribe` capability. They are answered on the WebSocket
 * endpoint only - `/rpc` has nowhere to push a notification to - so a daemon lists them in
 * `HelloResult.methods` whether the handshake arrived over HTTP or over the socket, and a
 * client that wants them opens a socket.
 */
export const SUBSCRIPTION_METHODS = [SUBSCRIBE_METHOD, UNSUBSCRIBE_METHOD] as const;

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
  /** Every method this daemon answers, `hello` included. Added in protocol 1.1; absent from an older daemon. */
  methods: z.array(z.string()).optional(),
});
export type HelloResult = z.infer<typeof HelloResultSchema>;
