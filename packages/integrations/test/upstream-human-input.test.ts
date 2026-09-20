/** Per-run routing of gates / `ask` permissions to the ACP session that owns the run. */
import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { toGateOption } from "@orca/core";
import type { HumanInputQuery } from "@orca/engine";
import { UpstreamHumanInput, type UpstreamTarget } from "@orca/integrations";

function target(sessionId: string, log: { sessionId: string; question: string }[]): UpstreamTarget {
  return {
    sessionId,
    // The stub only answers session/request_permission, so it is cast rather than made generic over every client method.
    request: (async (_method: string, params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> => {
      log.push({ sessionId: params.sessionId, question: params.toolCall.title ?? "" });
      return { outcome: { outcome: "selected", optionId: params.options[0]!.optionId } };
    }) as UpstreamTarget["request"],
  };
}

const query = (runId: string, question: string): HumanInputQuery => ({
  runId,
  stepRunId: "step",
  requestId: `hi-${runId}`,
  kind: "decision",
  question,
  options: ["ship", "hold"].map(toGateOption),
  context: {},
});

describe("UpstreamHumanInput", () => {
  it("routes each run's questions to the session bound to that run", async () => {
    const log: { sessionId: string; question: string }[] = [];
    const port = new UpstreamHumanInput();
    const unbindA = port.bind("run-a", target("sess-a", log));
    const unbindB = port.bind("run-b", target("sess-b", log));

    expect(await port.ask(query("run-a", "A?"))).toBe("ship");
    expect(await port.ask(query("run-b", "B?"))).toBe("ship");
    expect(log).toEqual([
      { sessionId: "sess-a", question: "[orca decision] A?" },
      { sessionId: "sess-b", question: "[orca decision] B?" },
    ]);

    // Unbinding A leaves B's routing untouched (the global-bind bug unbound everyone).
    unbindA();
    expect(await port.targetFor("run-a")).toBeUndefined();
    expect((await port.targetFor("run-b"))?.sessionId).toBe("sess-b");
    unbindB();
    expect(await port.targetFor("run-b")).toBeUndefined();
  });

  it("walks parentRunId so questions from child runs reach the root run's session", async () => {
    const log: { sessionId: string; question: string }[] = [];
    const parents: Record<string, string> = { "run-child": "run-root", "run-grandchild": "run-child" };
    const port = new UpstreamHumanInput({ parentRunId: async (id) => parents[id] });
    port.bind("run-root", target("sess-root", log));

    expect(await port.ask(query("run-grandchild", "deep?"))).toBe("ship");
    expect(log).toEqual([{ sessionId: "sess-root", question: "[orca decision] deep?" }]);
    // The nearest bound ancestor wins when a child is bound separately.
    port.bind("run-child", target("sess-child", log));
    expect((await port.targetFor("run-grandchild"))?.sessionId).toBe("sess-child");
  });

  it("falls back to the wrapped port for runs no session owns", async () => {
    const asked: string[] = [];
    const port = new UpstreamHumanInput({ fallback: { ask: async (q) => (asked.push(q.runId), "hold") } });
    port.bind("run-a", target("sess-a", []));
    expect(await port.ask(query("run-other", "orphan?"))).toBe("hold");
    expect(asked).toEqual(["run-other"]);
    // A bound run with a cyclic / unknown parent chain still terminates.
    const cyclic = new UpstreamHumanInput({
      fallback: { ask: async () => "hold" },
      parentRunId: async (id) => (id === "x" ? "y" : "x"),
    });
    expect(await cyclic.ask(query("x", "loop?"))).toBe("hold");
  });

  it("only removes its own binding when a run was re-bound", async () => {
    const port = new UpstreamHumanInput();
    const first = target("sess-1", []);
    const second = target("sess-2", []);
    const unbindFirst = port.bind("run-a", first);
    port.bind("run-a", second);
    unbindFirst();
    expect((await port.targetFor("run-a"))?.sessionId).toBe("sess-2");
  });

  it("returns undefined when the client cancels the permission request", async () => {
    const port = new UpstreamHumanInput();
    port.bind("run-a", {
      sessionId: "sess-a",
      request: (async (): Promise<acp.RequestPermissionResponse> => ({
        outcome: { outcome: "cancelled" },
      })) as UpstreamTarget["request"],
    });
    expect(await port.ask(query("run-a", "cancel?"))).toBeUndefined();
  });
});
