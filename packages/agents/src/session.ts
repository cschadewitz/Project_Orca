/**
 * AgentSession - one ACP session with one agent process, from ORCA's point of
 * view. The engine talks to this interface only; the ACP details live in
 * acp-session.ts so alternative transports (T3 Code threads, HTTP ACP) can
 * implement the same contract.
 */
import type * as acp from "@agentclientprotocol/sdk";
import type { AgentUpdateSummary } from "@orca/core";

export interface TurnResult {
  stopReason: acp.StopReason;
  durationMs: number;
  updateCount: number;
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
  prompt(input: string | acp.ContentBlock[], options?: PromptOptions): Promise<TurnResult>;
  onUpdate(listener: (e: SessionUpdateEvent) => void): () => void;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

/** Reduce an ACP update to the compact form stored in the event log. */
export function summarizeUpdate(u: acp.SessionUpdate): AgentUpdateSummary {
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk":
      return { kind: u.sessionUpdate, ...(u.content.type === "text" ? { text: u.content.text } : { text: `[${u.content.type}]` }) };
    case "tool_call":
      return {
        kind: u.sessionUpdate,
        toolCallId: u.toolCallId,
        title: u.title,
        ...(u.kind ? { toolKind: u.kind } : {}),
        ...(u.status ? { status: u.status } : {}),
        ...(u.locations ? { locations: u.locations.map((l) => l.path) } : {}),
      };
    case "tool_call_update":
      return {
        kind: u.sessionUpdate,
        toolCallId: u.toolCallId,
        ...(u.title ? { title: u.title } : {}),
        ...(u.kind ? { toolKind: u.kind } : {}),
        ...(u.status ? { status: u.status } : {}),
        ...(u.locations ? { locations: u.locations.map((l) => l.path) } : {}),
      };
    case "plan":
      return { kind: u.sessionUpdate, planEntries: u.entries.map((e) => ({ content: e.content, status: e.status, priority: e.priority })) };
    default:
      return { kind: (u as { sessionUpdate: string }).sessionUpdate };
  }
}
