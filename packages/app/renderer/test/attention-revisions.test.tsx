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
import { RUNS, EVENTS } from "./fixtures.js";
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
function App({ inline = false, stepRunId = "step-review" }: { inline?: boolean; stepRunId?: string }) {
  feed = useAttention();
  controls = useControls({ onAnswered: feed.answered });
  return inline ? (
    <InlineAsksProvider feed={feed}>
      <StepAsks runId="run-1" stepRunId={stepRunId} />
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
function push(seq = 10, runId = "run-1") {
  act(() =>
    fake.notify({
      kind: "notification",
      method: "run.changed",
      params: {
        subscriptionId: "attention",
        at: INPUTS_AS_OF,
        event: "run.started",
        runId,
        seq,
        status: "running",
      },
    }),
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    "runs.events": (params) => ({
      ok: true as const,
      result: {
        events: [{ ...EVENTS["run-parent"]![0]!, runId: params.runId }],
        hasMore: false,
        lastSeq: 20,
        asOf: INPUTS_AS_OF,
      },
    }),
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

it.each(["receipt", "notification"])(
  "serializes an accepted correction with concurrent discovery when the %s arrives first",
  async (first) => {
    mount();
    await screen.findByLabelText("Correction");
    await act(async () => {});
    const result = deferred<Awaited<ReturnType<NonNullable<OrcaBridge["inputs"]["revise"]>>>>();
    const heldRead = deferred<void>();
    let holdNext = true;
    let leased = false;
    const started: string[] = [];
    const collisions: string[] = [];
    const list = window.orca.inputs.list;
    window.orca.inputs.list = async (params) => {
      if (!params?.revisionRunIds?.length) return list(params);
      started.push("discovery");
      if (leased) {
        collisions.push("discovery");
        return {
          ok: true,
          result: {
            inputs: [],
            waiting: 0,
            asOf: INPUTS_AS_OF,
            pendingRevisions: { items: [], incomplete: true, reason: "boundary-unavailable" },
          },
        };
      }
      leased = true;
      try {
        if (holdNext) {
          holdNext = false;
          await heldRead.promise;
        }
        return await list(params);
      } finally {
        leased = false;
      }
    };
    pendingRead.mockImplementation(async () => {
      started.push("pending");
      if (leased) {
        collisions.push("pending");
        return { ok: false, error: { code: "RUN_LEASED", message: "The protected read owns the run" } };
      }
      leased = true;
      try {
        if (holdNext) {
          holdNext = false;
          await heldRead.promise;
        }
        return { ok: true, result: pending };
      } finally {
        leased = false;
      }
    });
    revise.mockImplementation(() => result.promise);
    fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Unconfirmed receipt payload" } });
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    open = [];
    summaries = [summary];
    if (first === "notification") {
      push();
      await waitFor(() => expect(started).toHaveLength(1));
    }
    await act(async () => result.resolve({ ok: true, result: receipt }));
    push(11);
    push(12);
    await act(async () => {});
    // An accepted receipt only supplies identity. Content still requires the protected read.
    expect(screen.queryByText("Unconfirmed receipt payload", { selector: "pre" })).toBeNull();
    expect(screen.queryByText("Recorded correction text", { selector: "pre" })).toBeNull();
    expect(feed.state.phase === "ready" && feed.state.waiting).toBe(0);
    await act(async () => heldRead.resolve());
    expect(collisions).toEqual([]);
    await screen.findByText("Recorded correction text", { selector: "pre" });
    expect(started).toEqual(["discovery", "discovery", "pending"]);
    expect(feed.revisions?.items[0]?.summary).toEqual(summary);
    expect(revise).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  },
);

it.each(["RUN_LEASED", "rejected"])(
  "keeps accepted metadata honest after a %s protected read until explicit refresh",
  async (failure) => {
    mount();
    await screen.findByLabelText("Correction");
    await act(async () => {});
    let incomplete = true;
    fake.script({
      "inputs.list": () => ({
        ok: true,
        result: {
          inputs: open,
          waiting: open.length,
          asOf: INPUTS_AS_OF,
          pendingRevisions: incomplete
            ? { items: [], incomplete: true, reason: "boundary-unavailable" }
            : { items: summaries, incomplete: false },
        },
      }),
    });
    if (failure === "RUN_LEASED")
      pendingRead.mockResolvedValue({
        ok: false,
        error: { code: "RUN_LEASED", message: "Another client owns the run" },
      });
    else pendingRead.mockRejectedValue(new Error("Read transport failed"));
    fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Accepted but unread payload" } });
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    await screen.findByText(/current correction could not be confirmed/);
    await screen.findByText(/Only part of the pending correction list/);
    expect(feed.revisions?.items[0]?.summary).toEqual(summary);
    expect(feed.revisions?.items[0]?.pending).toBeUndefined();
    expect(pendingRead).toHaveBeenCalledExactlyOnceWith({ target });
    expect(screen.queryByText("Accepted but unread payload", { selector: "pre" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace pending correction" })).toBeNull();
    pendingRead.mockResolvedValue({ ok: true, result: pending });
    incomplete = false;
    await act(async () => {});
    expect(pendingRead).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Refresh correction" }));
    await screen.findByText("Recorded correction text", { selector: "pre" });
    expect(pendingRead).toHaveBeenCalledTimes(2);
    expect(revise).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  },
);

it("inspects the accepted replacement identity when incomplete discovery omits the entire slot", async () => {
  open = [];
  summaries = [summary];
  mount();
  await screen.findByRole("button", { name: "Replace pending correction" });
  const next = { ...summary, target: { ...target, revisionId: "revision-2" }, expectedRevision: "v2" };
  if (receipt.state !== "resolved") throw new Error("The fixture must contain a resolved receipt");
  replace.mockResolvedValue({
    ok: true,
    result: {
      ...receipt,
      result: {
        ...receipt.result,
        revisionId: next.target.revisionId,
        currentRevisionId: next.target.revisionId,
        expectedRevision: next.expectedRevision,
      },
    },
  });
  fake.script({
    "inputs.list": () => ({
      ok: true,
      result: {
        inputs: [],
        waiting: 0,
        asOf: INPUTS_AS_OF,
        pendingRevisions: { items: [], incomplete: true, reason: "boundary-unavailable" },
      },
    }),
  });
  pendingRead.mockResolvedValue({
    ok: true,
    result: { ...pending, ...next, payload: { kind: "text", text: "Protected replacement content" } },
  });
  fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Replacement sent once" } });
  fireEvent.click(screen.getByRole("button", { name: "Replace pending correction" }));
  await screen.findByText("Protected replacement content", { selector: "pre" });
  expect(feed.revisions?.items).toHaveLength(1);
  expect(feed.revisions?.items[0]?.summary).toEqual(next);
  expect(pendingRead.mock.calls.map(([params]) => params.target)).toEqual([target, next.target]);
  expect(replace).toHaveBeenCalledOnce();
  expect(revise).not.toHaveBeenCalled();
});

it("serializes overlapping and disjoint discovery selections without mixing their current corrections", async () => {
  open = [];
  const second = { ...summary, target: { ...target, runId: "run-2", revisionId: "revision-2" } };
  const third = { ...summary, target: { ...target, runId: "run-3", revisionId: "revision-3" } };
  summaries = [summary, second, third];
  const leased = new Set<string>();
  const collisions: string[] = [];
  const started: string[][] = [];
  const heldRead = deferred<void>();
  let holdNext = false;
  let holding = false;
  fake.script({
    "runs.list": () => ({
      ok: true,
      result: {
        runs: ["run-1", "run-2"].map((id) => ({ ...RUNS[0]!, id, status: "running" as const })),
        total: 2,
        asOf: INPUTS_AS_OF,
      },
    }),
    "inputs.list": async (params) => {
      const runIds = params.revisionRunIds ?? [];
      if (runIds.length) started.push(runIds);
      for (const runId of runIds) {
        if (leased.has(runId)) collisions.push(runId);
        leased.add(runId);
      }
      await Promise.resolve();
      for (const runId of runIds) leased.delete(runId);
      return {
        ok: true,
        result: {
          inputs: [],
          waiting: 0,
          asOf: INPUTS_AS_OF,
          pendingRevisions: {
            items: summaries.filter((item) => runIds.includes(item.target.runId)),
            incomplete: false,
          },
        },
      };
    },
  });
  pendingRead.mockImplementation(async ({ target: requested }) => {
    if (leased.has(requested.runId)) collisions.push(requested.runId);
    leased.add(requested.runId);
    try {
      if (holdNext && requested.runId === "run-1") {
        holdNext = false;
        holding = true;
        await heldRead.promise;
      }
      return {
        ok: true,
        result: { ...pending, target: requested, payload: { kind: "text", text: `Correction for ${requested.runId}` } },
      };
    } finally {
      leased.delete(requested.runId);
    }
  });
  mount();
  await waitFor(() => expect(feed.revisions?.items.filter((entry) => entry.pending)).toHaveLength(2));
  holdNext = true;
  push();
  await waitFor(() => expect(holding).toBe(true));
  act(() => feed.revisions?.refresh());
  await act(async () => {});
  push(11, "run-2");
  act(() => feed.revisions?.refresh("run-3"));
  await act(async () => {});
  expect(leased.has("run-1")).toBe(true);
  expect(feed.revisions?.items.find((entry) => entry.summary.target.runId === "run-2")?.pending).toBeUndefined();
  expect(feed.revisions?.items.find((entry) => entry.summary.target.runId === "run-3")).toBeUndefined();
  await act(async () => heldRead.resolve());
  await waitFor(() => expect(feed.revisions?.items.filter((entry) => entry.pending)).toHaveLength(3));
  expect(collisions).toEqual([]);
  expect(started).toEqual([["run-1", "run-2"], ["run-1"], ["run-1"], ["run-2"], ["run-3"]]);
  for (const entry of feed.revisions!.items)
    expect(entry.pending).toMatchObject({
      target: entry.summary.target,
      payload: { kind: "text", text: `Correction for ${entry.summary.target.runId}` },
    });
  expect(revise).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
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
  // Only the unsent preview (#398) may show the draft; nothing presents it as the recorded correction.
  expect(
    screen
      .queryAllByText("Keep my refused replacement", { selector: "pre" })
      .filter((pre) => !pre.closest('[aria-label="What the agent will receive"]')),
  ).toHaveLength(0);
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

it.each([false, true])(
  "discards an invalidated in-flight read and preserves the draft for the latest identity (inline=%s)",
  async (inline) => {
    open = [];
    summaries = [summary];
    mount(inline);
    await screen.findByRole("button", { name: "Replace pending correction" });
    fireEvent.change(screen.getByLabelText("Correction"), {
      target: { value: "Keep my draft across queued refreshes" },
    });
    const stale = deferred<Awaited<ReturnType<NonNullable<OrcaBridge["inputs"]["revisionPending"]>>>>();
    const fresh = deferred<Awaited<ReturnType<NonNullable<OrcaBridge["inputs"]["revisionPending"]>>>>();
    pendingRead.mockImplementationOnce(() => stale.promise).mockImplementationOnce(() => fresh.promise);
    push();
    await waitFor(() => expect(pendingRead).toHaveBeenCalledTimes(2));
    const next = { ...summary, target: { ...target, revisionId: "revision-2" }, expectedRevision: "v2" };
    summaries = [next];
    push(11);
    push(12);
    await act(async () => {});
    expect(pendingRead).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Recorded correction text", { selector: "pre" })).toBeNull();
    expect(screen.getByRole("button", { name: "Replace pending correction" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    await act(async () =>
      stale.resolve({ ok: true, result: { ...pending, payload: { kind: "text", text: "Stale held body" } } }),
    );
    await waitFor(() => expect(pendingRead).toHaveBeenCalledTimes(3));
    expect(pendingRead.mock.calls[2]![0]).toEqual({ target: next.target });
    expect(screen.queryByText("Stale held body", { selector: "pre" })).toBeNull();
    await act(async () =>
      fresh.resolve({
        ok: true,
        result: { ...pending, ...next, payload: { kind: "text", text: "Latest protected body" } },
      }),
    );
    await screen.findByText("Latest protected body", { selector: "pre" });
    expect(screen.getByLabelText<HTMLTextAreaElement>("Correction").value).toBe(
      "Keep my draft across queued refreshes",
    );
    expect(screen.getByRole("button", { name: "Use reviewed correction version" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace pending correction" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(feed.revisions?.items).toHaveLength(1);
    expect(feed.revisions?.items[0]?.summary).toEqual(next);
    expect(replace).not.toHaveBeenCalled();
  },
);

it("drains the old protected read across reconnect and rejects its content before reading the new authority", async () => {
  open = [];
  summaries = [summary];
  mount();
  await screen.findByRole("button", { name: "Replace pending correction" });
  fireEvent.change(screen.getByLabelText("Correction"), { target: { value: "Old authority draft" } });
  const stale = deferred<Awaited<ReturnType<NonNullable<OrcaBridge["inputs"]["revisionPending"]>>>>();
  const fresh = deferred<Awaited<ReturnType<NonNullable<OrcaBridge["inputs"]["revisionPending"]>>>>();
  pendingRead.mockImplementationOnce(() => stale.promise).mockImplementationOnce(() => fresh.promise);
  push();
  await waitFor(() => expect(pendingRead).toHaveBeenCalledTimes(2));
  push(11); // This queued refresh belongs to the old authority and must never reach the bridge.
  const discoveryCount = fake.calls.filter(
    (call) => call.method === "inputs.list" && (call.params as { revisionRunIds?: string[] })?.revisionRunIds,
  ).length;
  act(() =>
    fake.connect({
      state: "live",
      since: INPUTS_AS_OF,
      generation: 2,
      capabilities: ["runs.read", "runs.control"],
      methods,
    }),
  );
  await act(async () => {});
  expect(pendingRead).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("Recorded correction text", { selector: "pre" })).toBeNull();
  expect(screen.queryByDisplayValue("Old authority draft")).toBeNull();
  await act(async () =>
    stale.resolve({ ok: true, result: { ...pending, payload: { kind: "text", text: "Old authority body" } } }),
  );
  await waitFor(() => expect(pendingRead).toHaveBeenCalledTimes(3));
  expect(
    fake.calls.filter(
      (call) => call.method === "inputs.list" && (call.params as { revisionRunIds?: string[] })?.revisionRunIds,
    ),
  ).toHaveLength(discoveryCount + 1);
  expect(screen.queryByText("Old authority body", { selector: "pre" })).toBeNull();
  await act(async () =>
    fresh.resolve({ ok: true, result: { ...pending, payload: { kind: "text", text: "New authority body" } } }),
  );
  await screen.findByText("New authority body", { selector: "pre" });
  expect(screen.getByLabelText<HTMLTextAreaElement>("Correction").value).toBe("");
  expect(replace).not.toHaveBeenCalled();
});

it("keeps queued correction reads out of a newly selected inline step", async () => {
  open = [];
  summaries = [summary];
  const view = mount(true);
  await screen.findByText("Recorded correction text", { selector: "pre" });
  const stale = deferred<Awaited<ReturnType<NonNullable<OrcaBridge["inputs"]["revisionPending"]>>>>();
  pendingRead.mockImplementationOnce(() => stale.promise);
  push();
  await waitFor(() => expect(pendingRead).toHaveBeenCalledTimes(2));
  view.rerender(
    <h.Providers>
      <App inline stepRunId="another-step" />
    </h.Providers>,
  );
  const next = { ...summary, target: { ...target, revisionId: "revision-2" }, expectedRevision: "v2" };
  summaries = [next];
  pendingRead.mockResolvedValue({
    ok: true,
    result: { ...pending, ...next, payload: { kind: "text", text: "Current selected correction" } },
  });
  push(11);
  await act(async () => stale.resolve({ ok: true, result: pending }));
  await waitFor(() => expect(feed.revisions?.items[0]?.pending?.target).toEqual(next.target));
  expect(view.container.textContent).toBe("");
  view.rerender(
    <h.Providers>
      <App inline />
    </h.Providers>,
  );
  await screen.findByText("Current selected correction", { selector: "pre" });
  expect(screen.queryByText("Recorded correction text", { selector: "pre" })).toBeNull();
  expect(pendingRead).toHaveBeenCalledTimes(3);
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

it("drains its protected discovery before sending one ordinary answer with the captured note", async () => {
  mount();
  const region = await screen.findByRole("region", { name: "gate, Ship release 1?" });
  const held = deferred<void>();
  let leased = false;
  fake.script({
    "inputs.list": async (params) => {
      if (params.revisionRunIds) {
        leased = true;
        await held.promise;
        leased = false;
      }
      return {
        ok: true as const,
        result: {
          inputs: open,
          waiting: open.length,
          asOf: INPUTS_AS_OF,
          pendingRevisions: { items: [], incomplete: false as const },
        },
      };
    },
    "inputs.answer": () => ({
      ok: false,
      error: {
        code: leased ? "RUN_LEASED_ELSEWHERE" : "INPUT_ANSWERED",
        message: "Synthetic refusal; preserve the note",
      },
    }),
  });
  act(() => feed.revisions!.refresh("run-1"));
  await waitFor(() => expect(leased).toBe(true));
  fireEvent.click(within(region).getByRole("button", { name: /Approve/ }));
  region.focus();
  fireEvent.keyDown(region, { key: "Enter", code: "Enter", shiftKey: true });
  fireEvent.change(within(region).getByLabelText("Note"), { target: { value: "Keep this ordinary rationale" } });
  fireEvent.click(within(region).getByRole("button", { name: "Answer" }));
  try {
    await act(async () => {});
    expect(fake.calls.filter((call) => call.method === "inputs.answer")).toHaveLength(0);
  } finally {
    await act(async () => held.resolve());
  }
  await waitFor(() => expect(fake.calls.filter((call) => call.method === "inputs.answer")).toHaveLength(1));
  expect(fake.calls.find((call) => call.method === "inputs.answer")!.params).toMatchObject({
    runId: "run-1",
    requestId: gate.id,
    optionId: "approve",
    note: "Keep this ordinary rationale",
  });
  expect(within(region).getByLabelText<HTMLInputElement>("Note").value).toBe("Keep this ordinary rationale");
});

function handoffCreated() {
  return { ...EVENTS["run-parent"]![0]!, runId: "run-1" };
}
function handoffAnswerEvent(seq = 21) {
  return {
    id: "ordinary-answer",
    runId: "run-1",
    seq,
    at: INPUTS_AS_OF,
    type: "human.answered" as const,
    payload: { requestId: gate.id, stepRunId: gate.stepRunId, answer: "approve" },
  };
}
function handoffProgressEvent(seq = 22) {
  return { id: "ordinary-resume", runId: "run-1", seq, at: INPUTS_AS_OF, type: "run.resumed" as const, payload: {} };
}
function notifyOrdinaryAnswer(seq = 21, requestId = gate.id) {
  act(() =>
    fake.notify({
      kind: "notification",
      method: "input.answered",
      params: {
        subscriptionId: "attention",
        runId: gate.runId,
        stepRunId: gate.stepRunId,
        requestId,
        answer: "approve",
        seq,
        at: INPUTS_AS_OF,
      },
    }),
  );
}
function notifyAnswerProgress(seq = 22, runId = gate.runId) {
  act(() =>
    fake.notify({
      kind: "notification",
      method: "run.changed",
      params: { subscriptionId: "attention", runId, seq, at: INPUTS_AS_OF, event: "run.resumed", status: "running" },
    }),
  );
}
function reconnectAnswer(generation = 2) {
  act(() =>
    fake.connect({
      state: "live",
      since: INPUTS_AS_OF,
      generation,
      capabilities: ["runs.read", "runs.control"],
      methods,
    }),
  );
}
async function directAnswerHandoff() {
  mount();
  await screen.findByRole("region", { name: "gate, Ship release 1?" });
  await act(async () => {});
  const settled = deferred<{ ok: boolean }>();
  const invoke = vi.fn(() => settled.promise);
  let response!: Promise<{ ok: boolean } | undefined>;
  act(() => {
    response = feed.revisions!.withAnswer!(gate, { optionId: "approve", note: "Captured ordinary note" }, invoke);
  });
  await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  return { settled, invoke, response };
}

it("releases reads only after exact ordered answer and resume evidence, without fabricating RPC acceptance", async () => {
  const call = await directAnswerHandoff();
  const before = fake.calls.filter((item) => item.method === "inputs.list").length;
  act(() => feed.revisions!.refresh("run-1"));
  notifyAnswerProgress(22, "other-run");
  notifyOrdinaryAnswer(19);
  notifyOrdinaryAnswer(21);
  await act(async () => {});
  expect(fake.calls.filter((item) => item.method === "inputs.list")).toHaveLength(before);
  expect(screen.getByText(/earlier answer is still unconfirmed/)).toBeTruthy();
  notifyAnswerProgress(22);
  await waitFor(() =>
    expect(fake.calls.filter((item) => item.method === "inputs.list").length).toBeGreaterThan(before),
  );
  expect(screen.getByText(/Run progress was verified/)).toBeTruthy();
  expect(call.invoke).toHaveBeenCalledOnce();
  call.settled.resolve({ ok: true });
  expect(await call.response).toEqual({ ok: true });
});

it("does not release a handoff for reversed lifecycle evidence or an unrelated request", async () => {
  const call = await directAnswerHandoff();
  const before = fake.calls.filter((item) => item.method === "inputs.list").length;
  notifyAnswerProgress(22);
  notifyOrdinaryAnswer(21);
  notifyOrdinaryAnswer(23, "other-request");
  notifyAnswerProgress(24);
  await act(async () => {});
  expect(fake.calls.filter((item) => item.method === "inputs.list")).toHaveLength(before);
  call.settled.resolve({ ok: false });
  expect(await call.response).toEqual({ ok: false });
  await waitFor(() =>
    expect(fake.calls.filter((item) => item.method === "inputs.list").length).toBeGreaterThan(before),
  );
  expect(feed.revisions?.answerDraft?.(gate)?.note).toBe("Captured ordinary note");
});

it.each(["partial", "mismatch", "denied", "missing-answer", "reversed"] as const)(
  "retains reconnect uncertainty for %s history and permits an explicit verified history check",
  async (failure) => {
    const call = await directAnswerHandoff();
    let valid = false;
    fake.script({
      "runs.events": () => {
        if (!valid && failure === "denied")
          return { ok: false as const, error: { code: "AUTH_FORBIDDEN" as const, message: "Denied" } };
        const created = handoffCreated();
        return {
          ok: true as const,
          result: {
            events:
              !valid && failure === "missing-answer"
                ? [created, handoffProgressEvent()]
                : [
                    !valid && failure === "mismatch" ? { ...created, id: "different-history" } : created,
                    handoffAnswerEvent(),
                    handoffProgressEvent(!valid && failure === "reversed" ? 20 : 22),
                  ],
            hasMore: !valid && failure === "partial",
            lastSeq: 22,
            asOf: INPUTS_AS_OF,
          },
        };
      },
    });
    const reads = fake.calls.filter((item) => item.method === "inputs.list").length;
    reconnectAnswer();
    await screen.findByText(/earlier answer is still unconfirmed/);
    await act(async () => {});
    expect(call.invoke).toHaveBeenCalledOnce();
    // Ordinary Attention reload is independent, but protected revision reads remain paused.
    const protectedBefore = fake.calls.filter(
      (item) => item.method === "inputs.list" && (item.params as { revisionRunIds?: string[] }).revisionRunIds,
    ).length;
    act(() => feed.revisions!.refresh("run-1"));
    await act(async () => {});
    expect(
      fake.calls.filter(
        (item) => item.method === "inputs.list" && (item.params as { revisionRunIds?: string[] }).revisionRunIds,
      ),
    ).toHaveLength(protectedBefore);
    expect(fake.calls.filter((item) => item.method === "inputs.list").length).toBeGreaterThanOrEqual(reads);
    valid = true;
    fireEvent.click(screen.getByRole("button", { name: "Check pending answer" }));
    await screen.findByText(/Run progress was verified/);
    await waitFor(() =>
      expect(
        fake.calls.filter(
          (item) => item.method === "inputs.list" && (item.params as { revisionRunIds?: string[] }).revisionRunIds,
        ).length,
      ).toBeGreaterThan(protectedBefore),
    );
    call.settled.resolve({ ok: true });
    expect(await call.response).toBeUndefined();
    expect(call.invoke).toHaveBeenCalledOnce();
  },
);

it.each([true, false])(
  "keeps an old HTTP answer uncertain across reconnect until its real late result (ok=%s)",
  async (ok) => {
    const call = await directAnswerHandoff();
    reconnectAnswer();
    await screen.findByText(/earlier answer is still unconfirmed/);
    await waitFor(() => expect(feed.revisions?.answerDraft?.(gate)?.note).toBe("Captured ordinary note"));
    expect(screen.getByLabelText<HTMLInputElement>("Note").value).toBe("Captured ordinary note");
    call.settled.resolve({ ok });
    expect(await call.response).toBeUndefined();
    expect(call.invoke).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByText(/details are paused/)).toBeNull());
  },
);

it("cancels an unsent queued answer on reconnect and restores its verified note without invoking it", async () => {
  mount();
  await screen.findByRole("region", { name: "gate, Ship release 1?" });
  const held = deferred<void>();
  let reading = false;
  fake.script({
    "inputs.list": async (params) => {
      if (params.revisionRunIds && !reading) {
        reading = true;
        await held.promise;
      }
      return {
        ok: true as const,
        result: {
          inputs: open,
          waiting: open.length,
          asOf: INPUTS_AS_OF,
          pendingRevisions: { items: [], incomplete: false as const },
        },
      };
    },
  });
  act(() => feed.revisions!.refresh("run-1"));
  await waitFor(() => expect(reading).toBe(true));
  const invoke = vi.fn(async () => ({ ok: true }));
  let result!: Promise<{ ok: boolean } | undefined>;
  act(() => {
    result = feed.revisions!.withAnswer!(gate, { optionId: "approve", note: "Unsent retained note" }, invoke);
  });
  await waitFor(() => expect(fake.calls.some((item) => item.method === "runs.events")).toBe(true));
  await act(async () => {});
  reconnectAnswer();
  expect(await result).toBeUndefined();
  await screen.findByText(/earlier answer was not sent/);
  await waitFor(() => expect(feed.revisions?.answerDraft?.(gate)?.note).toBe("Unsent retained note"));
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => held.resolve());
  expect(invoke).not.toHaveBeenCalled();
});

it("keeps unrelated ordinary controls and live permission callbacks usable while an old answer is pending", async () => {
  const call = await directAnswerHandoff();
  const permission = vi.fn(async () => ({ ok: true }));
  expect(
    await feed.revisions!.withAnswer!(
      { ...gate, kind: "permission", id: "live-ask" },
      { optionId: "allow" },
      permission,
    ),
  ).toEqual({ ok: true });
  expect(permission).toHaveBeenCalledOnce();
  const other = vi.fn(async () => ({ ok: true }));
  expect(
    await feed.revisions!.withAnswer!(
      { ...gate, id: "other-ask", stepRunId: "other-step" },
      { optionId: "approve", note: "Other note" },
      other,
    ),
  ).toEqual({ ok: true });
  expect(other).toHaveBeenCalledOnce();
  act(() => controls.cancel("other-run"));
  await waitFor(() => expect(fake.calls.some((item) => item.method === "runs.cancel")).toBe(true));
  expect(call.invoke).toHaveBeenCalledOnce();
  call.settled.resolve({ ok: false });
  await call.response;
});

it.each(["run.completed", "run.failed", "run.cancelled"] as const)(
  "releases only reads on exact %s progress while keeping the answer response pending",
  async (event) => {
    const call = await directAnswerHandoff();
    notifyOrdinaryAnswer();
    act(() =>
      fake.notify({
        kind: "notification",
        method: "run.changed",
        params: {
          subscriptionId: "attention",
          runId: gate.runId,
          seq: 22,
          at: INPUTS_AS_OF,
          event,
          status: event === "run.completed" ? "succeeded" : event === "run.failed" ? "failed" : "cancelled",
        },
      }),
    );
    await screen.findByText(/Run progress was verified/);
    expect(call.invoke).toHaveBeenCalledOnce();
    call.settled.resolve({ ok: false });
    expect(await call.response).toEqual({ ok: false });
  },
);

it("does not borrow a late successful history read across a later authority generation", async () => {
  const call = await directAnswerHandoff();
  const oldHistory = deferred<Awaited<ReturnType<OrcaBridge["runs"]["events"]>>>();
  let checks = 0;
  fake.script({
    "runs.events": async () => {
      checks++;
      return checks === 1
        ? oldHistory.promise
        : { ok: false as const, error: { code: "AUTH_FORBIDDEN" as const, message: "Revoked" } };
    },
  });
  reconnectAnswer(2);
  await waitFor(() => expect(checks).toBe(1));
  reconnectAnswer(3);
  await act(async () =>
    oldHistory.resolve({
      ok: true,
      result: {
        events: [handoffCreated(), handoffAnswerEvent(), handoffProgressEvent()],
        hasMore: false,
        lastSeq: 22,
        asOf: INPUTS_AS_OF,
      },
    }),
  );
  await waitFor(() => expect(checks).toBe(2));
  await screen.findByText(/earlier answer is still unconfirmed/);
  expect(feed.revisions?.answerDraft?.(gate)).toBeUndefined();
  expect(screen.queryByLabelText("Note")).toBeNull();
  call.settled.resolve({ ok: false });
  expect(await call.response).toBeUndefined();
  expect(call.invoke).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "ordinary pointer answers use the shared read handoff in both mounts (inline=%s)",
  async (inline) => {
    mount(inline);
    const region = await screen.findByRole("region", { name: "gate, Ship release 1?" });
    const held = deferred<void>();
    let entered = false;
    fake.script({
      "inputs.list": async (params) => {
        if (params.revisionRunIds && !entered) {
          entered = true;
          await held.promise;
        }
        return {
          ok: true as const,
          result: {
            inputs: open,
            waiting: open.length,
            asOf: INPUTS_AS_OF,
            pendingRevisions: { items: [], incomplete: false as const },
          },
        };
      },
      "inputs.answer": () => ({
        ok: false,
        error: { code: "RUN_LEASED_ELSEWHERE", message: "External owner remains busy" },
      }),
    });
    act(() => feed.revisions!.refresh("run-1"));
    await waitFor(() => expect(entered).toBe(true));
    fireEvent.click(within(region).getByRole("button", { name: /Approve/ }));
    fireEvent.click(within(region).getByRole("button", { name: "Answer" }));
    await act(async () => {});
    expect(fake.calls.filter((item) => item.method === "inputs.answer")).toHaveLength(0);
    await act(async () => held.resolve());
    await screen.findByText(/RUN_LEASED_ELSEWHERE: External owner remains busy/);
    expect(fake.calls.filter((item) => item.method === "inputs.answer")).toHaveLength(1);
    expect(
      within(region)
        .getByRole("button", { name: /Approve/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  },
);

it("invalidates draft restoration when an explicit current-authority history check is denied", async () => {
  const call = await directAnswerHandoff();
  expect(feed.revisions?.answerDraft?.(gate)?.note).toBe("Captured ordinary note");
  fake.script({
    "runs.events": () => ({ ok: false, error: { code: "AUTH_FORBIDDEN", message: "Current reader denied" } }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Check pending answer" }));
  await waitFor(() => expect(feed.revisions?.answerDraft?.(gate)).toBeUndefined());
  notifyOrdinaryAnswer();
  notifyAnswerProgress();
  await screen.findByText(/earlier answer is still unconfirmed/);
  call.settled.resolve({ ok: false });
  await call.response;
});

it("cleanup never resends or publishes a late answer after its mounted feed leaves", async () => {
  const call = await directAnswerHandoff();
  const before = fake.calls.length;
  cleanup();
  call.settled.resolve({ ok: true });
  expect(await call.response).toBeUndefined();
  expect(call.invoke).toHaveBeenCalledOnce();
  await act(async () => {});
  expect(fake.calls.length).toBe(before);
});

it("a rejected ordinary answer releases protected reads and leaves its draft available", async () => {
  mount();
  await screen.findByRole("region", { name: "gate, Ship release 1?" });
  const invoke = vi.fn(async () => {
    throw new Error("Transport response unavailable");
  });
  await expect(
    feed.revisions!.withAnswer!(gate, { optionId: "approve", note: "Keep rejected note" }, invoke),
  ).rejects.toThrow("Transport response unavailable");
  expect(feed.revisions?.answerDraft?.(gate)?.note).toBe("Keep rejected note");
  const before = fake.calls.filter((item) => item.method === "inputs.list").length;
  act(() => feed.revisions!.refresh("run-1"));
  await waitFor(() =>
    expect(fake.calls.filter((item) => item.method === "inputs.list").length).toBeGreaterThan(before),
  );
  expect(invoke).toHaveBeenCalledOnce();
});
