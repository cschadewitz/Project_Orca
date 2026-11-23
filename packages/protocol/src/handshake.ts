/**
 * `hello` - the first exchange on every connection. The client says who it is and which
 * protocol it speaks; the daemon answers with its own version, the ORCA version it runs,
 * where its store lives and which capabilities it offers, so a client can degrade
 * (read-only, no subscriptions, …) instead of failing on the first real call.
 */
import { z } from "zod";
import { OPERATOR_METHODS } from "./operator-reads.js";
import { ProtocolVersionSchema } from "./version.js";
import { AGENTS_LIST_METHOD, AGENTS_PING_METHOD, SessionSlotsSummarySchema } from "./agents.js";
import { ARTIFACTS_GET_METHOD, ARTIFACTS_LIST_METHOD } from "./artifacts.js";
import { CLAIMS_LIST_METHOD, CLAIMS_RELEASE_METHOD } from "./claims.js";
import { CONFIG_GET_METHOD, CONFIG_SET_METHOD, CONFIG_APPLY_METHOD } from "./config.js";
import { INPUTS_ANSWER_METHOD, RUNS_CANCEL_METHOD, RUNS_RESUME_METHOD, RUNS_START_METHOD } from "./control.js";
import { RUNS_RECOVERY_METHOD, RUNS_REVIEW_EFFECT_METHOD } from "./recovery.js";
import { RUNS_DRY_RUN_REPORT_METHOD } from "./dry-run.js";
import { INPUTS_LIST_METHOD } from "./inputs.js";
import {
  DECISIONS_DECIDE_METHOD,
  DECISIONS_REOPEN_METHOD,
  DEPENDENCIES_WAIVE_METHOD,
  RISKS_UPDATE_METHOD,
} from "./plan-control.js";
import {
  DECISIONS_LIST_METHOD,
  DEPENDENCIES_LIST_METHOD,
  ITEMS_LIST_METHOD,
  JOURNAL_LIST_METHOD,
  PLANS_LIST_METHOD,
  PLAN_GET_METHOD,
  RISKS_LIST_METHOD,
  SCHEDULE_EXPLAIN_METHOD,
  SCHEDULE_GET_METHOD,
} from "./plan.js";
import { RUNS_EVENTS_METHOD, RUNS_GET_METHOD, RUNS_LIST_METHOD } from "./runs.js";
import { SUBSCRIBE_METHOD, UNSUBSCRIBE_METHOD } from "./subscriptions.js";
import { WORKFLOWS_GET_METHOD, WORKFLOWS_LIST_METHOD } from "./workflows.js";
import { SEARCH_METHOD } from "./search.js";

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
  ARTIFACTS_LIST_METHOD,
  ARTIFACTS_GET_METHOD,
  // Protocol 1.7 (#174): the workflow viewer's two reads. They touch no run, no lease and
  // no log - a workflow is a file the daemon already has parsed - so a `--read-only` daemon
  // answers them like any other read.
  WORKFLOWS_LIST_METHOD,
  WORKFLOWS_GET_METHOD,
  /**
   * `config.get` reads two files and mints nothing, so it sits under `runs.read` alongside
   * the rest and a `--read-only` daemon answers it (#174, #266). No new capability: a
   * capability names a class of functionality, and "reading what this daemon is configured
   * with" is not a different class from reading what it has run.
   */
  CONFIG_GET_METHOD,
  /**
   * `search` (protocol 2.2, #255): a bounded substring scan over the same events and
   * artifacts the reads above return, answered under `runs.read` like them.
   */
  SEARCH_METHOD,
  /**
   * `runs.recovery` (protocol 2.5, #357): how a run could be recovered, read from its log and
   * the store. It writes nothing, so a `--read-only` daemon answers it like the reads above.
   */
  RUNS_RECOVERY_METHOD,
  /** `runs.dryRunReport` (protocol 2.8, #183): what a dry run did, read from its tree's logs. */
  RUNS_DRY_RUN_REPORT_METHOD,
] as const;

/**
 * The plan reads, behind the `plan.read` capability. They are listed apart from
 * `READ_METHODS` for the same reason the agent methods are: a daemon serving a store with no
 * plan in it still answers them (`plans.list` returns nothing), but a client that wants to
 * know whether this daemon speaks the plan surface at all asks the handshake once rather
 * than nine times.
 */
export const PLAN_READ_METHODS = [
  PLANS_LIST_METHOD,
  PLAN_GET_METHOD,
  ITEMS_LIST_METHOD,
  SCHEDULE_GET_METHOD,
  SCHEDULE_EXPLAIN_METHOD,
  DEPENDENCIES_LIST_METHOD,
  RISKS_LIST_METHOD,
  DECISIONS_LIST_METHOD,
  JOURNAL_LIST_METHOD,
] as const;

/**
 * The methods behind the `runs.control` capability - the ones that write.
 *
 * `orca serve --read-only` leaves every one of them out of the dispatch table *and* out of
 * `HelloResult.methods`, and drops `runs.control` from `capabilities`. That is the whole of
 * the difference: a read-only daemon answers "unknown method", it does not answer a control
 * call and then refuse it, because a client should be able to hide a button rather than
 * discover at the moment of pressing it that there is nothing behind it.
 *
 * `config.set` joins them (#174). It writes no run and takes no lease, but it writes a file
 * this daemon is serving, and "read-only" that edited the configuration would be a read-only
 * daemon in name only. It reuses `runs.control` rather than minting a capability of its own,
 * for the same reason `config.get` reuses `runs.read`.
 *
 * The four plan writes and `claims.release` joined them in protocol 1.7 too (#169, #88). They
 * are one list rather than two because `--read-only` is one switch: a daemon that will not
 * drive a run will not waive a dependency either, and a client that asked two questions to
 * draw one disabled state would eventually get a different answer to each.
 */
export const CONTROL_METHODS = [
  "requests.submit",
  "requests.reconcile",
  // Admission inspection requires the same authenticated control service as submission.
  "requests.admission",
  "requests.admissions",
  CONFIG_APPLY_METHOD,
  INPUTS_ANSWER_METHOD,
  RUNS_RESUME_METHOD,
  RUNS_CANCEL_METHOD,
  RUNS_START_METHOD,
  // Protocol 2.5 (#357): appends a review to a run's log under its lease.
  RUNS_REVIEW_EFFECT_METHOD,
  CONFIG_SET_METHOD,
  DEPENDENCIES_WAIVE_METHOD,
  DECISIONS_DECIDE_METHOD,
  DECISIONS_REOPEN_METHOD,
  RISKS_UPDATE_METHOD,
  CLAIMS_RELEASE_METHOD,
] as const;

/**
 * The agent methods. They sit under `runs.read` rather than `runs.control`, and a read-only
 * daemon answers both: `agents.list` is a projection of in-memory health, and `agents.ping`
 * spawns an agent, shakes hands and closes without touching a run, a lease or a log. It is
 * listed here rather than in `READ_METHODS` only because a daemon needs a configured
 * registry to answer them and may have a store without one.
 */
export const AGENT_METHODS = [AGENTS_LIST_METHOD, AGENTS_PING_METHOD] as const;

/**
 * The methods behind the `runs.subscribe` capability. They are answered on the WebSocket
 * endpoint only - `/rpc` has nowhere to push a notification to - so a daemon lists them in
 * `HelloResult.methods` whether the handshake arrived over HTTP or over the socket, and a
 * client that wants them opens a socket.
 */
export const SUBSCRIPTION_METHODS = [SUBSCRIBE_METHOD, UNSUBSCRIBE_METHOD] as const;

export const HelloParamsSchema = z
  .object({
    /** Client identity for logs and the daemon's session list, e.g. `orca-app/0.3.1`. */
    client: z.string().min(1),
    protocol: ProtocolVersionSchema,
    /**
     * The previous-major version this client can also speak, sent only while its build has a
     * compatibility window open (protocol 2.1, #880). A daemon that does not speak `protocol`
     * answers in this one instead, and says so in `HelloResult.protocol`.
     */
    fallback: ProtocolVersionSchema.optional(),
  })
  .refine((p) => p.fallback === undefined || p.fallback.major === p.protocol.major - 1, {
    /* A fallback is the previous major and nothing else: a same-major or skipped-major pair
     is a malformed offer, refused as such before any version is matched. */
    message: "hello fallback must be exactly one major below protocol",
    path: ["fallback"],
  });
export type HelloParams = z.infer<typeof HelloParamsSchema>;

/** What a daemon can do; a client checks these rather than the ORCA version. */
export const DAEMON_CAPABILITIES = [
  ...OPERATOR_METHODS,
  "operator.submitRequest",
  "operator.admitRun",
  "operator.admission",
  "operator.reconcileAdmission",
  "operator.cancel",
  "operator.answer",
  "operator.continueRun",
  "operator.continuation",
  "operator.reconcileContinuation",
  "operator.revise",
  "inputs.live",
  "inputs.revise",
  "inputs.revisionPending",
  "inputs.replaceRevision",
  "runs.read",
  "runs.subscribe",
  "runs.admit",
  "admissions.get",
  "admissions.reconcile",
  "runs.continue",
  "continuations.get",
  "continuations.reconcile",
  "runs.control",
  "plan.read",
  "plan.write",
  "workflows.validateInputs",
] as const;
export const DaemonCapabilitySchema = z.enum(DAEMON_CAPABILITIES);
export type DaemonCapability = z.infer<typeof DaemonCapabilitySchema>;

/**
 * An absolute POSIX path on the daemon's machine that is safe to put, single-quoted, in a
 * remote shell command: no `..` segment, no quote, whitespace, glob or other shell character.
 * The managed updater's own paths (`/srv/dev/orca-live/...`) fit; anything else is not offered.
 */
export const ServerPathSchema = z
  .string()
  .max(512)
  .regex(/^\/[A-Za-z0-9._/-]+$/, "an absolute path of letters, digits and . _ / -")
  .refine((path) => !path.split("/").includes(".."), "no '..' segment");

/** A server ring, as the update feed names it (docs/UPDATING.md "Rings and controlled rollouts"). */
export const ServerRingSchema = z.enum(["internal", "preview", "stable"]);
export type ServerRing = z.infer<typeof ServerRingSchema>;

/**
 * How this daemon was installed, when the managed server updater (`orca-release.py`, Debian)
 * launched it (#879). The app updates such a server by running that updater over the
 * person's own SSH connection, never through the daemon: these are the two paths to run it
 * with, and the ring it follows when its deployment names one. Absent for every other daemon
 * (a desktop's bundled daemon, a source checkout, `orca serve` by hand), which the app then
 * explains it cannot update.
 */
export const ManagedDeploymentSchema = z.object({
  kind: z.literal("managed"),
  /** The updater script: `orca-release.py`, outside the replaceable releases. */
  adapter: ServerPathSchema,
  /** The deployment manifest it takes as `--deployment`. */
  manifest: ServerPathSchema,
  ring: ServerRingSchema.optional(),
});
export type ManagedDeployment = z.infer<typeof ManagedDeploymentSchema>;

/**
 * The store a daemon serves (#339, protocol 2.7): its metadata backend, and whether this daemon
 * could switch it to SQLite in place on a launch the desktop app asks for. That is only ever the
 * case for the app's own workspace, under its writer fence, and never on Windows (#947).
 */
export const StoreStatusSchema = z.object({
  backend: z.enum(["file", "sqlite"]),
  sqliteSwitch: z.enum(["available", "unavailable"]),
  /**
   * Whether this daemon could switch its store back from SQLite to files in place, on the same
   * terms (#339). Optional: a daemon from before the switch back sends none, which means
   * unavailable. Only the app's own bundled daemon is ever asked, so no version gates it.
   */
  filesSwitch: z.enum(["available", "unavailable"]).optional(),
  /** How the switch the app asked for on this daemon's launch ended. */
  lastSwitch: z
    .object({
      /** Which way it was asked for; absent means to SQLite (a daemon from before the switch back). */
      to: z.enum(["sqlite", "files"]).optional(),
      status: z.enum(["switched", "current", "refused"]),
      reason: z.string().max(64).optional(),
      message: z.string().max(4096).optional(),
    })
    .optional(),
});
export type StoreStatus = z.infer<typeof StoreStatusSchema>;

export const HelloResultSchema = z.object({
  identity: z.object({ workspaceId: z.uuid(), instanceId: z.uuid() }).optional(),
  protocol: ProtocolVersionSchema,
  orcaVersion: z.string(),
  /** Local supervisors bind health/admission to the process they actually own. Protocol 1.8. */
  processId: z.number().int().positive().optional(),
  /** Absolute path of the `.orca` store the daemon serves, for a client that also reads files. */
  storeDir: z.string().optional(),
  capabilities: z.array(DaemonCapabilitySchema),
  /** Every method this daemon answers, `hello` included. Added in protocol 1.1; absent from an older daemon. */
  methods: z.array(z.string()).optional(),
  /**
   * Agent session slots at the moment of the handshake (#873): the daemon-wide cap when one is
   * configured, sessions open and steps queued. Present when the daemon serves the agent
   * surface; `agents.list` carries the per-agent and per-host detail. Optional.
   */
  sessionSlots: SessionSlotsSummarySchema.optional(),
  /**
   * The managed server updater that launched this daemon (#879), for a caller holding
   * `config.read`. Absent for any other daemon. Protocol 2.2.
   */
  deployment: ManagedDeploymentSchema.optional(),
  /**
   * The optional `runs.admit` fields this daemon takes and records (#883), named explicitly
   * because `runs.admit` params are strict: a caller sends such a field only to a daemon that
   * lists it here, never on the strength of a protocol minor alone. Protocol 2.6: `origin`.
   */
  admitFields: z.array(z.string()).optional(),
  /** The store this daemon serves and whether the app may switch it to SQLite (#339). Protocol 2.7. */
  store: StoreStatusSchema.optional(),
});
export type HelloResult = z.infer<typeof HelloResultSchema>;
