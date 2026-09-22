// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  RunsListResult,
  RunsGetResult,
  InputsListResult,
  NotificationMessage,
  RunsEventsResult,
  AgentsListResult,
} from "@orca/protocol";
import type { BridgeResult } from "../../src/bridge.js";
import { useAgents } from "../src/agents/use-agents.js";
import { useRunEvents } from "../src/runs/timeline/use-run-events.js";
import { AGENTS_LIST } from "./fixtures-agents.js";
import { useStepLog } from "../src/step/use-step-log.js";
import { useRuns } from "../src/runs/use-runs.js";
import { useRunTree } from "../src/runs/tree/use-run-tree.js";
import { useAttention } from "../src/attention/use-attention.js";
import { harness, installBridge, type Harness } from "./harness.js";
import { AS_OF, RUNS, RUN_DETAILS, INPUTS } from "./fixtures.js";

let h: Harness;
afterEach(() => {
  cleanup();
  h?.dispose();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const changed = (runId: string, status: string, seq: number): NotificationMessage => ({
  kind: "notification",
  method: "run.changed",
  params: { subscriptionId: "sub", runId, status, seq, at: AS_OF, event: "run.completed" },
});
const base = RUNS.find((r) => r.status === "running")!;

describe("snapshot and subscription reconciliation", () => {
  it.each([false, true])("preserves a push during the initial snapshot (new row: %s)", async (newRow) => {
    const fake = installBridge();
    const snapshot = deferred<BridgeResult<RunsListResult>>();
    const run = { ...base, id: newRow ? "new-run" : base.id };
    fake.script({
      "runs.list": () => snapshot.promise,
      "runs.get": () => ({ ok: true, result: { ...RUN_DETAILS[base.id]!, run, lastSeq: 19 } }),
    });
    h = harness();
    const hook = renderHook(() => useRuns("all"), { wrapper: h.Providers });
    await act(async () => {
      fake.notify(changed(run.id, "succeeded", 20));
    });
    await act(async () => {
      snapshot.resolve({ ok: true, result: { runs: newRow ? [] : [base], total: newRow ? 0 : 1, asOf: AS_OF } });
    });
    expect(hook.result.current.state).toMatchObject({
      phase: "ready",
      runs: [{ id: run.id, status: "succeeded" }],
      total: 1,
    });
    expect(fake.calls.filter((c) => c.method === "runs.list")).toHaveLength(1);
  });

  it("a delayed resolving read cannot replace a later terminal push or insert twice", async () => {
    const fake = installBridge();
    const resolution = deferred<BridgeResult<RunsGetResult>>();
    fake.script({
      "runs.list": () => ({ ok: true, result: { runs: [], total: 0, asOf: AS_OF } }),
      "runs.get": () => resolution.promise,
    });
    h = harness();
    const hook = renderHook(() => useRuns("all"), { wrapper: h.Providers });
    await waitFor(() => expect(hook.result.current.state.phase).toBe("ready"));
    await act(async () => {
      fake.notify(changed(base.id, "running", 20));
      fake.notify(changed(base.id, "succeeded", 21));
      resolution.resolve({ ok: true, result: { ...RUN_DETAILS[base.id]!, run: base, lastSeq: 19 } });
    });
    expect(hook.result.current.state).toMatchObject({ runs: [{ id: base.id, status: "succeeded" }], total: 1 });
    expect(fake.calls.filter((c) => c.method === "runs.get")).toHaveLength(1);
  });

  it("reconciles missed completion and input on reattachment while still visibly live", async () => {
    const fake = installBridge();
    h = harness();
    const runs = renderHook(() => useRuns("all"), { wrapper: h.Providers });
    const attention = renderHook(() => useAttention(), { wrapper: h.Providers });
    await waitFor(() => expect(attention.result.current.state.phase).toBe("ready"));
    const input = { ...INPUTS[0]!, id: "missed-input" };
    fake.script({
      "runs.list": (params) => ({
        ok: true,
        result: {
          runs: params.status ? [] : [{ ...base, status: "succeeded" }],
          total: params.status ? 0 : 1,
          asOf: AS_OF,
        },
      }),
      "inputs.list": () => ({ ok: true, result: { inputs: [input], waiting: 1, asOf: AS_OF } }),
    });
    await act(async () => {
      fake.connect({ ...fake.connection, state: "live", generation: 2 });
    });
    expect(runs.result.current.state).toMatchObject({ phase: "ready", runs: [{ status: "succeeded" }] });
    expect(attention.result.current.state).toMatchObject({
      phase: "ready",
      waits: [{ id: "missed-input" }],
      waiting: 1,
    });
  });

  it("does not resurrect an answered input from delayed initial or resolving reads", async () => {
    const fake = installBridge();
    const initial = deferred<BridgeResult<InputsListResult>>();
    const resolution = deferred<BridgeResult<InputsListResult>>();
    fake.script({ "inputs.list": (params) => (params.runId ? resolution.promise : initial.promise) });
    h = harness();
    const hook = renderHook(() => useAttention(), { wrapper: h.Providers });
    const input = INPUTS[0]!;
    await act(async () => {
      fake.notify({
        kind: "notification",
        method: "input.opened",
        params: {
          subscriptionId: "sub",
          runId: input.runId,
          stepRunId: input.stepRunId,
          requestId: input.id,
          seq: 20,
          at: AS_OF,
          kind: input.kind,
          question: input.question,
          options: input.options,
          nodeId: input.nodeId,
        },
      });
      fake.notify({
        kind: "notification",
        method: "input.answered",
        params: {
          subscriptionId: "sub",
          runId: input.runId,
          seq: 21,
          at: AS_OF,
          requestId: input.id,
          stepRunId: input.stepRunId,
          answer: "approve",
        },
      });
      initial.resolve({ ok: true, result: { inputs: [input], waiting: 1, asOf: AS_OF } });
      resolution.resolve({ ok: true, result: { inputs: [input], waiting: 1, asOf: AS_OF } });
    });
    expect(hook.result.current.state).toMatchObject({ phase: "ready", waits: [], waiting: 0 });
  });
  it("keeps a pending tree read through rerenders and overlays a newer run notification", async () => {
    const fake = installBridge();
    const resolution = deferred<BridgeResult<RunsGetResult>>();
    fake.script({ "runs.get": () => resolution.promise });
    h = harness();
    const hook = renderHook(({ roots }) => useRunTree(roots), {
      initialProps: { roots: [base] },
      wrapper: h.Providers,
    });
    await act(async () => {
      hook.result.current.ensure(base.id);
    });
    hook.rerender({ roots: [{ ...base, name: "Changed while reading" }] });
    await act(async () => {
      fake.notify(changed(base.id, "succeeded", 99));
      resolution.resolve({ ok: true, result: { ...RUN_DETAILS[base.id]!, run: base, lastSeq: 19 } });
    });
    expect(hook.result.current.detailOf(base.id)?.run.status).toBe("succeeded");
    expect(fake.calls.filter((c) => c.method === "runs.get")).toHaveLength(1);
  });
  it.each([false, true])(
    "preserves completion and newly opened input during Attention reads (reattachment: %s)",
    async (reconnect) => {
      const fake = installBridge();
      h = harness();
      const initialInputs = deferred<BridgeResult<InputsListResult>>();
      const initialRuns = deferred<BridgeResult<RunsListResult>>();
      const input = { ...INPUTS[0]!, id: "opened-during-read" };
      const configureReads = () =>
        fake.script({
          "inputs.list": (params) =>
            params.runId ? { ok: true, result: { inputs: [input], waiting: 1, asOf: AS_OF } } : initialInputs.promise,
          "runs.list": (params) =>
            params.status?.includes("running")
              ? initialRuns.promise
              : { ok: true, result: { runs: [], total: 0, asOf: AS_OF } },
        });
      if (!reconnect) configureReads();
      const hook = renderHook(() => useAttention(), { wrapper: h.Providers });
      if (reconnect) {
        await waitFor(() => expect(hook.result.current.state.phase).toBe("ready"));
        configureReads();
        await act(async () => {
          fake.connect({ ...fake.connection, generation: 2 });
        });
      }
      expect(hook.result.current.state.phase).toBe("loading");
      await act(async () => {
        fake.notify(changed(base.id, "succeeded", 100));
        fake.notify({
          kind: "notification",
          method: "input.opened",
          params: {
            subscriptionId: "sub",
            runId: input.runId,
            stepRunId: input.stepRunId,
            requestId: input.id,
            seq: 100,
            at: AS_OF,
            kind: input.kind,
            question: input.question,
            options: input.options,
          },
        });
      });
      // Resolve the old snapshots only after the scoped input read and completion push.
      await act(async () => {
        initialInputs.resolve({ ok: true, result: { inputs: [], waiting: 0, asOf: AS_OF } });
        initialRuns.resolve({ ok: true, result: { runs: [base], total: 1, asOf: AS_OF } });
      });
      expect(hook.result.current.state).toMatchObject({
        phase: "ready",
        running: [],
        waits: [{ id: input.id }],
        waiting: 1,
      });
      expect(fake.calls.filter((call) => call.method === "runs.list")).toHaveLength(reconnect ? 4 : 2);
      expect(
        fake.calls.filter((call) => call.method === "inputs.list" && (call.params as { runId?: string }).runId),
      ).toHaveLength(1);
    },
  );

  it("a pending failed-run resolution cannot undo a newer completion in Attention", async () => {
    const fake = installBridge();
    const resolving = deferred<BridgeResult<RunsGetResult>>();
    fake.script({
      "runs.list": () => ({ ok: true, result: { runs: [], total: 0, asOf: AS_OF } }),
      "runs.get": () => resolving.promise,
    });
    h = harness();
    const hook = renderHook(() => useAttention(), { wrapper: h.Providers });
    await waitFor(() => expect(hook.result.current.state.phase).toBe("ready"));
    await act(async () => {
      fake.notify(changed(base.id, "failed", 100));
      fake.notify(changed(base.id, "succeeded", 101));
      resolving.resolve({
        ok: true,
        result: { ...RUN_DETAILS[base.id]!, run: { ...base, status: "failed" }, lastSeq: 100 },
      });
    });
    expect(hook.result.current.state).toMatchObject({ phase: "ready", failures: [], running: [] });
    expect(fake.calls.filter((call) => call.method === "runs.get")).toHaveLength(1);
  });
  it("does not replay a buffered transition already included by a newer tree snapshot", async () => {
    const fake = installBridge();
    const resolution = deferred<BridgeResult<RunsGetResult>>();
    fake.script({ "runs.get": () => resolution.promise });
    h = harness();
    const hook = renderHook(() => useRunTree([base]), { wrapper: h.Providers });
    await act(async () => {
      hook.result.current.ensure(base.id);
    });
    await act(async () => {
      fake.notify(changed(base.id, "running", 99));
      resolution.resolve({
        ok: true,
        result: { ...RUN_DETAILS[base.id]!, run: { ...base, status: "succeeded" }, lastSeq: 100 },
      });
    });
    expect(hook.result.current.detailOf(base.id)?.run.status).toBe("succeeded");
  });
  it("ignores older run and step pushes arriving after a newer tree read", async () => {
    const fake = installBridge();
    const detail = { ...RUN_DETAILS[base.id]!, run: { ...base, status: "succeeded" as const }, lastSeq: 100 };
    fake.script({ "runs.get": () => ({ ok: true, result: detail }) });
    h = harness();
    const hook = renderHook(() => useRunTree([base]), { wrapper: h.Providers });
    await act(async () => {
      hook.result.current.ensure(base.id);
    });
    await act(async () => {
      fake.notify(changed(base.id, "running", 99));
      fake.notify({
        kind: "notification",
        method: "step.changed",
        params: {
          subscriptionId: "sub",
          runId: base.id,
          seq: 98,
          at: AS_OF,
          stepRunId: detail.steps[0]!.id,
          status: "failed",
          event: "step.failed",
        },
      });
    });
    expect(hook.result.current.detailOf(base.id)).toEqual(detail);
  });

  it.each(["step", "generation"])("discards an earlier output page after the %s changes", async (switchBy) => {
    const fake = installBridge();
    const earlier = deferred<BridgeResult<RunsEventsResult>>();
    const event = (seq: number, stepRunId: string): RunsEventsResult["events"][number] => ({
      id: `event-${seq}`,
      runId: base.id,
      seq,
      at: AS_OF,
      type: "agent.update",
      payload: { stepRunId, sessionId: "session", update: { kind: "agent_message_chunk", text: `line ${seq}\n` } },
    });
    const first: RunsEventsResult = {
      events: [event(10, "old")],
      hasMore: true,
      lastSeq: 10,
      prevCursor: 10,
      asOf: AS_OF,
    };
    fake.script({ "runs.events": (params) => (params.before === 10 ? earlier.promise : { ok: true, result: first }) });
    h = harness();
    const hook = renderHook(({ step }) => useStepLog(base.id, step, { connection: "live" }), {
      initialProps: { step: "old" },
      wrapper: h.Providers,
    });
    await waitFor(() => expect(hook.result.current.phase).toBe("ready"));
    await act(async () => {
      hook.result.current.loadEarlier();
    });
    expect(hook.result.current.loadingEarlier).toBe(true);
    const step = switchBy === "step" ? "new" : "old";
    const current = event(20, step);
    fake.script({
      "runs.events": () => ({ ok: true, result: { events: [current], hasMore: false, lastSeq: 20, asOf: AS_OF } }),
    });
    await act(async () => {
      if (switchBy === "step") hook.rerender({ step });
      else fake.connect({ ...fake.connection, generation: 2 });
    });
    expect(hook.result.current.loadingEarlier).toBe(false);
    await act(async () => {
      earlier.resolve({ ok: true, result: { events: [event(1, "old")], hasMore: false, lastSeq: 10, asOf: AS_OF } });
    });
    expect(hook.result.current.events).toEqual([current]);
    expect(hook.result.current.earlierBefore).toBeUndefined();
    expect(hook.result.current.rows.filter((row) => row.kind === "line").map((row) => row.text)).toEqual(["line 20"]);
  });
  it.each([false, true])("preserves an agent push during a held snapshot (reattachment: %s)", async (reconnect) => {
    const fake = installBridge();
    const snapshot = deferred<BridgeResult<AgentsListResult>>();
    fake.script({ "agents.list": () => (reconnect ? { ok: true, result: AGENTS_LIST } : snapshot.promise) });
    h = harness();
    const hook = renderHook(() => useAgents(), { wrapper: h.Providers });
    if (reconnect) {
      await waitFor(() => expect(hook.result.current.state.phase).toBe("ready"));
      fake.script({ "agents.list": () => snapshot.promise });
      await act(async () => {
        fake.connect({ ...fake.connection, generation: 2 });
      });
    }
    const agent = { ...AGENTS_LIST.agents[0]!, state: "down" as const };
    await act(async () => {
      fake.notify({
        kind: "notification",
        method: "agent.changed",
        params: { subscriptionId: "sub", at: AS_OF, agent },
      });
      snapshot.resolve({ ok: true, result: AGENTS_LIST });
    });
    const state = hook.result.current.state;
    expect(state.phase).toBe("ready");
    if (state.phase === "ready") expect(state.agents.find((a) => a.id === agent.id)).toEqual(agent);
    expect(fake.calls.filter((c) => c.method === "agents.list")).toHaveLength(reconnect ? 2 : 1);
  });

  it.each([false, true])(
    "preserves timeline completion during a held snapshot (reattachment: %s)",
    async (reconnect) => {
      const fake = installBridge();
      const snapshot = deferred<BridgeResult<RunsEventsResult>>();
      const page: RunsEventsResult = { events: [], hasMore: false, lastSeq: 1, asOf: AS_OF };
      fake.script({ "runs.events": () => (reconnect ? { ok: true, result: page } : snapshot.promise) });
      h = harness();
      const hook = renderHook(() => useRunEvents(base.id, undefined), { wrapper: h.Providers });
      if (reconnect) {
        await waitFor(() => expect(hook.result.current.state.phase).toBe("ready"));
        fake.script({ "runs.events": () => snapshot.promise });
        await act(async () => {
          fake.connect({ ...fake.connection, generation: 2 });
        });
      }
      const event: RunsEventsResult["events"][number] = {
        id: "completion",
        runId: base.id,
        seq: 20,
        at: AS_OF,
        type: "run.completed",
        payload: { outcome: "success" },
      };
      await act(async () => {
        fake.notify({
          kind: "notification",
          method: "event.appended",
          params: { subscriptionId: "sub", runId: base.id, seq: 20, at: AS_OF, event },
        });
        snapshot.resolve({ ok: true, result: page });
      });
      expect(hook.result.current.state).toMatchObject({ phase: "ready", lastSeq: 20, entries: [{ seq: 20 }] });
      expect(fake.calls.filter((c) => c.method === "runs.events")).toHaveLength(reconnect ? 2 : 1);
    },
  );

  it("discards a timeline page from before reattachment", async () => {
    const fake = installBridge();
    const earlier = deferred<BridgeResult<RunsEventsResult>>();
    const event = (seq: number): RunsEventsResult["events"][number] => ({
      id: `event-${seq}`,
      runId: base.id,
      seq,
      at: AS_OF,
      type: "run.completed",
      payload: { outcome: "success" },
    });
    fake.script({
      "runs.events": (params) =>
        params.before === 10
          ? earlier.promise
          : {
              ok: true,
              result: { events: [event(10)], hasMore: true, lastSeq: 10, asOf: AS_OF },
            },
    });
    h = harness();
    const hook = renderHook(() => useRunEvents(base.id, undefined), { wrapper: h.Providers });
    await waitFor(() => expect(hook.result.current.state.phase).toBe("ready"));
    await act(async () => {
      hook.result.current.loadEarlier();
    });
    fake.script({
      "runs.events": () => ({ ok: true, result: { events: [event(20)], hasMore: false, lastSeq: 20, asOf: AS_OF } }),
    });
    await act(async () => {
      fake.connect({ ...fake.connection, generation: 2 });
    });
    await act(async () => {
      earlier.resolve({ ok: true, result: { events: [event(1)], hasMore: false, lastSeq: 10, asOf: AS_OF } });
    });
    expect(hook.result.current.state).toMatchObject({
      phase: "ready",
      entries: [{ seq: 20 }],
      lastSeq: 20,
      hasEarlier: false,
      loadingEarlier: false,
    });
  });
  it("retains step events and output received during its initial page read", async () => {
    const fake = installBridge();
    const snapshot = deferred<BridgeResult<RunsEventsResult>>();
    fake.script({ "runs.events": () => snapshot.promise });
    h = harness();
    const hook = renderHook(() => useStepLog(base.id, "step", { connection: "live" }), { wrapper: h.Providers });
    const event: RunsEventsResult["events"][number] = {
      id: "session",
      runId: base.id,
      seq: 20,
      at: AS_OF,
      type: "agent.session.opened",
      payload: { stepRunId: "step", sessionId: "session", agentId: "agent", hostId: "local", cwd: "/workspace" },
    };
    await act(async () => {
      fake.notify({
        kind: "notification",
        method: "event.appended",
        params: { subscriptionId: "sub", runId: base.id, seq: 20, at: AS_OF, event },
      });
      fake.notify({
        kind: "notification",
        method: "agent.update",
        params: {
          subscriptionId: "sub",
          runId: base.id,
          seq: 21,
          fromSeq: 21,
          at: AS_OF,
          stepRunId: "step",
          sessionId: "session",
          updates: [{ kind: "agent_message_chunk", text: "fresh output\n" }],
        },
      });
      snapshot.resolve({ ok: true, result: { events: [], hasMore: false, lastSeq: 10, asOf: AS_OF } });
    });
    expect(hook.result.current.events).toEqual([event]);
    expect(hook.result.current.rows.filter((row) => row.kind === "line").map((row) => row.text)).toEqual([
      "fresh output",
    ]);
    expect(fake.calls.filter((c) => c.method === "runs.events")).toHaveLength(1);
  });
});
