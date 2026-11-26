// @vitest-environment happy-dom
/**
 * #1213: Attention's count must be the daemon's, the same one Machines shows. A fold that
 * missed an ask (an early empty scoped read and no readiness after it) or kept one a run
 * closed without `input.answered` is put right by one full `inputs.list` after the change.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { InputsListResult, NotificationMessage, OpenInputView } from "@orca/protocol";
import type { BridgeResult } from "../../src/bridge.js";
import { AttentionSurface } from "../src/attention/attention-surface.js";
import { RECONCILE_MS, useAttention, type AttentionFeed } from "../src/attention/use-attention.js";
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
const fullCalls = () =>
  fake.calls.filter(
    (call) =>
      call.method === "inputs.list" &&
      (call.params as { runId?: string } | undefined)?.runId === undefined &&
      !(call.params as { revisionRunIds?: unknown } | undefined)?.revisionRunIds,
  );
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, RECONCILE_MS + 50)));
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

it("shows an ask the fold missed once the reconcile reads the daemon's list", async () => {
  await mount();
  const before = fullCalls().length;
  // The scoped read comes back empty: the ask is not readable yet, and no readiness follows.
  await act(async () => opened());
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(0);
  open = [gate];
  await settle();
  expect(fullCalls()).toHaveLength(before + 1);
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(1);
  expect(screen.getByRole("region", { name: "gate, Ship release 1?" })).toBeTruthy();
});

it("drops an ask whose run ended without input.answered", async () => {
  open = [gate];
  await mount();
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(1);
  open = [];
  await act(async () =>
    fake.notify(notification("run.changed", { seq: 20, status: "cancelled", event: "run.cancelled" })),
  );
  await settle();
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(0);
  expect(screen.queryByRole("region", { name: "gate, Ship release 1?" })).toBeNull();
});

it("coalesces a burst of changes into one reconcile and keeps an answer made meanwhile", async () => {
  open = [gate];
  await mount();
  const before = fullCalls().length;
  await act(async () => {
    for (let seq = 10; seq < 20; seq++) waiting(seq);
    paused(20);
  });
  // Answered here before the daemon's list catches up: the read may still list it.
  await act(async () => feed.answered(gate.id));
  await settle();
  expect(fullCalls()).toHaveLength(before + 1);
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(0);
});
