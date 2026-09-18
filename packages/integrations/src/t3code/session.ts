/**
 * T3 Code integration - groundwork.
 *
 * T3 Code (pingdotgg/t3code) is an open-source, TypeScript control plane for
 * coding agents: a Node WebSocket server wraps provider CLIs (Codex, Claude
 * Code, Cursor, OpenCode, ...) and exposes an event-sourced orchestration
 * model (projects -> threads -> turns -> checkpoints). It is not an ACP client
 * or agent, so ORCA talks to it through its WebSocket RPC instead of stdio.
 *
 * This adapter implements ORCA's AgentSession on top of a T3 thread:
 *   prompt()  -> thread.turn.start, then wait for the turn to reach a terminal state
 *   updates   -> thread.message-sent / thread.activity-appended mapped to ACP-like summaries
 *   cancel()  -> thread.turn.interrupt
 *
 * What is deliberately left open (see docs/INTEGRATIONS.md):
 *   - the concrete WebSocket transport (Effect RPC envelope, auth) - implement T3CodeRpc
 *   - workspace mapping: T3 creates a worktree per thread; ORCA's WorkspaceProvider
 *     should read `thread.meta-updated.worktreePath` to point later steps at it.
 */
import { randomUUID } from "node:crypto";
import type { AgentSession, OpenSessionOptions, SessionUpdateEvent, TurnResult } from "@orca/agents";
import { newId, OrcaError, type AgentUpdateSummary } from "@orca/core";
import { T3_WS_METHODS, type T3CodeRpc, type T3ModelSelection, type T3ThreadEvent } from "./contracts.js";

export interface T3CodeSessionOptions {
  rpc: T3CodeRpc;
  projectId: string;
  modelSelection: T3ModelSelection;
  runtimeMode?: "full-access" | "approval-required" | "read-only";
  title?: string;
}

export async function openT3CodeSession(
  base: Pick<OpenSessionOptions, "agent" | "host" | "cwd" | "clock">,
  o: T3CodeSessionOptions,
): Promise<AgentSession> {
  const threadId = randomUUID();
  const runtimeMode = o.runtimeMode ?? "full-access";
  await o.rpc.call(T3_WS_METHODS.dispatchCommand, {
    type: "thread.create",
    threadId,
    projectId: o.projectId,
    title: o.title ?? `orca ${base.agent.id}`,
    modelSelection: o.modelSelection,
    runtimeMode,
  });
  const listeners = new Set<(e: SessionUpdateEvent) => void>();
  const id = newId("sess");
  let turnWaiter: { resolve: (r: TurnResult) => void; started: number } | undefined;
  const now = () => base.clock?.now() ?? Date.now();

  const unsubscribe = o.rpc.subscribe(T3_WS_METHODS.subscribeThread, { threadId }, (event: T3ThreadEvent) => {
    const summary = toSummary(event);
    if (summary)
      for (const l of listeners)
        l({
          sessionId: id,
          raw: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: summary.text ?? "" } },
          summary,
          at: now(),
        });
    if (event.type === "thread.session-set" || event.type === "thread.turn-diff-completed") {
      const sess = event.payload.session as { activeTurnId?: string | null } | undefined;
      const latestTurn = (event.payload as { latestTurn?: { state?: string } }).latestTurn;
      const idle = sess
        ? sess.activeTurnId === null
        : latestTurn
          ? latestTurn.state === "completed" || latestTurn.state === "error" || latestTurn.state === "interrupted"
          : false;
      if (idle && turnWaiter) {
        const w = turnWaiter;
        turnWaiter = undefined;
        w.resolve({ stopReason: "end_turn", durationMs: now() - w.started });
      }
    }
  });

  let closedResolve: () => void = () => {};
  const closed = new Promise<void>((r) => (closedResolve = r));

  const cancel = async (): Promise<void> => {
    await o.rpc.call(T3_WS_METHODS.dispatchCommand, { type: "thread.turn.interrupt", threadId });
    if (turnWaiter) {
      const w = turnWaiter;
      turnWaiter = undefined;
      w.resolve({ stopReason: "cancelled", durationMs: now() - w.started });
    }
  };

  return {
    id,
    agentId: base.agent.id,
    hostId: base.host.id,
    cwd: base.cwd,
    acpSessionId: threadId,
    closed,
    async prompt(input, options = {}) {
      if (turnWaiter) throw new OrcaError("RUN_STATE", "a turn is already active on this T3 thread");
      const text = typeof input === "string" ? input : input.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const started = now();
      const result = new Promise<TurnResult>((resolve) => (turnWaiter = { resolve, started }));
      await o.rpc.call(T3_WS_METHODS.dispatchCommand, {
        type: "thread.turn.start",
        threadId,
        messageId: randomUUID(),
        text,
        attachments: [],
        modelSelection: o.modelSelection,
        runtimeMode,
      });
      const timer = options.timeoutMs ? setTimeout(() => void cancel(), options.timeoutMs) : undefined;
      options.signal?.addEventListener("abort", () => void cancel(), { once: true });
      try {
        return await result;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    onUpdate(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    cancel,
    async close() {
      unsubscribe();
      await o.rpc.call(T3_WS_METHODS.dispatchCommand, { type: "thread.session.stop", threadId }).catch(() => undefined);
      closedResolve();
    },
  };
}

function toSummary(e: T3ThreadEvent): AgentUpdateSummary | undefined {
  switch (e.type) {
    case "thread.message-sent": {
      const p = e.payload as { role?: string; text?: string };
      return p.role === "assistant" ? { kind: "agent_message_chunk", text: p.text ?? "" } : undefined;
    }
    case "thread.activity-appended": {
      const a = (e.payload as { activity?: { kind?: string; summary?: string; tone?: string } }).activity;
      return a
        ? {
            kind: a.tone === "tool" ? "tool_call" : "agent_thought_chunk",
            title: a.summary ?? a.kind ?? "",
            text: a.summary ?? "",
          }
        : undefined;
    }
    default:
      return undefined;
  }
}

/** Not yet implemented: T3 Code's WebSocket envelope (Effect RPC). Documented in docs/INTEGRATIONS.md. */
export class UnimplementedT3CodeRpc implements T3CodeRpc {
  constructor(readonly url: string) {}
  async call<T>(): Promise<T> {
    throw new OrcaError("NOT_SUPPORTED", `T3 Code WebSocket transport for ${this.url} is not implemented yet`);
  }
  subscribe(): () => void {
    throw new OrcaError("NOT_SUPPORTED", `T3 Code WebSocket transport for ${this.url} is not implemented yet`);
  }
}
