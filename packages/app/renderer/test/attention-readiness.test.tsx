// @vitest-environment happy-dom
/** Replays the engine/read-model ordering pinned by daemon/test/input-readiness.test.ts. */
import { afterEach, beforeEach, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { InputsListResult, NotificationMessage, OpenInputView } from "@orca/protocol";
import type { BridgeResult } from "../../src/bridge.js";
import { AttentionSurface } from "../src/attention/attention-surface.js";
import { useAttention, type AttentionFeed } from "../src/attention/use-attention.js";
import { FIVE_GATES, INPUTS_AS_OF } from "./fixtures-inputs.js";
import { harness, installBridge, stubMatchMedia, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

const gate = FIVE_GATES[0]!;
let fake: FakeBridge;
let h: Harness;
let dispose: () => void;
let feed: AttentionFeed;
let open: OpenInputView[];
const result = (inputs = open): BridgeResult<InputsListResult> => ({
  ok: true,
  result: { inputs: [...inputs], waiting: inputs.length, asOf: INPUTS_AS_OF },
});
const scopedCalls = () =>
  fake.calls.filter((call) => call.method === "inputs.list" && (call.params as { runId?: string }).runId !== undefined);
function App() {
  feed = useAttention();
  return <AttentionSurface connection="live" feed={feed} />;
}
async function mount() {
  await act(async () => {
    render(
      <h.Providers>
        <App />
      </h.Providers>,
    );
  });
  expect(feed.state.phase).toBe("ready");
}
function notification(method: string, params: Record<string, unknown>): NotificationMessage {
  return {
    kind: "notification",
    method,
    params: { subscriptionId: "sub", runId: gate.runId, at: INPUTS_AS_OF, ...params },
  };
}
function opened(input = gate, seq = 7) {
  fake.notify(
    notification("input.opened", {
      seq,
      runId: input.runId,
      stepRunId: input.stepRunId,
      requestId: input.id,
      kind: input.kind,
      question: input.question,
      options: input.options,
    }),
  );
}
function waiting(seq = 8, stepRunId = gate.stepRunId) {
  fake.notify(
    notification("step.changed", {
      seq,
      stepRunId,
      status: "waiting",
      event: "step.waiting",
      waitingOn: "human-input",
    }),
  );
}
function paused(seq = 9) {
  fake.notify(notification("run.changed", { seq, status: "waiting", event: "run.paused" }));
}
beforeEach(() => {
  stubMatchMedia(1440);
  fake = installBridge();
  dispose = fake.install();
  h = harness();
  open = [];
  fake.script({
    "inputs.list": () => result(),
    "runs.list": () => ({ ok: true, result: { runs: [], total: 0, asOf: INPUTS_AS_OF } }),
  });
});
afterEach(() => {
  cleanup();
  h.dispose();
  dispose();
});

it("resolves the same exact gate when declaration finishes after the input.opened read", async () => {
  await mount();
  await act(async () => opened());
  expect(scopedCalls()).toHaveLength(1);
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(0);
  expect(screen.queryByRole("region", { name: "gate, Ship release 1?" })).toBeNull();
  open = [gate];
  await act(async () => waiting());
  expect(scopedCalls()).toHaveLength(2);
  expect(screen.getByRole("region", { name: "gate, Ship release 1?" })).toBeTruthy();
  expect(
    feed.state.phase === "ready" && feed.state.waits.map((input) => [input.runId, input.stepRunId, input.id]),
  ).toEqual([[gate.runId, gate.stepRunId, gate.id]]);
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(1);
  await act(async () => {
    waiting();
    paused();
    opened();
  });
  expect(scopedCalls()).toHaveLength(2);
});

it("coalesces readiness arriving during an early empty read into one follow-on read", async () => {
  await mount();
  let finish!: (value: BridgeResult<InputsListResult>) => void;
  const old = result([]);
  fake.script({
    "inputs.list": () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await act(async () => opened());
  open = [gate];
  fake.script({ "inputs.list": () => result() });
  await act(async () => {
    waiting();
    paused();
  });
  expect(scopedCalls()).toHaveLength(1);
  await act(async () => finish(old));
  expect(scopedCalls()).toHaveLength(2);
  expect(screen.getByRole("region", { name: "gate, Ship release 1?" })).toBeTruthy();
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(1);
});

it("uses a distinct paused readiness event but never polls an unresolved request", async () => {
  await mount();
  await act(async () => opened());
  await act(async () => waiting(8, "unrelated-step"));
  expect(scopedCalls()).toHaveLength(1);
  await act(async () => waiting());
  expect(scopedCalls()).toHaveLength(2);
  await act(async () => waiting());
  expect(scopedCalls()).toHaveLength(2);
  open = [gate];
  await act(async () => paused());
  expect(scopedCalls()).toHaveLength(3);
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(1);
});

it("does not resurrect an answered input from a late read or a later readiness event", async () => {
  await mount();
  let finish!: (value: BridgeResult<InputsListResult>) => void;
  fake.script({
    "inputs.list": () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await act(async () => opened());
  await act(async () => {
    fake.notify(
      notification("input.answered", { seq: 8, stepRunId: gate.stepRunId, requestId: gate.id, answer: "approve" }),
    );
    waiting(9);
    paused(10);
    finish(result([gate]));
  });
  expect(scopedCalls()).toHaveLength(1);
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(0);
  expect(screen.queryByRole("region", { name: "gate, Ship release 1?" })).toBeNull();
});

it("reconciles on reconnect and drops the old connection's in-flight request", async () => {
  await mount();
  let finish!: (value: BridgeResult<InputsListResult>) => void;
  fake.script({
    "inputs.list": () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await act(async () => opened());
  fake.script({ "inputs.list": () => result() });
  await act(async () =>
    fake.connect({ state: "live", since: INPUTS_AS_OF, generation: 2, capabilities: ["runs.read", "runs.control"] }),
  );
  await act(async () => finish(result([gate])));
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(0);
  expect(screen.queryByRole("region", { name: "gate, Ship release 1?" })).toBeNull();
  open = [gate];
  await act(async () => opened());
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(1);
});

it("shows a second run's same-question gate without reviving the first answered request", async () => {
  open = [gate];
  await mount();
  await act(async () =>
    fake.notify(
      notification("input.answered", { seq: 7, stepRunId: gate.stepRunId, requestId: gate.id, answer: "approve" }),
    ),
  );
  open = [];
  const next = { ...gate, id: "next-request", runId: "next-run", stepRunId: "next-step" };
  await act(async () => opened(next));
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(0);
  open = [next];
  await act(async () =>
    fake.notify(
      notification("step.changed", {
        seq: 8,
        runId: next.runId,
        stepRunId: next.stepRunId,
        status: "waiting",
        event: "step.waiting",
        waitingOn: "human-input",
      }),
    ),
  );
  expect(screen.getByRole("region", { name: "gate, Ship release 1?" })).toBeTruthy();
  expect(feed.state.phase === "ready" && feed.state.waits.map((input) => input.id)).toEqual([next.id]);
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(1);
  expect(scopedCalls().map((call) => call.params)).toEqual([{ runId: next.runId }, { runId: next.runId }]);
});

it("retains a new ask that opens while another request's scoped read is in flight", async () => {
  await mount();
  let finish!: (value: BridgeResult<InputsListResult>) => void;
  fake.script({
    "inputs.list": () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await act(async () => opened());
  const next = { ...FIVE_GATES[1]!, runId: gate.runId };
  open = [gate, next];
  fake.script({ "inputs.list": () => result() });
  await act(async () => opened(next, 8));
  expect(scopedCalls()).toHaveLength(1);
  await act(async () => finish(result([gate])));
  expect(scopedCalls()).toHaveLength(2);
  expect(feed.state.phase === "ready" && feed.state.waits.map((input) => input.id)).toEqual([gate.id, next.id]);
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(2);
});
