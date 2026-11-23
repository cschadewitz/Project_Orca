/**
 * AgentSession - one ACP session with one agent process, from ORCA's point of
 * view. The engine talks to this interface only; the ACP details live in
 * acp-session.ts so alternative transports (T3 Code threads, HTTP ACP) can
 * implement the same contract.
 */
import type * as acp from "@agentclientprotocol/sdk";
import { toolCallBody, type AgentUpdateSummary, type SessionConfigOption, type ToolCallBody } from "@orca/core";
import { describeConfigOptions } from "./config-options.js";

export interface TurnResult {
  stopReason: acp.StopReason;
  durationMs: number;
}

export interface SessionUpdateEvent {
  sessionId: string;
  raw: acp.SessionUpdate;
  summary: AgentUpdateSummary;
  at: number;
}

export interface PromptOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * The workflow step this turn is for. An ACP session ignores it. A session that delegates the
   * turn to another daemon (#883) keys its remote admission on it, so a retried call for the
   * same turn never starts a second remote run, and records it as the remote run's origin.
   */
  turn?: TurnContext;
}

/** What a step tells its session about the turn (see `PromptOptions.turn`). */
export interface TurnContext {
  runId: string;
  stepRunId: string;
  /**
   * The step run of this visit's first attempt: the same for every retry of the step, so a
   * delegating session (#883) can tell a retry from new work.
   */
  delegationId: string;
  nodeId: string;
  attempt: number;
  /** 0 for the step's first turn; a follow-up asks again for deliverables that were missing. */
  followUp: number;
  /** The step's task as its prompt template rendered it, without ORCA's deliverable instructions. */
  task: string;
  /**
   * The task or prompt holds a value the run keeps protected: a sensitive launch input or a
   * secret value read for the run (#363). A session that hands the task to another daemon
   * must have it protected there too, or not send it.
   */
  sensitive?: boolean;
  /**
   * The protected values that occur in `task`, exactly as the run's redaction matches them
   * (#363). Present only with `sensitive`. A delegating session hands them to the worker on its
   * authenticated admission so the worker redacts each value on its own, not only the whole
   * task. Held in memory for the turn: never logged, stored or shown.
   */
  protectedValues?: readonly string[];
  /** Where the step collects its outputs once the turn ends: absolute paths on the agent's host. */
  deliverables: readonly TurnDeliverable[];
}

export interface TurnDeliverable {
  kind: string;
  name?: string;
  path: string;
  required: boolean;
}

export interface AgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly hostId: string;
  readonly cwd: string;
  readonly acpSessionId: string;
  readonly closed: Promise<void>;
  /**
   * Resolves once the agent process this session owns is confirmed gone, which can be later
   * than `closed` (the connection) and later than a `close()` whose cleanup could not observe
   * the exit. Session caps (#873) return a slot on this, so a queued open never starts beside
   * a process that is still alive. Rejects when the exit cannot be observed at all, which is
   * not evidence it is gone. Optional: a transport without an owned process omits it,
   * and then `close()` settling stands in for it.
   */
  readonly terminated?: Promise<void>;
  /**
   * What the agent said at `initialize` it accepts in a prompt beyond text. `embeddedContext`
   * is ACP's `promptCapabilities.embeddedContext`: whether a prompt may carry `resource`
   * blocks with their content inline, which is how skills reach a session (#337). Absent for a
   * transport that does not report it, which is treated as not accepted.
   */
  readonly promptCapabilities?: { readonly embeddedContext: boolean };
  prompt(input: string | acp.ContentBlock[], options?: PromptOptions): Promise<TurnResult>;
  onUpdate(listener: (e: SessionUpdateEvent) => void): () => void;
  /**
   * The config options the agent advertises (model, mode, …), as last reported: from
   * `session/new`, a `setConfigOption` reply, or an unsolicited `config_option_update`.
   * Empty for an agent that advertises none.
   */
  readonly configOptions: readonly SessionConfigOption[];
  /** Send `session/set_config_option`; the cache is replaced by the full list the agent returns. */
  setConfigOption(configId: string, value: string | boolean): Promise<SessionConfigOption[]>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

const STARTUP_TERMINATION = Symbol.for("orca.agents.startupTermination");

/**
 * Attach the owned process's exit to a session-open failure. A failed open has no session to
 * carry `terminated`, and its bounded cleanup may have given up before the exit was observed
 * (`details.cleanup.details.cleanupIncomplete`), so a caller that counts live processes -
 * session caps (#873) - needs the exit itself. Non-enumerable: it never reaches a log or the
 * wire, and the error's shape is unchanged.
 */
export function withStartupTermination<E extends object>(error: E, terminated: Promise<unknown>): E {
  // A rejection (the exit cannot be observed) stays a rejection: it is not evidence the
  // process is gone. Marked handled here so an error nobody inspects raises no warning.
  const exited = terminated.then(() => undefined);
  void exited.catch(() => undefined);
  Object.defineProperty(error, STARTUP_TERMINATION, {
    value: exited,
    enumerable: false,
    configurable: true,
  });
  return error;
}

/** The exit attached by `withStartupTermination`, or undefined when the failure spawned nothing. */
export function startupTermination(error: unknown): Promise<void> | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as { [STARTUP_TERMINATION]?: Promise<void> })[STARTUP_TERMINATION];
}

/** Reduce an ACP update to the compact form stored in the event log. */
export function summarizeUpdate(u: acp.SessionUpdate): AgentUpdateSummary {
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk":
      return {
        kind: u.sessionUpdate,
        ...(u.content.type === "text" ? { text: u.content.text } : { text: `[${u.content.type}]` }),
      };
    case "tool_call":
      return {
        kind: u.sessionUpdate,
        toolCallId: u.toolCallId,
        title: u.title,
        ...(u.kind ? { toolKind: u.kind } : {}),
        ...(u.status ? { status: u.status } : {}),
        ...(u.locations ? { locations: u.locations.map((l) => l.path) } : {}),
        ...toolBodies(u),
      };
    case "tool_call_update":
      return {
        kind: u.sessionUpdate,
        toolCallId: u.toolCallId,
        ...(u.title ? { title: u.title } : {}),
        ...(u.kind ? { toolKind: u.kind } : {}),
        ...(u.status ? { status: u.status } : {}),
        ...(u.locations ? { locations: u.locations.map((l) => l.path) } : {}),
        ...toolBodies(u),
      };
    case "plan":
      return {
        kind: u.sessionUpdate,
        planEntries: u.entries.map((e) => ({ content: e.content, status: e.status, priority: e.priority })),
      };
    case "config_option_update":
      return { kind: u.sessionUpdate, text: describeConfigOptions(u.configOptions) };
    default:
      return { kind: (u as { sessionUpdate: string }).sessionUpdate };
  }
}

/**
 * The tool call's args and result, capped here - at write time - so what lands
 * in the event log is what every later reader sees. ACP's own fields come
 * first: `rawInput` is the arguments, `rawOutput` the structured result. An
 * agent that sends no `rawOutput` still sends `content` (the text, diff or
 * terminal output a host would render), so that stands in for the result
 * rather than leaving a finished call with nothing to expand.
 */
function toolBodies(u: {
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: acp.ToolCallContent[] | null | undefined;
}): { args?: ToolCallBody; result?: ToolCallBody } {
  const args = toolCallBody(u.rawInput);
  const result = toolCallBody(u.rawOutput ?? (u.content?.length ? u.content : undefined));
  return { ...(args ? { args } : {}), ...(result ? { result } : {}) };
}
