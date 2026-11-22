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
}

export interface AgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly hostId: string;
  readonly cwd: string;
  readonly acpSessionId: string;
  readonly closed: Promise<void>;
  /**
   * Settles once the agent process this session owns is confirmed gone, which can be later
   * than `closed` (the connection) and later than a `close()` whose cleanup could not observe
   * the exit. Session caps (#873) return a slot on this, so a queued open never starts beside
   * a process that is still alive. Optional: a transport without an owned process omits it,
   * and then `close()` settling stands in for it.
   */
  readonly terminated?: Promise<void>;
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
  Object.defineProperty(error, STARTUP_TERMINATION, {
    value: terminated.then(
      () => undefined,
      () => undefined,
    ),
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
