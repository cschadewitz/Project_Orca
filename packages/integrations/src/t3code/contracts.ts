/**
 * Minimal, hand-written mirror of the T3 Code orchestration contracts ORCA
 * needs (source: packages/contracts/src/orchestration.ts in pingdotgg/t3code).
 * Only the commands/events used by the adapter are modelled; everything else
 * is passed through as `unknown` so a contract drift does not break ORCA.
 */
export type T3ThreadId = string;
export type T3ProjectId = string;
export type T3TurnId = string;

export interface T3ModelSelection {
  instanceId: string; // provider instance (codex, claude, cursor, ...)
  model: string;
  options?: Record<string, unknown>;
}

export type T3Command =
  | { type: "project.create"; projectId: T3ProjectId; title: string; workspaceRoot: string }
  | { type: "thread.create"; threadId: T3ThreadId; projectId: T3ProjectId; title: string; modelSelection: T3ModelSelection; runtimeMode: "full-access" | "approval-required" | "read-only" }
  | { type: "thread.turn.start"; threadId: T3ThreadId; messageId: string; text: string; attachments: unknown[]; modelSelection: T3ModelSelection; runtimeMode: "full-access" | "approval-required" | "read-only" }
  | { type: "thread.turn.interrupt"; threadId: T3ThreadId; turnId?: T3TurnId }
  | { type: "thread.approval.respond"; threadId: T3ThreadId; requestId: string; decision: "accept" | "decline" }
  | { type: "thread.session.stop"; threadId: T3ThreadId };

export interface T3ThreadEvent {
  type: string; // e.g. "thread.message-sent", "thread.activity-appended", "thread.session-set"
  payload: Record<string, unknown>;
}

export const T3_WS_METHODS = {
  dispatchCommand: "orchestration.dispatchCommand",
  subscribeThread: "orchestration.subscribeThread",
  getTurnDiff: "orchestration.getTurnDiff",
} as const;

/** Transport-agnostic RPC surface; implement over T3 Code's Effect-RPC WebSocket envelope. */
export interface T3CodeRpc {
  call<T = unknown>(method: string, payload: unknown): Promise<T>;
  subscribe(method: string, payload: unknown, onEvent: (event: T3ThreadEvent) => void): () => void;
}
