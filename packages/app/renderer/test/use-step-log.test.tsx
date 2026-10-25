// @vitest-environment happy-dom
/** Live tool state shares the output commit clock and reconciles public pages/pushes. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { RunsEventsResult } from "@orca/protocol";
import type { BridgeResult } from "../../src/bridge.js";
import { useStepLog } from "../src/step/use-step-log.js";
import type { AgentUpdate, BufferOptions, LogEvent } from "../src/step/line-buffer.js";
import { harness, installBridge, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

const AT = "2026-03-01T09:01:00.000Z";
const start: AgentUpdate = { kind: "tool_call", toolCallId: "t1", title: "Read source", status: "pending" };
const complete: AgentUpdate = { kind: "tool_call_update", toolCallId: "t1", status: "completed" };
const message = (text: string): AgentUpdate => ({ kind: "agent_message_chunk", text });
const event = (seq: number, update: AgentUpdate, stepRunId = "step"): LogEvent => ({
  id: `e${seq}`,
  seq,
  runId: "run-parent",
  at: AT,
  type: "agent.update",
  payload: { stepRunId, sessionId: "sess", update },
});
const page = (events: LogEvent[], hasMore = false): BridgeResult<RunsEventsResult> => ({
  ok: true,
  result: { events, hasMore, lastSeq: events.at(-1)?.seq ?? 0, prevCursor: events[0]?.seq ?? 0, asOf: AT },
});

let fake: FakeBridge;
let h: Harness;
let now: number;
let frame: (() => void) | undefined;
let buffer: BufferOptions;

function push(seq: number, updates: AgentUpdate[], stepRunId = "step", runId = "run-parent"): void {
  fake.notify({
    kind: "notification",
    method: "agent.update",
    params: {
      subscriptionId: "sub",
      runId,
      stepRunId,
      sessionId: "sess",
      fromSeq: seq,
      seq: seq + updates.length - 1,
      at: AT,
      updates,
    },
  });
}

function append(seq: number, type: string, payload: Record<string, unknown>, stepRunId = "step"): void {
  const log = { id: `e${seq}`, seq, runId: "run-parent", at: AT, type, payload: { stepRunId, ...payload } } as LogEvent;
  fake.notify({
    kind: "notification",
    method: "event.appended",
    params: {
      subscriptionId: "sub",
      runId: "run-parent",
      seq,
      at: AT,
      event: log,
    },
  });
}

function tick(ms = 100): void {
  now += ms;
  const callback = frame;
  frame = undefined;
  callback?.();
}

function mount() {
  return renderHook(({ step, run }) => useStepLog(run, step, { connection: "live", openHeld: true, buffer }), {
    initialProps: { step: "step", run: "run-parent" },
    wrapper: h.Providers,
  });
}

beforeEach(() => {
  fake = installBridge();
  fake.script({ "runs.events": () => page([]) });
  h = harness();
  now = 0;
  frame = undefined;
  buffer = {
    now: () => now,
    schedule: (callback) => {
      frame = callback;
      return 1;
    },
    cancel: () => {
      frame = undefined;
    },
  };
});
afterEach(() => {
  cleanup();
  h.dispose();
});

describe("live tool projection", () => {
  it.each([false, true])("merges an overlapping initial read and live batch (reattachment: %s)", async (reconnect) => {
    // First attachment is held before mount; reattachment is held after a ready read.
    let release = reconnect ? () => {} : fake.hold("runs.events");
    const hook = mount();
    if (reconnect) {
      await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
      release = fake.hold("runs.events");
      act(() => fake.connect({ ...fake.connection, generation: 2 }));
    }
    // The snapshot and push overlap at 10/11; 12 exists only in the push.
    fake.script({ "runs.events": () => page([event(10, start), event(11, message("same output\n"))]) });
    act(() => push(10, [start, message("same output\n"), complete]));
    await act(async () => release());
    expect(hook.result.current.toolCalls).toMatchObject([{ id: "t1", tool: "Read source", state: "ok" }]);
    expect(hook.result.current.rows.filter((r) => r.kind === "line").map((r) => r.text)).toEqual([
      "Read source",
      "same output",
    ]);
    expect(hook.result.current.events).toHaveLength(2);
    expect(hook.result.current.pending).toBe(2);
  });

  it("keeps tool updates received while the second, tail page is pending", async () => {
    let finish = (_answer: BridgeResult<RunsEventsResult>): void => {};
    fake.script({
      "runs.events": (params) =>
        params.before === undefined
          ? page([event(1, message("front\n"))], true)
          : new Promise((resolve) => {
              finish = resolve;
            }),
    });
    const hook = mount();
    await waitFor(() => expect(fake.calls.filter((c) => c.method === "runs.events")).toHaveLength(2));
    act(() => push(20, [start, complete]));
    await act(async () => finish(page([event(20, start)])));
    expect(hook.result.current.toolCalls).toMatchObject([{ id: "t1", state: "ok" }]);
    expect(hook.result.current.rows.filter((r) => r.kind === "line").map((r) => r.text)).toEqual(["Read source"]);
  });

  it("deduplicates replay and ignores wrong step/run and stale field/state updates", async () => {
    fake.script({ "runs.events": () => page([event(10, start), event(30, complete)]) });
    const hook = mount();
    await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
    const calls = hook.result.current.toolCalls;
    act(() => {
      push(10, [start]);
      push(30, [complete]);
      push(9, [{ ...start, title: "stale title" }]);
      push(31, [{ ...start, toolCallId: "wrong-step" }], "other");
      push(32, [{ ...start, toolCallId: "wrong-run" }], "step", "other-run");
      append(
        33,
        "agent.permission",
        { sessionId: "sess", toolCallId: "wrong-event", title: "No", decision: "deny" },
        "other",
      );
      tick();
    });
    expect(hook.result.current.toolCalls).toMatchObject([{ id: "t1", tool: "Read source", state: "ok" }]);
    // An earlier first-seen seq can change order, but cannot roll back a newer field.
    const replayed = hook.result.current.toolCalls;
    act(() => {
      push(30, [complete]);
      tick();
    });
    expect(hook.result.current.toolCalls).toBe(replayed);
    expect(calls).toHaveLength(1);
    expect(hook.result.current.rows.filter((r) => r.kind === "line").map((r) => r.text)).toEqual(["Read source"]);
    expect(hook.result.current.events).toHaveLength(2);
  });

  it.each(["allow_once", "deny"])("orders a %s permission ahead of delayed older tool batches", async (decision) => {
    const hook = mount();
    await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
    act(() =>
      append(11, "human.requested", {
        requestId: "ask",
        kind: "permission",
        question: "Read source?",
        options: [],
        context: { toolCallId: "t1" },
      }),
    );
    act(() => {
      push(10, [start]);
      push(12, [{ ...complete, status: "pending" }]);
      tick();
    });
    expect(hook.result.current.toolCalls).toMatchObject([
      { state: "awaiting-permission", question: "Read source?", tool: "Read source" },
    ]);
    act(() => append(14, "agent.permission", { sessionId: "sess", toolCallId: "t1", title: "Read source", decision }));
    const settled = decision === "deny" ? "failed" : "pending";
    expect(hook.result.current.toolCalls).toMatchObject([{ state: settled, decision }]);
    expect(hook.result.current.toolCalls[0]?.question).toBeUndefined();
    act(() => {
      push(13, [{ ...complete, status: "in_progress" }]);
      tick();
    });
    expect(hook.result.current.toolCalls[0]?.state).toBe(settled);
    act(() => {
      push(15, [complete]);
      tick();
    });
    expect(hook.result.current.toolCalls[0]?.state).toBe("ok");
    expect(hook.result.current.toolCalls[0]?.decision).toBe(decision);
  });

  it("uses older pages for missing details without undoing a live outcome", async () => {
    fake.script({
      "runs.events": (params) =>
        params.before === 10
          ? page([
              event(1, { ...start, args: { text: '{"path":"a.ts"}', length: 15 } }),
              event(2, { ...start, toolCallId: "t0" }),
            ])
          : page([event(10, complete)], true),
    });
    const hook = mount();
    await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
    act(() => {
      push(20, [{ ...complete, status: "failed", result: { text: "public failure", length: 14 } }]);
      tick();
    });
    await act(async () => hook.result.current.loadEarlier());
    expect(hook.result.current.toolCalls.map((c) => c.id)).toEqual(["t1", "t0"]);
    expect(hook.result.current.toolCalls[0]).toMatchObject({
      tool: "Read source",
      state: "failed",
      argSummary: "path=a.ts",
      result: { text: "public failure", length: 14 },
    });
  });

  it.each(["step", "run", "generation"])("discards a late read and queued frame after a %s change", async (change) => {
    let finish = (_answer: BridgeResult<RunsEventsResult>): void => {};
    fake.script({
      "runs.events": () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const hook = mount();
    await waitFor(() => expect(fake.calls.some((c) => c.method === "runs.events")).toBe(true));
    const finishOld = finish;
    act(() => push(10, [start]));
    fake.script({ "runs.events": () => page([]) });
    act(() => {
      if (change === "generation") fake.connect({ ...fake.connection, generation: 2 });
      else
        hook.rerender({
          step: change === "step" ? "other" : "step",
          run: change === "run" ? "other-run" : "run-parent",
        });
    });
    await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
    await act(async () => finishOld(page([event(10, start)])));
    act(() => tick());
    expect(hook.result.current.toolCalls).toEqual([]);
    expect(hook.result.current.rows).toEqual([]);
  });

  it("coalesces rapid tool updates with output, keeps held counts and retains no streamed text in events", async () => {
    let renders = 0;
    const hook = renderHook(
      () => {
        renders++;
        return useStepLog("run-parent", "step", { connection: "live", openHeld: true, buffer });
      },
      { wrapper: h.Providers },
    );
    await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
    const before = renders;
    for (let i = 0; i < 400; i++)
      act(() => {
        push(100 + i * 2, [
          { ...start, kind: i === 0 ? "tool_call" : "tool_call_update", title: `Read ${i}` },
          message(`line ${i}\n`),
        ]);
        tick(25);
      });
    expect(renders - before).toBeLessThanOrEqual(100);
    expect(hook.result.current.toolCalls).toMatchObject([{ tool: "Read 399", state: "pending" }]);
    expect(hook.result.current.events).toEqual([]);
    expect(hook.result.current.following).toBe(false);
    expect(hook.result.current.pending).toBe(401);
    expect(hook.result.current.rows.filter((r) => r.kind === "line")).toHaveLength(401);
    const calls = hook.result.current.toolCalls;
    act(() => {
      push(1000, [message("text only\n")]);
      tick();
    });
    expect(hook.result.current.toolCalls).toBe(calls);
    expect(hook.result.current.pending).toBe(402);
    act(() => hook.result.current.follow());
    expect(hook.result.current.pending).toBe(0);
  });
});
