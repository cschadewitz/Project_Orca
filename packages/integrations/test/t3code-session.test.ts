/**
 * The T3 Code adapter against a fake RPC: what it dispatches, how thread events
 * become ORCA session updates, and when a turn is considered finished. The real
 * WebSocket envelope is not implemented (UnimplementedT3CodeRpc), so this is
 * where the adapter's behaviour is pinned down.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentSpec } from "@orca/core";
import type { AgentHost } from "@orca/agents";
import {
  openT3CodeSession,
  T3_WS_METHODS,
  UnimplementedT3CodeRpc,
  type T3CodeRpc,
  type T3ThreadEvent,
} from "@orca/integrations";

/** Records every dispatched command and hands the test the event callback the adapter subscribed with. */
function fakeRpc() {
  const calls: { method: string; payload: { type?: string; [k: string]: unknown } }[] = [];
  let emit: (e: T3ThreadEvent) => void = () => {};
  const unsubscribe = vi.fn();
  const rpc: T3CodeRpc = {
    async call(method, payload) {
      calls.push({ method, payload: payload as { type?: string } });
      return undefined as never;
    },
    subscribe(method, payload, onEvent) {
      calls.push({ method, payload: payload as { type?: string } });
      emit = onEvent;
      return unsubscribe;
    },
  };
  return {
    rpc,
    calls,
    unsubscribe,
    emit: (e: T3ThreadEvent) => emit(e),
    commands: () => calls.filter((c) => c.method === T3_WS_METHODS.dispatchCommand).map((c) => c.payload.type ?? ""),
  };
}

const base = {
  agent: { id: "t3", hostId: "local" } as AgentSpec,
  host: { id: "local", spec: { id: "local", type: "local" } } as AgentHost,
  cwd: "/work",
  clock: { now: () => 1_000, isoNow: () => "2026-01-01T00:00:00.000Z" },
};

const open = (rpc: T3CodeRpc) =>
  openT3CodeSession(base, { rpc, projectId: "proj_1", modelSelection: { instanceId: "codex", model: "gpt-5" } });

/** The thread goes idle: what the adapter reads as "the turn is over". */
const idle: T3ThreadEvent = { type: "thread.session-set", payload: { session: { activeTurnId: null } } };

describe("openT3CodeSession", () => {
  it("creates a thread and subscribes to it, reporting the thread as the ACP session id", async () => {
    const { rpc, calls } = fakeRpc();
    const session = await open(rpc);
    expect(calls[0]).toMatchObject({
      method: T3_WS_METHODS.dispatchCommand,
      payload: { type: "thread.create", projectId: "proj_1", title: "orca t3", runtimeMode: "full-access" },
    });
    expect(calls[1]).toMatchObject({
      method: T3_WS_METHODS.subscribeThread,
      payload: { threadId: calls[0]!.payload.threadId },
    });
    expect(session.acpSessionId).toBe(calls[0]!.payload.threadId);
    expect(session).toMatchObject({ agentId: "t3", hostId: "local", cwd: "/work" });
  });

  it("takes the title and runtime mode from its options", async () => {
    const { rpc, calls } = fakeRpc();
    await openT3CodeSession(base, {
      rpc,
      projectId: "proj_1",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      title: "Review",
      runtimeMode: "read-only",
    });
    expect(calls[0]!.payload).toMatchObject({ title: "Review", runtimeMode: "read-only" });
  });

  it("starts a turn and resolves it once the thread goes idle", async () => {
    const { rpc, emit, commands } = fakeRpc();
    const session = await open(rpc);
    const turn = session.prompt("Write the spec.");
    await vi.waitFor(() => expect(commands()).toContain("thread.turn.start"));
    emit(idle);
    expect(await turn).toEqual({ stopReason: "end_turn", durationMs: 0 });
  });

  it("joins a structured prompt into one text block, ignoring what is not text", async () => {
    const { rpc, emit, calls } = fakeRpc();
    const session = await open(rpc);
    const turn = session.prompt([
      { type: "text", text: "one" },
      { type: "image" } as never,
      { type: "text", text: "two" },
    ]);
    await vi.waitFor(() => expect(calls.some((c) => c.payload.type === "thread.turn.start")).toBe(true));
    expect(calls.find((c) => c.payload.type === "thread.turn.start")!.payload.text).toBe("one\n\ntwo");
    emit(idle);
    await turn;
  });

  it("reads a completed latestTurn as idle too", async () => {
    const { rpc, emit, commands } = fakeRpc();
    const session = await open(rpc);
    const turn = session.prompt("go");
    await vi.waitFor(() => expect(commands()).toContain("thread.turn.start"));
    // No `session` in the payload: fall back to the turn's own state.
    emit({ type: "thread.turn-diff-completed", payload: { latestTurn: { state: "running" } } });
    emit({ type: "thread.turn-diff-completed", payload: {} }); // neither session nor latestTurn: not idle
    emit({ type: "thread.turn-diff-completed", payload: { latestTurn: { state: "error" } } });
    expect(await turn).toMatchObject({ stopReason: "end_turn" });
  });

  it("refuses a second concurrent turn on the same thread", async () => {
    const { rpc, emit, commands } = fakeRpc();
    const session = await open(rpc);
    const turn = session.prompt("first");
    await vi.waitFor(() => expect(commands()).toContain("thread.turn.start"));
    await expect(session.prompt("second")).rejects.toMatchObject({ code: "RUN_STATE" });
    emit(idle);
    await turn;
  });

  it("interrupts the thread on cancel and settles the waiting turn as cancelled", async () => {
    const { rpc, commands } = fakeRpc();
    const session = await open(rpc);
    const turn = session.prompt("go");
    await vi.waitFor(() => expect(commands()).toContain("thread.turn.start"));
    await session.cancel();
    expect(commands()).toContain("thread.turn.interrupt");
    expect(await turn).toMatchObject({ stopReason: "cancelled" });
    // Cancelling with no turn in flight is a no-op beyond the interrupt.
    await expect(session.cancel()).resolves.toBeUndefined();
  });

  it("cancels the turn when the caller's signal fires", async () => {
    const { rpc, commands } = fakeRpc();
    const session = await open(rpc);
    const ac = new AbortController();
    const turn = session.prompt("go", { signal: ac.signal });
    await vi.waitFor(() => expect(commands()).toContain("thread.turn.start"));
    ac.abort();
    expect(await turn).toMatchObject({ stopReason: "cancelled" });
  });

  it("cancels the turn when its timeout elapses", async () => {
    const { rpc, commands } = fakeRpc();
    const session = await open(rpc);
    const turn = session.prompt("go", { timeoutMs: 5 });
    expect(await turn).toMatchObject({ stopReason: "cancelled" });
    expect(commands()).toContain("thread.turn.interrupt");
  });

  it("maps assistant messages and activities to update summaries, and drops the rest", async () => {
    const { rpc, emit } = fakeRpc();
    const session = await open(rpc);
    const seen: unknown[] = [];
    const off = session.onUpdate((e) => seen.push(e.summary));

    emit({ type: "thread.message-sent", payload: { role: "assistant", text: "hello" } });
    emit({ type: "thread.message-sent", payload: { role: "user", text: "ignored" } });
    emit({
      type: "thread.activity-appended",
      payload: { activity: { kind: "edit", summary: "Edited a file", tone: "tool" } },
    });
    emit({ type: "thread.activity-appended", payload: { activity: { kind: "thinking" } } });
    emit({ type: "thread.activity-appended", payload: {} });
    emit({ type: "thread.something-else", payload: {} });

    expect(seen).toEqual([
      { kind: "agent_message_chunk", text: "hello" },
      { kind: "tool_call", title: "Edited a file", text: "Edited a file" },
      { kind: "agent_thought_chunk", title: "thinking", text: "" },
    ]);

    // Unsubscribing stops the flow.
    off();
    emit({ type: "thread.message-sent", payload: { role: "assistant", text: "later" } });
    expect(seen).toHaveLength(3);
  });

  it("stops the thread on close, and survives a stop the server refuses", async () => {
    const { rpc, unsubscribe, commands } = fakeRpc();
    const session = await open(rpc);
    let closed = false;
    void session.closed.then(() => (closed = true));
    await session.close();
    expect(unsubscribe).toHaveBeenCalled();
    expect(commands()).toContain("thread.session.stop");
    await vi.waitFor(() => expect(closed).toBe(true));

    const failing = fakeRpc();
    const other = await open(failing.rpc);
    failing.rpc.call = async () => {
      throw new Error("socket closed");
    };
    await expect(other.close()).resolves.toBeUndefined();
  });
});

describe("UnimplementedT3CodeRpc", () => {
  it("names the transport that is still missing", async () => {
    const rpc = new UnimplementedT3CodeRpc("ws://localhost:1234");
    await expect(rpc.call()).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: expect.stringContaining("ws://localhost:1234"),
    });
    expect(() => rpc.subscribe()).toThrow(/not implemented yet/);
  });
});
