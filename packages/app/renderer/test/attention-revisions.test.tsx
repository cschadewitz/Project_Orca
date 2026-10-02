// @vitest-environment happy-dom
/** Mounted correction flows use only server identities, with no contribution to unanswered counts. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  OpenInputView,
  PendingRevisionSummary,
  PendingRevisionView,
  RevisionBoundaryView,
  RevisionResult,
} from "@orca/protocol";
import type { OrcaBridge } from "../../src/bridge.js";
import { AttentionSurface } from "../src/attention/attention-surface.js";
import { InlineAsksProvider, StepAsks } from "../src/attention/inline-asks.js";
import { useAttention, type AttentionFeed } from "../src/attention/use-attention.js";
import { useControls, type Controls } from "../src/attention/use-controls.js";
import { RUNS } from "./fixtures.js";
import { FIVE_GATES, INPUTS_AS_OF } from "./fixtures-inputs.js";
import { harness, installBridge, stubMatchMedia, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

const boundary: RevisionBoundaryView = {
  target: {
    runId: "run-1",
    stepRunId: "step-review",
    requestId: "gate-1",
    destinationId: "real-destination",
    expectedRevision: "v0",
  },
  destinationDescription: "Build agent, next declared attempt",
  capability: {
    actionId: "changes",
    destinationNodeId: "build",
    composition: "replace-revision-slot",
    payload: { kind: "text", maxBytes: 4096 },
  },
};
const gate: OpenInputView = {
  ...FIVE_GATES[0]!,
  stepRunId: boundary.target.stepRunId,
  revision: boundary,
  options: [
    { id: "changes", label: "Changes" },
    { id: "approve", label: "Approve" },
  ],
};
const target = { runId: "run-1", revisionId: "revision-1", destinationId: "real-destination", attemptId: "attempt-7" };
const summary: PendingRevisionSummary = { target, expectedRevision: "v1", state: "pending" };
const pending: PendingRevisionView = {
  ...summary,
  replacementAllowed: true,
  payload: { kind: "text", text: "Recorded correction text" },
  boundary,
};
const receipt: RevisionResult = {
  state: "resolved",
  operationId: "operation-1",
  replayed: false,
  result: {
    revisionId: target.revisionId,
    target: boundary.target,
    state: "pending",
    attemptId: target.attemptId,
    currentRevisionId: target.revisionId,
    expectedRevision: "v1",
  },
};
const methods = ["inputs.list", "inputs.answer", "inputs.revise", "inputs.replaceRevision", "inputs.revisionPending"];
let fake: FakeBridge;
let h: Harness;
let dispose: () => void;
let feed: AttentionFeed;
let controls: Controls;
let open: OpenInputView[];
let summaries: PendingRevisionSummary[];
let pendingRead: ReturnType<typeof vi.fn<NonNullable<OrcaBridge["inputs"]["revisionPending"]>>>;
let revise: ReturnType<typeof vi.fn<NonNullable<OrcaBridge["inputs"]["revise"]>>>;
let replace: ReturnType<typeof vi.fn<NonNullable<OrcaBridge["inputs"]["replaceRevision"]>>>;
function App({ inline = false }: { inline?: boolean }) {
  feed = useAttention();
  controls = useControls({ onAnswered: feed.answered });
  return inline ? (
    <InlineAsksProvider feed={feed}>
      <StepAsks runId="run-1" stepRunId="step-review" />
    </InlineAsksProvider>
  ) : (
    <AttentionSurface connection="live" feed={feed} />
  );
}
function mount(inline = false) {
  return render(
    <h.Providers>
      <App inline={inline} />
    </h.Providers>,
  );
}
function push(seq = 10) {
  act(() =>
    fake.notify({
      kind: "notification",
      method: "run.changed",
      params: {
        subscriptionId: "attention",
        at: INPUTS_AS_OF,
        event: "run.started",
        runId: "run-1",
        seq,
        status: "running",
      },
    }),
  );
}
beforeEach(() => {
  stubMatchMedia(1440);
  fake = installBridge({
    connection: {
      state: "live",
      since: INPUTS_AS_OF,
      generation: 1,
      capabilities: ["runs.read", "runs.control"],
      methods,
    },
  });
  dispose = fake.install();
  h = harness();
  open = [gate];
  summaries = [];
  fake.script({
    "runs.list": () => ({
      ok: true,
      result: { runs: [{ ...RUNS[0]!, id: "run-1", status: "running" }], total: 1, asOf: INPUTS_AS_OF },
    }),
    "inputs.list": () => ({
      ok: true,
      result: {
        inputs: open,
        waiting: open.length,
        asOf: INPUTS_AS_OF,
        pendingRevisions: { items: summaries, incomplete: false },
      },
    }),
  });
  pendingRead = vi.fn(async () => ({ ok: true as const, result: pending }));
  revise = vi.fn(async () => {
    open = [];
    summaries = [summary];
    return { ok: true as const, result: receipt };
  });
  replace = vi.fn(async () => ({ ok: true as const, result: receipt }));
  window.orca.inputs.revisionPending = pendingRead;
  window.orca.inputs.revise = revise;
  window.orca.inputs.replaceRevision = replace;
});
afterEach(() => {
  cleanup();
  h.dispose();
  dispose();
  vi.restoreAllMocks();
});

it("mounts the real revision boundary separately from ordinary options and notes", async () => {
  mount();
  const region = await screen.findByRole("region", { name: "gate, Ship release 1?" });
  expect(within(region).queryByRole("button", { name: /Changes/ })).toBeNull();
  expect(screen.getByText("Destination: Build agent, next declared attempt")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Fix only the declared attempt" } });
  fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await waitFor(() => expect(revise).toHaveBeenCalledOnce());
  expect(revise.mock.calls[0]![0]).toEqual({
    command: {
      target: boundary.target,
      actionId: "changes",
      payload: { kind: "text", text: "Fix only the declared attempt" },
    },
    retry: { idempotencyKey: expect.any(String) },
  });
  expect(fake.calls.some((call) => call.method === "inputs.answer")).toBe(false);
  await screen.findByRole("button", { name: "Replace pending correction" });
  expect(screen.queryByRole("region", { name: "gate, Ship release 1?" })).toBeNull();
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(0);
  expect(fake.alerts.at(-1)?.waiting).toBe(0);
  fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Better correction" } });
  fireEvent.click(screen.getByRole("button", { name: "Replace pending correction" }));
  await waitFor(() => expect(replace).toHaveBeenCalledOnce());
  expect(replace.mock.calls[0]![0].command).toEqual({
    target,
    expectedRevision: "v1",
    payload: { kind: "text", text: "Better correction" },
  });
  expect(fake.calls.some((call) => call.method === "inputs.answer")).toBe(false);
});

it("revision-only gates have no ordinary free-text path, digit, Enter, note, or shared-control bypass", async () => {
  open = [{ ...gate, options: [{ id: "changes", label: "Changes" }] }];
  mount();
  const region = await screen.findByRole("region", { name: "gate, Ship release 1?" });
  expect(within(region).queryByLabelText("Answer")).toBeNull();
  region.focus();
  fireEvent.keyDown(region, { key: "1", code: "Digit1" });
  fireEvent.keyDown(region, { key: "Enter", code: "Enter" });
  fireEvent.keyDown(region, { key: "Enter", code: "Enter", shiftKey: true });
  fireEvent.change(within(region).getByLabelText("Note"), { target: { value: "Not a correction" } });
  fireEvent.keyDown(within(region).getByLabelText("Note"), { key: "Enter" });
  act(() => controls.answer(open[0]!, { optionId: "changes", note: "Not a correction" }));
  expect(controls.report?.message).toContain("Use Request changes");
  expect(fake.calls.some((call) => call.method === "inputs.answer")).toBe(false);
  expect(revise).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps a declared revision action out of every ordinary path without a protected boundary (inline=%s)",
  async (inline) => {
    const { revision: _revision, ...restricted } = gate;
    open = [{ ...restricted, revisionActionId: "changes", options: [{ id: "changes", label: "Changes" }] }];
    mount(inline);
    const region = await screen.findByRole("region", { name: "gate, Ship release 1?" });
    expect(
      screen.getByText("Request changes is unavailable until the current revision boundary can be confirmed."),
    ).toBeTruthy();
    expect(within(region).queryByRole("button", { name: /Changes/ })).toBeNull();
    expect(within(region).queryByLabelText("Answer")).toBeNull();
    expect(screen.queryByLabelText("Correction")).toBeNull();
    expect(screen.queryByRole("button", { name: "Request changes" })).toBeNull();
    region.focus();
    fireEvent.keyDown(region, { key: "1", code: "Digit1" });
    fireEvent.keyDown(region, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(region, { key: "Enter", code: "Enter", shiftKey: true });
    if (inline) {
      // Inline cards do not own the run tree's keyboard scope.
      expect(within(region).queryByLabelText("Note")).toBeNull();
    } else {
      fireEvent.change(within(region).getByLabelText("Note"), { target: { value: "Not a correction" } });
      fireEvent.keyDown(within(region).getByLabelText("Note"), { key: "Enter" });
    }
    const answer = within(region).getByRole("button", { name: "Answer" });
    expect(answer.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(answer);
    act(() => controls.answer(open[0]!, { optionId: "changes", note: "Not a correction" }));
    expect(controls.report?.failed).toBe(true);
    expect(controls.report?.message).toContain("Use Request changes");
    expect(h.keyboard.list().some((shortcut) => shortcut.scope === "card" && shortcut.key === "1")).toBe(false);
    expect(fake.calls.some((call) => call.method === "inputs.answer")).toBe(false);
    expect(revise).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(feed.state.phase === "ready" && feed.state.waiting).toBe(1);
  },
);

it.each(["button", "keyboard"] as const)(
  "keeps the ordinary Continue option usable while revision authority is unavailable (%s)",
  async (via) => {
    const { revision: _revision, ...restricted } = gate;
    open = [
      {
        ...restricted,
        revisionActionId: "changes",
        options: [
          { id: "changes", label: "Changes" },
          { id: "continue", label: "Continue" },
        ],
      },
    ];
    mount();
    const region = await screen.findByRole("region", { name: "gate, Ship release 1?" });
    expect(within(region).queryByRole("button", { name: /Changes/ })).toBeNull();
    expect(within(region).getByRole("button", { name: /Continue$/ })).toBeTruthy();
    if (via === "button") {
      fireEvent.click(within(region).getByRole("button", { name: /Continue$/ }));
      fireEvent.click(within(region).getByRole("button", { name: "Answer" }));
    } else {
      region.focus();
      fireEvent.keyDown(region, { key: "1", code: "Digit1" });
      fireEvent.keyDown(region, { key: "Enter", code: "Enter" });
    }
    await waitFor(() => expect(fake.calls.filter((call) => call.method === "inputs.answer")).toHaveLength(1));
    expect(fake.calls.find((call) => call.method === "inputs.answer")?.params).toMatchObject({
      requestId: gate.id,
      runId: gate.runId,
      optionId: "continue",
    });
    expect(revise).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  },
);

it("keeps a gate resolved at step readiness restricted while its protected boundary is unavailable", async () => {
  open = [];
  mount();
  await waitFor(() => expect(feed.state.phase).toBe("ready"));
  await act(async () =>
    fake.notify({
      kind: "notification",
      method: "input.opened",
      params: {
        subscriptionId: "attention",
        at: INPUTS_AS_OF,
        seq: 7,
        runId: gate.runId,
        stepRunId: gate.stepRunId,
        requestId: gate.id,
        kind: gate.kind,
        question: gate.question,
        options: gate.options,
      },
    }),
  );
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(0);
  const { revision: _revision, ...restricted } = gate;
  open = [{ ...restricted, revisionActionId: "changes" }];
  await act(async () =>
    fake.notify({
      kind: "notification",
      method: "step.changed",
      params: {
        subscriptionId: "attention",
        at: INPUTS_AS_OF,
        seq: 8,
        runId: gate.runId,
        stepRunId: gate.stepRunId,
        status: "waiting",
        event: "step.waiting",
        waitingOn: "human-input",
      },
    }),
  );
  const region = screen.getByRole("region", { name: "gate, Ship release 1?" });
  expect(within(region).queryByRole("button", { name: /Changes/ })).toBeNull();
  expect(within(region).getByRole("button", { name: /Approve$/ })).toBeTruthy();
  expect(screen.queryByLabelText("Correction")).toBeNull();
  expect(
    screen.getByText("Request changes is unavailable until the current revision boundary can be confirmed."),
  ).toBeTruthy();
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(1);
  expect(fake.calls.some((call) => call.method === "inputs.answer")).toBe(false);
  expect(revise).not.toHaveBeenCalled();
});

it("hydrates closed-gate corrections after restart from only a bounded authorized run page", async () => {
  open = [];
  summaries = [summary];
  mount();
  await screen.findByRole("button", { name: "Replace pending correction" });
  expect(screen.getByText("Recorded correction text", { selector: "pre" })).toBeTruthy();
  expect(
    fake.calls.some((call) => call.method === "runs.list" && (call.params as { limit?: number }).limit === 20),
  ).toBe(true);
  const batches = fake.calls.filter(
    (call) =>
      call.method === "inputs.list" && (call.params as { revisionRunIds?: string[] } | undefined)?.revisionRunIds,
  );
  expect(batches.length).toBeGreaterThan(0);
  for (const call of batches)
    expect((call.params as { revisionRunIds: string[] }).revisionRunIds.length).toBeLessThanOrEqual(20);
  expect(pendingRead).toHaveBeenCalledWith({ target });
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(0);
  expect(revise).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

it("shares the same initial and closed-gate replacement forms inline", async () => {
  mount(true);
  await screen.findByLabelText("Correction");
  fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Inline correction" } });
  fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await screen.findByRole("button", { name: "Replace pending correction" });
  expect(screen.getByText("Recorded correction text", { selector: "pre" })).toBeTruthy();
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(0);
});

it("uses read-only summaries when the protected boundary or content is unavailable", async () => {
  open = [];
  summaries = [summary];
  pendingRead.mockResolvedValue({ ok: true, result: { ...summary, replacementAllowed: false } });
  mount();
  await screen.findByText("Correction content is unavailable.");
  expect(screen.queryByLabelText("Correction")).toBeNull();
  expect(screen.getByText("Destination: real-destination")).toBeTruthy();
  expect(screen.queryByText(/Build agent/)).toBeNull();
  expect(revise).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

it.each([
  ["delivered", "delivered", "The agent has already received"],
  ["rejected", "cancelled", "The run was cancelled"],
  ["superseded", "target-changed", "destination or active correction changed"],
  ["pending", "delivery-uncertain", "Delivery is not confirmed"],
] as const)("refreshes %s into an honest read-only summary", async (state, unavailableReason, message) => {
  open = [];
  summaries = [summary];
  mount();
  await screen.findByRole("button", { name: "Replace pending correction" });
  pendingRead.mockResolvedValue({
    ok: true,
    result: { ...summary, state, unavailableReason, replacementAllowed: false },
  });
  push();
  await screen.findByText(new RegExp(message, "i"));
  expect(screen.getByRole("button", { name: "Replace pending correction" }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.queryByText("Recorded correction text", { selector: "pre" })).toBeNull();
  expect(replace).not.toHaveBeenCalled();
});

it("keeps incomplete discovery and failed reads visible rather than saying there are no corrections", async () => {
  open = [];
  summaries = [summary];
  fake.script({
    "inputs.list": () => ({
      ok: true,
      result: {
        inputs: [],
        waiting: 0,
        asOf: INPUTS_AS_OF,
        pendingRevisions: { items: summaries, incomplete: true, reason: "boundary-unavailable" },
      },
    }),
  });
  pendingRead.mockResolvedValue({ ok: false, error: { code: "UNAUTHORIZED", message: "Denied" } });
  mount();
  await screen.findByText(/Only part of the pending correction list/);
  await screen.findByText(/current correction could not be confirmed/);
  expect(screen.getByText("Pending correction")).toBeTruthy();
  expect(screen.queryByLabelText("Correction")).toBeNull();
});

it("preserves a replacement draft through scoped refresh and requires explicit review for changed version", async () => {
  open = [];
  summaries = [summary];
  mount();
  await screen.findByRole("button", { name: "Replace pending correction" });
  fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Draft before refresh" } });
  pendingRead.mockResolvedValue({ ok: true, result: { ...pending, expectedRevision: "v2" } });
  push();
  await screen.findByRole("button", { name: "Use reviewed correction version" });
  expect(screen.getByLabelText<HTMLTextAreaElement>("Correction").value).toBe("Draft before refresh");
  expect(screen.getByRole("button", { name: "Replace pending correction" }).getAttribute("aria-disabled")).toBe("true");
  expect(replace).not.toHaveBeenCalled();
});

it("retains retry identity after response loss without automatically writing", async () => {
  revise.mockResolvedValue({ ok: false, error: { code: "RUN_STATE", message: "Uncertain response" } });
  mount();
  await screen.findByLabelText("Correction");
  fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Same logical correction" } });
  fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await screen.findByText(/draft and retry identity are preserved/);
  expect(revise).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await waitFor(() => expect(revise).toHaveBeenCalledTimes(2));
  expect(revise.mock.calls[0]![0].retry.idempotencyKey).toBe(revise.mock.calls[1]![0].retry.idempotencyKey);
});

it.each([false, true])("preserves a refused replacement draft when the run is leased (inline=%s)", async (inline) => {
  open = [];
  summaries = [summary];
  replace.mockResolvedValue({
    ok: false,
    error: { code: "RUN_LEASED", message: "Run already has an execution owner" },
  });
  const announce = vi.fn();
  const unsubscribe = h.announcements.subscribe(announce);
  mount(inline);
  await screen.findByRole("button", { name: "Replace pending correction" });
  fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Keep my refused replacement" } });
  fireEvent.click(screen.getByRole("button", { name: "Replace pending correction" }));
  await screen.findByText("The correction could not be confirmed. Your draft and retry identity are preserved.");
  expect(replace).toHaveBeenCalledOnce();
  expect(replace.mock.calls[0]![0]).toEqual({
    command: {
      target,
      expectedRevision: "v1",
      payload: { kind: "text", text: "Keep my refused replacement" },
    },
    retry: { idempotencyKey: expect.any(String) },
  });
  expect(screen.getByLabelText<HTMLTextAreaElement>("Correction").value).toBe("Keep my refused replacement");
  expect(screen.getByText("Recorded correction text", { selector: "pre" })).toBeTruthy();
  expect(screen.queryByText("Keep my refused replacement", { selector: "pre" })).toBeNull();
  expect(screen.queryByText(/It applies only to the displayed destination and attempt/)).toBeNull();
  expect(screen.queryByText(/Correction is being recorded/)).toBeNull();
  expect(announce.mock.calls).toEqual([["Correction not confirmed. Draft preserved."]]);
  expect(feed.revisions?.items).toHaveLength(1);
  expect(feed.revisions?.items[0]?.pending).toEqual(pending);
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(0);
  expect(revise).not.toHaveBeenCalled();
  expect(fake.calls.some((call) => call.method === "inputs.answer")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Replace pending correction" }));
  await waitFor(() => expect(announce).toHaveBeenCalledTimes(2));
  expect(replace).toHaveBeenCalledTimes(2);
  expect(replace.mock.calls[1]![0]).toEqual(replace.mock.calls[0]![0]);
  expect(screen.getByLabelText<HTMLTextAreaElement>("Correction").value).toBe("Keep my refused replacement");
  unsubscribe();
});

it("removes protected content after denial and ignores a late pending response across a connection epoch", async () => {
  open = [];
  summaries = [summary];
  mount();
  await screen.findByRole("button", { name: "Replace pending correction" });
  pendingRead.mockResolvedValueOnce({ ok: false, error: { code: "UNAUTHORIZED", message: "Revoked" } });
  push();
  await screen.findByText(/current correction could not be confirmed/);
  expect(screen.queryByText("Recorded correction text", { selector: "pre" })).toBeNull();
  let finish!: (value: Awaited<ReturnType<NonNullable<OrcaBridge["inputs"]["revisionPending"]>>>) => void;
  pendingRead.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  push(11);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  summaries = [];
  act(() =>
    fake.connect({
      state: "live",
      since: INPUTS_AS_OF,
      generation: 2,
      capabilities: ["runs.read"],
      methods: ["inputs.list"],
    }),
  );
  await act(async () => {
    finish({ ok: true, result: pending });
  });
  expect(screen.queryByText("Recorded correction text", { selector: "pre" })).toBeNull();
  expect(screen.queryByLabelText("Correction")).toBeNull();
  expect(replace).not.toHaveBeenCalled();
});

it("does not advertise correction writes when the service was not negotiated", async () => {
  fake.connect({ state: "live", since: INPUTS_AS_OF, generation: 1, capabilities: ["runs.read", "runs.control"] });
  mount();
  await screen.findByText("Request changes is unavailable on this connection.");
  expect(screen.queryByLabelText("Correction")).toBeNull();
  expect(pendingRead).not.toHaveBeenCalled();
});

it.each([false, true])(
  "preserves the draft while another client replaces the same attempt (inline=%s)",
  async (inline) => {
    open = [];
    summaries = [summary];
    mount(inline);
    await screen.findByRole("button", { name: "Replace pending correction" });
    fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "My unsent correction" } });
    const next = { ...summary, target: { ...target, revisionId: "revision-2" }, expectedRevision: "v2" };
    summaries = [next];
    pendingRead.mockImplementation(async ({ target: requested }) => ({
      ok: true,
      result:
        requested.revisionId === "revision-2"
          ? { ...pending, ...next, payload: { kind: "text", text: "Another client's correction" } }
          : { ...summary, state: "superseded", unavailableReason: "target-changed", replacementAllowed: false },
    }));
    push();
    await screen.findByText("Another client's correction", { selector: "pre" });
    expect(screen.getAllByLabelText("Correction")).toHaveLength(1);
    expect(screen.getByLabelText<HTMLTextAreaElement>("Correction").value).toBe("My unsent correction");
    expect(screen.getByRole("button", { name: "Replace pending correction" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use reviewed correction version" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace pending correction" }));
    await waitFor(() => expect(replace).toHaveBeenCalledOnce());
    expect(replace.mock.calls[0]![0].command).toEqual({
      target: next.target,
      expectedRevision: "v2",
      payload: { kind: "text", text: "My unsent correction" },
    });
  },
);

it.each([false, true])("retains and disables a draft through a failed refresh (inline=%s)", async (inline) => {
  open = [];
  summaries = [summary];
  mount(inline);
  await screen.findByRole("button", { name: "Replace pending correction" });
  fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Keep this unsent draft" } });
  pendingRead.mockRejectedValue(new Error("Transport response lost"));
  push();
  await screen.findByText(/current correction could not be confirmed/);
  expect(screen.getByLabelText<HTMLTextAreaElement>("Correction").value).toBe("Keep this unsent draft");
  expect(screen.queryByText("Recorded correction text", { selector: "pre" })).toBeNull();
  expect(screen.getByRole("button", { name: "Replace pending correction" }).getAttribute("aria-disabled")).toBe("true");
  expect(replace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Discard correction draft" }));
  expect(screen.queryByLabelText("Correction")).toBeNull();
  expect(screen.getByText("Pending correction")).toBeTruthy();
});

it("ignores a late successful mutation after a connection switch and clears the old draft", async () => {
  let finish!: (value: Awaited<ReturnType<NonNullable<OrcaBridge["inputs"]["revise"]>>>) => void;
  revise.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mount();
  await screen.findByLabelText("Correction");
  fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Old connection draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await waitFor(() => expect(revise).toHaveBeenCalledOnce());
  act(() =>
    fake.connect({
      state: "live",
      since: INPUTS_AS_OF,
      generation: 2,
      capabilities: ["runs.read", "runs.control"],
      methods,
    }),
  );
  await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>("Correction").value).toBe(""));
  await act(async () => {
    finish({ ok: true, result: receipt });
  });
  expect(feed.state.phase === "ready" && feed.state.waiting).toBe(1);
  expect(feed.revisions?.items).toHaveLength(0);
  expect(replace).not.toHaveBeenCalled();
});

it("prioritizes the bounded active run page and makes truncated coverage explicit", async () => {
  open = [];
  summaries = [summary];
  fake.script({
    "runs.list": (params) => ({
      ok: true,
      result: {
        runs: params.limit === 20 ? [{ ...RUNS[0]!, id: "run-1", status: "held" }] : [],
        total: params.limit === 20 ? 35 : 0,
        asOf: INPUTS_AS_OF,
      },
    }),
  });
  mount();
  await screen.findByRole("button", { name: "Replace pending correction" });
  await screen.findByText(/Only the loaded active or paused run page is covered/);
  const pages = fake.calls.filter(
    (call) => call.method === "runs.list" && (call.params as { limit?: number }).limit === 20,
  );
  expect(pages).toHaveLength(1);
  expect(pages[0]!.params).toMatchObject({ status: ["running", "waiting", "held", "blocked", "stale", "failed"] });
  expect(
    fake.calls.some((call) => call.method === "runs.list" && (call.params as { offset?: number }).offset !== undefined),
  ).toBe(false);
});

it("does not attribute an unprivileged summary to an invented inline step", async () => {
  open = [];
  summaries = [summary];
  pendingRead.mockResolvedValue({ ok: true, result: { ...summary, replacementAllowed: false } });
  const view = mount(true);
  await waitFor(() => expect(pendingRead).toHaveBeenCalled());
  await waitFor(() => expect(feed.revisions?.items[0]?.reading).toBe(false));
  expect(view.container.textContent).toBe("");
  expect(feed.revisions?.items[0]?.stepRunId).toBeUndefined();
});

it("uses the projected correction limit rather than a client default", async () => {
  open = [
    {
      ...gate,
      revision: { ...boundary, capability: { ...boundary.capability, payload: { kind: "text", maxBytes: 3 } } },
    },
  ];
  mount();
  await screen.findByLabelText("Correction");
  fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Longer than three bytes" } });
  fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
  await screen.findByText("The correction exceeds the workflow limit.");
  expect(revise).not.toHaveBeenCalled();
});

it("retains known metadata on discovery failure and retries only when explicitly refreshed", async () => {
  open = [];
  summaries = [summary];
  mount();
  await screen.findByRole("button", { name: "Replace pending correction" });
  fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Keep through list failure" } });
  fake.fail("inputs.list", { code: "RUN_STATE", message: "Boundary temporarily unavailable" });
  push();
  await screen.findByText(/Their absence is not confirmed\.$/);
  expect(feed.revisions?.items).toHaveLength(1);
  expect(screen.getByLabelText<HTMLTextAreaElement>("Correction").value).toBe("Keep through list failure");
  expect(screen.getByRole("button", { name: "Replace pending correction" }).getAttribute("aria-disabled")).toBe("true");
  expect(replace).not.toHaveBeenCalled();
});

it("does not redirect an old scoped callback onto a new connection with matching target IDs", async () => {
  mount();
  await screen.findByLabelText("Correction");
  const oldSubmit = feed.revisions!.submit;
  const oldReplace = feed.revisions!.replace;
  const oldScope = feed.revisions!.scope;
  act(() =>
    fake.connect({
      state: "live",
      since: INPUTS_AS_OF,
      generation: 2,
      capabilities: ["runs.read", "runs.control"],
      methods,
    }),
  );
  await waitFor(() => expect(feed.revisions!.scope).not.toBe(oldScope));
  await expect(
    oldSubmit(
      { target: boundary.target, actionId: "changes", payload: { kind: "text", text: "Old intent" } },
      "old-key",
    ),
  ).rejects.toThrow(/unavailable/);
  await expect(
    oldReplace({ target, expectedRevision: "v1", payload: { kind: "text", text: "Old replacement" } }, "old-key"),
  ).rejects.toThrow(/unavailable/);
  expect(revise).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});
