// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JSX } from "react";
import type { InputsListResult, LiveDecisionTarget, OpenInputView } from "@orca/protocol";
import type { BridgeResult } from "../../src/bridge.js";
import { InlineAsksProvider, StepAsks } from "../src/attention/inline-asks.js";
import { useAttention } from "../src/attention/use-attention.js";
import { harness, installBridge, renderChrome, stubMatchMedia, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";
import { FIVE_GATES, INPUTS_AS_OF, PERMISSION_ASK } from "./fixtures-inputs.js";
const target: LiveDecisionTarget = {
  instanceId: "boot",
  sessionId: "session",
  turnId: "turn",
  invocationId: "invocation",
  runId: PERMISSION_ASK.runId,
  stepRunId: PERMISSION_ASK.stepRunId,
  requestId: PERMISSION_ASK.id,
};
const permission: OpenInputView = { ...PERMISSION_ASK, live: { target, state: "pending" } };
const gate = FIVE_GATES[0]!;
let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];
beforeEach(() => {
  stubMatchMedia(1440);
  fake = installBridge();
  teardown.push(fake.install());
  h = harness();
  teardown.push(h.dispose);
});
afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});
const result = (inputs: OpenInputView[]): BridgeResult<InputsListResult> => ({
  ok: true,
  result: { inputs, waiting: inputs.length, asOf: INPUTS_AS_OF },
});
const serve = (inputs: OpenInputView[]) => fake.script({ "inputs.list": () => result(inputs) });
function invalidate(identity = target) {
  fake.notify({
    kind: "notification",
    method: "input.invalidated",
    params: { subscriptionId: "sub", runId: identity.runId, target: identity, at: INPUTS_AS_OF },
  });
}
function Inline(): JSX.Element {
  const feed = useAttention();
  return (
    <InlineAsksProvider feed={feed}>
      <StepAsks runId={permission.runId} stepRunId={permission.stepRunId} />
      <StepAsks runId={gate.runId} stepRunId={gate.stepRunId} />
    </InlineAsksProvider>
  );
}
function mount(placement: "inbox" | "inline") {
  if (placement === "inbox") renderChrome(h);
  else
    render(
      <h.Providers>
        <Inline />
      </h.Providers>,
    );
}
const card = () => screen.findByRole("region", { name: /Run a shell command\?$/ });
const answer = (element: HTMLElement) => within(element).getByRole("button", { name: /^Answer/ });
it.each(["inbox", "inline"] as const)(
  "disables %s permission controls on a live push while durable gates stay answerable",
  async (placement) => {
    serve([permission, gate]);
    mount(placement);
    const ask = await card();
    expect(answer(ask).getAttribute("aria-disabled")).not.toBe("true");
    act(() => invalidate());
    await waitFor(() => expect(answer(ask).getAttribute("aria-disabled")).toBe("true"));
    expect(answer(ask).getAttribute("title")).toContain("expired");
    const always = within(ask).getByRole("button", { name: "Always allow" });
    expect(always.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(answer(ask));
    fireEvent.click(always);
    fireEvent.keyDown(ask, { key: "Enter", code: "Enter" });
    expect(answer(screen.getByRole("region", { name: /Ship release 1\?$/ })).getAttribute("aria-disabled")).not.toBe(
      "true",
    );
    expect(fake.calls.filter((call) => call.method === "inputs.list")).toHaveLength(1);
    expect(fake.calls.filter((call) => ["inputs.answer", "runs.cancel", "runs.resume"].includes(call.method))).toEqual(
      [],
    );
    expect(fake.connection.state).toBe("live");
  },
);
it.each(["instanceId", "sessionId", "turnId", "invocationId", "runId", "stepRunId", "requestId"] as const)(
  "does not invalidate a replacement with a different %s",
  async (key) => {
    serve([permission]);
    mount("inbox");
    const ask = await card();
    act(() => invalidate({ ...target, [key]: "old" }));
    expect(answer(ask).getAttribute("aria-disabled")).not.toBe("true");
    act(() => invalidate());
    await waitFor(() => expect(answer(ask).getAttribute("aria-disabled")).toBe("true"));
  },
);
it("keeps expiration over a stale initial snapshot that completes after the push", async () => {
  let finish!: (value: BridgeResult<InputsListResult>) => void;
  fake.script({
    "inputs.list": () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  mount("inbox");
  await waitFor(() => expect(finish).toBeDefined());
  act(() => invalidate());
  await act(async () => {
    finish(result([permission, gate]));
  });
  expect(answer(await card()).getAttribute("aria-disabled")).toBe("true");
  expect(answer(screen.getByRole("region", { name: /Ship release 1\?$/ })).getAttribute("aria-disabled")).not.toBe(
    "true",
  );
});
it("keeps expiration over a stale scoped read started by input.opened", async () => {
  serve([]);
  mount("inbox");
  await screen.findByText("Nothing needs you");
  let finish!: (value: BridgeResult<InputsListResult>) => void;
  fake.script({
    "inputs.list": () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  act(() =>
    fake.notify({
      kind: "notification",
      method: "input.opened",
      params: {
        subscriptionId: "sub",
        runId: target.runId,
        stepRunId: target.stepRunId,
        requestId: target.requestId,
        seq: 4,
        at: INPUTS_AS_OF,
        kind: "permission",
        question: permission.question,
        options: permission.options,
      },
    }),
  );
  await waitFor(() => expect(finish).toBeDefined());
  act(() => invalidate());
  await act(async () => {
    finish(result([permission]));
  });
  expect(answer(await card()).getAttribute("aria-disabled")).toBe("true");
  expect(fake.calls.filter((call) => call.method === "inputs.list")).toHaveLength(2);
});
it("ignores an old generation's read after reconnect and keeps the new turn answerable", async () => {
  let finishOld!: (value: BridgeResult<InputsListResult>) => void;
  fake.script({
    "inputs.list": () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  });
  mount("inbox");
  await waitFor(() => expect(finishOld).toBeDefined());
  act(() => invalidate());
  serve([
    {
      ...permission,
      live: { state: "pending", target: { ...target, instanceId: "new-boot", invocationId: "new-invocation" } },
    },
  ]);
  act(() => fake.connect({ ...fake.connection, generation: 1 }));
  const ask = await card();
  expect(answer(ask).getAttribute("aria-disabled")).not.toBe("true");
  await act(async () => {
    finishOld(result([permission]));
  });
  act(() => invalidate());
  expect(answer(ask).getAttribute("aria-disabled")).not.toBe("true");
  expect(fake.calls.filter((call) => call.method === "inputs.list")).toHaveLength(2);
});
