/**
 * Folding a step's log into its tool calls: the reduction, and the one transition the log
 * records that nothing else can tell you — `awaiting-permission` settling.
 */
import { describe, expect, it } from "vitest";
import { foldToolCalls, ToolCallFold, refuses, summarizeArgs, type ToolCall } from "../src/step/tool-calls.js";
import type { LogEvent } from "../src/step/line-buffer.js";

let seq = 0;
const event = (type: string, payload: Record<string, unknown>): LogEvent =>
  ({ id: `e${seq}`, seq: seq++, runId: "run-parent", at: "2026-03-01T09:00:00.000Z", type, payload }) as LogEvent;

const update = (u: Record<string, unknown>): LogEvent =>
  event("agent.update", { stepRunId: "s-build-2", sessionId: "sess", update: u });

const byId = (calls: readonly ToolCall[], id: string): ToolCall | undefined => calls.find((c) => c.id === id);

describe("folding the log", () => {
  it("keeps the latest partial fields when replayed or delivered out of order", () => {
    const fold = new ToolCallFold();
    fold.update(30, {
      kind: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      result: { text: "public", length: 100 },
    });
    fold.update(20, { kind: "tool_call_update", toolCallId: "t1", title: "Read latest", locations: ["latest.ts"] });
    fold.update(10, {
      kind: "tool_call",
      toolCallId: "t1",
      title: "Read old",
      toolKind: "read",
      args: { text: "old args", length: 8 },
      text: "streamed text",
    });
    const snapshot = fold.snapshot();
    expect(snapshot).toEqual([
      {
        id: "t1",
        tool: "Read latest",
        toolKind: "read",
        argSummary: "old args",
        state: "ok",
        locations: ["latest.ts"],
        args: { text: "old args", length: 8 },
        result: { text: "public", length: 100 },
      },
    ]);
    fold.update(30, {
      kind: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      result: { text: "public", length: 100 },
    });
    fold.update(40, { kind: "agent_message_chunk", text: "more streamed text" });
    expect(fold.snapshot()).toBe(snapshot);
  });

  it("keeps both the latest terminal and running state around permission transitions", () => {
    const fold = new ToolCallFold();
    const ask = event("human.requested", { kind: "permission", question: "Read?", context: { toolCallId: "t1" } });
    fold.add([ask]);
    fold.update(ask.seq + 1, { kind: "tool_call_update", toolCallId: "t1", status: "completed" });
    fold.update(ask.seq + 2, { kind: "tool_call_update", toolCallId: "t1", status: "in_progress" });
    expect(fold.snapshot()[0]?.state).toBe("pending");
    // Retaining only the newest status would have left the old permission ask waiting.
  });

  it("opens a call, grows it and settles it, keeping the order it opened in", () => {
    const calls = foldToolCalls([
      update({ kind: "tool_call", toolCallId: "t1", title: "read", toolKind: "read", status: "pending" }),
      update({ kind: "tool_call", toolCallId: "t2", title: "bash", toolKind: "execute", status: "pending" }),
      update({
        kind: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        args: { text: '{"path":"src/app.ts"}', length: 20 },
        result: { text: "export const app = 1;", length: 21 },
      }),
    ]);

    expect(calls.map((c) => [c.id, c.state])).toEqual([
      ["t1", "ok"],
      ["t2", "pending"],
    ]);
    expect(byId(calls, "t1")?.result?.text).toBe("export const app = 1;");
    expect(byId(calls, "t1")?.argSummary).toBe("path=src/app.ts");
  });

  it("keeps the pre-cut length beside a body cut at write time, so a row can say so", () => {
    const calls = foldToolCalls([
      update({
        kind: "tool_call",
        toolCallId: "t1",
        title: "bash",
        args: { text: "x".repeat(2000), length: 41_318 },
      }),
    ]);
    expect(byId(calls, "t1")?.args).toEqual({ text: "x".repeat(2000), length: 41_318 });
  });

  it("is a row with nothing to expand when the log predates args and result (#220)", () => {
    const calls = foldToolCalls([update({ kind: "tool_call", toolCallId: "t1", title: "bash", status: "completed" })]);
    const call = byId(calls, "t1");
    expect(call).toMatchObject({ state: "ok" });
    expect(call).not.toHaveProperty("args");
    expect(call).not.toHaveProperty("result");
  });

  it("ignores updates that are not tool calls, so the stream and the list do not overlap", () => {
    expect(foldToolCalls([update({ kind: "agent_message_chunk", text: "hello\n" })])).toEqual([]);
  });
});

describe("waiting on a person", () => {
  it("is awaiting-permission from the ask, and settled by the agent.permission that answers it", () => {
    const asked = foldToolCalls([
      update({ kind: "tool_call", toolCallId: "t1", title: "bash", status: "pending" }),
      event("human.requested", {
        stepRunId: "s-build-2",
        requestId: "hi-9",
        kind: "permission",
        question: "Run rm -rf build?",
        options: [],
        context: { toolCallId: "t1" },
      }),
    ]);
    expect(byId(asked, "t1")).toMatchObject({ state: "awaiting-permission", question: "Run rm -rf build?" });

    const allowed = foldToolCalls([
      ...([] as LogEvent[]),
      update({ kind: "tool_call", toolCallId: "t2", title: "bash", status: "pending" }),
      event("agent.permission", {
        stepRunId: "s-build-2",
        sessionId: "sess",
        toolCallId: "t2",
        title: "bash",
        decision: "allow_once",
      }),
    ]);
    expect(byId(allowed, "t2")).toMatchObject({ state: "pending", decision: "allow_once" });
    expect(byId(allowed, "t2")?.question).toBeUndefined();
  });

  it("fails the call when the decision refused it — that is what happened to the call", () => {
    const calls = foldToolCalls([
      update({ kind: "tool_call", toolCallId: "t1", title: "bash", status: "pending" }),
      event("agent.permission", {
        stepRunId: "s-build-2",
        sessionId: "sess",
        toolCallId: "t1",
        title: "bash",
        decision: "deny",
      }),
    ]);
    expect(byId(calls, "t1")).toMatchObject({ state: "failed", decision: "deny" });
  });

  it("knows a refusal from a permission however it is spelt", () => {
    expect(["deny", "Denied", "reject", "cancelled"].map(refuses)).toEqual([true, true, true, true]);
    expect(["allow", "allow_once", "allow-always", "approve"].map(refuses)).toEqual([false, false, false, false]);
  });
});

describe("the argument summary", () => {
  it("prefers the subject over the envelope, on one line", () => {
    expect(summarizeArgs({ text: '{"path":"a.ts","limit":20}', length: 25 }, [])).toBe("path=a.ts limit=20");
  });

  it("falls back to the payload itself, flattened, when it is not an object of scalars", () => {
    expect(summarizeArgs({ text: "grep -rn 'x'\n  src/", length: 19 }, [])).toBe("grep -rn 'x' src/");
  });

  it("uses the locations when the log carries no args at all", () => {
    expect(summarizeArgs(undefined, ["src/a.ts", "src/b.ts"])).toBe("src/a.ts src/b.ts");
  });
});
