/**
 * `agents.list` and `agents.ping` - the Agents surface, and the one button on it.
 *
 * Handshake health is derived from work that already happened (`AgentHealthTracker`, #222):
 * every session a run opened is evidence an agent answered, and every spawn that failed is
 * evidence of the opposite. Nothing polls, so an agent nobody has asked for anything is
 * `unknown` - a real state, and the one the daemon reports for every agent until a run or a
 * `agents.ping` touches it.
 *
 * **Two timestamps, because they answer different questions (#227).** `lastHandshakeAt` is
 * when ORCA last *established* a connection to this agent, which is what `state`,
 * `roundTripMs` and `consecutiveFailures` are all about. `lastSeenAt` is when it last said
 * anything - it moves with the agent's output. A per-run pooled session handshakes once and
 * then talks for an hour, so one timestamp would have to choose between "the connection is
 * an hour old" and "it spoke a second ago", and the card wants to say both.
 *
 * `agents.ping` changes no run state - it spawns the agent, completes the ACP handshake and
 * closes - so a read-only daemon answers it too. What it does change is health, which is why
 * it emits `agent.changed` rather than leaving the caller to re-list.
 */
import { z } from "zod";
import { ClaimViewSchema } from "./claims.js";
import { ViewErrorSchema } from "./views.js";

export const AGENTS_LIST_METHOD = "agents.list";
export const AGENTS_PING_METHOD = "agents.ping";

/**
 * How an agent answered the last time ORCA tried to talk to it. `degraded` means the
 * handshake worked, but only after one failed; there is deliberately no latency rule, so
 * nothing here goes amber for being slow (`AgentHealthTracker` says why).
 */
export const AGENT_HEALTH_STATES = ["unknown", "ok", "degraded", "down"] as const;
export const AgentHealthStateSchema = z.enum(AGENT_HEALTH_STATES);
export type AgentHealthState = z.infer<typeof AgentHealthStateSchema>;

/**
 * How ORCA reaches a host: the two `HostSpec` kinds, restated on the wire so a client can
 * tell "this agent runs here" from "this agent runs over ssh" without reading the config
 * it is not allowed to read (ADR 0008). Every host id groups a card, but only the transport
 * says what a slow handshake or a dead one is likely to mean.
 */
export const AGENT_HOST_TYPES = ["local", "ssh"] as const;
export const AgentHostTypeSchema = z.enum(AGENT_HOST_TYPES);
export type AgentHostType = z.infer<typeof AgentHostTypeSchema>;

/** One configured agent as a card renders it: who it is, where it runs, how it is. */
export const AgentViewSchema = z.object({
  id: z.string(),
  /** The host it is spawned on - `local`, or an ssh host's id. */
  hostId: z.string(),
  /**
   * That host's transport. Absent only when the host is not configured any more - a config
   * edit between a handshake and this read leaves the agent with its health and no host, and
   * an invented `local` there would be a worse answer than none (RULES.md rule 12).
   */
  hostType: AgentHostTypeSchema.optional(),
  /** The roles it fills, in config order; a workflow selects an agent by one of these. */
  roles: z.array(z.string()),
  state: AgentHealthStateSchema,
  /** The last handshake attempt, successful or not. Absent while `unknown`. */
  lastHandshakeAt: z.string().optional(),
  /**
   * The last time this agent said anything at all - a handshake, or a line of output from a
   * session opened long before. Absent until first contact.
   */
  lastSeenAt: z.string().optional(),
  /**
   * Round trip of the last *successful* handshake, in ms. It survives a later failure, so a
   * `down` agent still reports what it cost when it last worked.
   */
  roundTripMs: z.number().int().nonnegative().optional(),
  /** Failed handshakes since the last successful one. Non-zero exactly while `down`. */
  consecutiveFailures: z.number().int().nonnegative(),
  /** Why the last handshake failed. Kept only while `down`. */
  lastError: ViewErrorSchema.optional(),
});
export type AgentView = z.infer<typeof AgentViewSchema>;

/**
 * Agent session slots (#873): the optional caps this daemon is configured with, how many
 * sessions are open against them, and how many steps are queued for one. A cap that is not
 * configured is absent - unlimited is the default - so an empty `agents`/`hosts` record and no
 * `maxAgentSessions` mean "no caps", and the counts are still real. Optional, so an older
 * client ignores it and an older daemon simply never sends it.
 */
export const SessionSlotsViewSchema = z.object({
  limits: z.object({
    maxAgentSessions: z.number().int().positive().optional(),
    /** Agent id -> `agents[].maxSessions`, for agents that set one. */
    agents: z.record(z.string(), z.number().int().positive()),
    /** Host id -> `hosts[].maxSessions`, for hosts that set one. */
    hosts: z.record(z.string(), z.number().int().positive()),
  }),
  inUse: z.object({
    total: z.number().int().nonnegative(),
    /** Agent id -> open sessions; agents with none are left out. */
    agents: z.record(z.string(), z.number().int().nonnegative()),
    /** Host id -> open sessions; hosts with none are left out. */
    hosts: z.record(z.string(), z.number().int().nonnegative()),
  }),
  /** Steps waiting for a slot right now (`step.waiting` on `agent-slot`). */
  queued: z.number().int().nonnegative(),
});
export type SessionSlotsView = z.infer<typeof SessionSlotsViewSchema>;

/**
 * The daemon-wide part of `SessionSlotsView`, for `hello`: the one cap, the open total and the
 * queue depth. Per-agent and per-host detail names configured agents and hosts, so it stays on
 * `agents.list`, behind the same read authority as the rest of that surface.
 */
export const SessionSlotsSummarySchema = z.object({
  maxAgentSessions: z.number().int().positive().optional(),
  inUse: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
});
export type SessionSlotsSummary = z.infer<typeof SessionSlotsSummarySchema>;

export const AgentsListParamsSchema = z.object({});
export type AgentsListParams = z.infer<typeof AgentsListParamsSchema>;

export const AgentsListResultSchema = z.object({
  /** Every *configured* agent, in config order - never only the ones that have been contacted. */
  agents: z.array(AgentViewSchema),
  /**
   * What is being worked right now, exactly as `claims.list` projects it. It travels with
   * the agent list because the Agents surface's second question, after "is it up", is "and
   * what is it on" - and a claim is the only record of that which outlives a step.
   */
  claims: z.array(ClaimViewSchema),
  /** Session caps, use and queue depth (#873). Optional; absent from an older daemon. */
  sessionSlots: SessionSlotsViewSchema.optional(),
  asOf: z.string(),
});
export type AgentsListResult = z.infer<typeof AgentsListResultSchema>;

export const AgentsPingParamsSchema = z.object({
  agentId: z.string().min(1),
  /**
   * Where to spawn it. Defaults to the host's `workspaceRoot`, else the daemon's own working
   * directory on a local host - a handshake does no work, so the directory only has to exist.
   */
  cwd: z.string().min(1).optional(),
});
export type AgentsPingParams = z.infer<typeof AgentsPingParamsSchema>;

export const AgentsPingResultSchema = z.object({
  /** The agent as it now reads - the same shape `agents.list` returns, post-handshake. */
  agent: AgentViewSchema,
  /** Whether the handshake completed. A failed ping is a recorded result, not an error. */
  ok: z.boolean(),
  /** This handshake's round trip, when it succeeded. */
  roundTripMs: z.number().int().nonnegative().optional(),
  /** Why it failed, when it did. The same error is on `agent.lastError`. */
  error: ViewErrorSchema.optional(),
  asOf: z.string(),
});
export type AgentsPingResult = z.infer<typeof AgentsPingResultSchema>;
