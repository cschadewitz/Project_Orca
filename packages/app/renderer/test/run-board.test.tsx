// @vitest-environment happy-dom
/**
 * The Runs surface's board (#340) against the fake bridge: which runs it follows, what a
 * card says, the live path (a `run.changed` repainting a card before its snapshot catches
 * up), a dropped connection, drilling into the tree, and the workflow filter.
 *
 * The follower's own rules - cursors, gaps, snapshots that may not go backwards - are tested
 * in `packages/protocol/test/run-follower.test.ts` and against real stores in
 * `packages/daemon/test/operations-view.test.ts`; this file is the wiring.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  NotificationMessage,
  RecoveryAssessment,
  RecoveryStep,
  RunsGetResult,
  RunOperationsView,
} from "@orca/protocol";
import { RunsSurface } from "../src/runs/runs-surface.js";
import { boardRuns, ownerText, progressText, recoveryLines, waitText } from "../src/runs/board/board-model.js";
import { AS_OF, HELLO, RUN_DETAILS, RUNS } from "./fixtures.js";
import { installBridge, harness, type Harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

let fake: FakeBridge;
let h: Harness;
const teardown: (() => void)[] = [];

const OPERATIONS: RunOperationsView = {
  lastSeq: 11,
  lastActivityAt: "2026-03-01T09:00:34.000Z",
  progress: { attempts: 3, completed: 2, failed: 0, active: 0, waiting: 1, skipped: 0 },
  owner: { holder: "h-1", host: "build-box", since: "2026-03-01T09:00:25.000Z", lapsed: false },
  facets: {
    host: { state: "unavailable", reason: "not-collected" },
    usage: { state: "unavailable", reason: "not-collected" },
  },
};

/** `runs.get` with `operations` for every run the fixtures have a projection of. */
function withOperations(runId: string): RunsGetResult | undefined {
  const detail = RUN_DETAILS[runId];
  return detail && { ...detail, run: { ...detail.run, operations: { ...OPERATIONS, lastSeq: detail.lastSeq } } };
}

type Shown = "live" | "reconnecting" | "disconnected";

function renderRuns(connection: Shown = "live"): (next: Shown) => void {
  h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  const view = render(
    <Providers>
      <RunsSurface connection={connection} />
    </Providers>,
  );
  return (next) =>
    view.rerender(
      <Providers>
        <RunsSurface connection={next} />
      </Providers>,
    );
}

const board = (): HTMLElement => screen.getByRole("list", { name: "Followed runs" });
const card = (name: string): HTMLElement => within(board()).getByRole("article", { name: new RegExp(`^${name},`) });

async function openBoard(): Promise<void> {
  await screen.findByRole("tree", { name: "Run tree" });
  fireEvent.click(screen.getByRole("button", { name: "Board" }));
  await screen.findByRole("list", { name: "Followed runs" });
}

describe("the run board", () => {
  beforeEach(() => {
    fake = installBridge();
    fake.script({
      "runs.get": ({ runId }) => {
        const detail = withOperations(runId);
        return Promise.resolve(
          detail
            ? { ok: true as const, result: detail }
            : { ok: false as const, error: { code: "RUN_NOT_FOUND", message: `no run ${runId}` } },
        );
      },
    });
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("follows the active top-level runs and says what each is doing", async () => {
    renderRuns();
    await openBoard();
    const labels = () =>
      within(board())
        .getAllByRole("article")
        .map((a) => a.getAttribute("aria-label"));
    // Running, waiting and stale roots; not the finished root, not the child. The stale one has
    // no projection, so the daemon's not-found is a refusal: it is said, and nothing is shown.
    await waitFor(() =>
      expect(labels()).toEqual(["run-lost, Not available", "Document the rollout, Live", "Add the SSO callback, Live"]),
    );
    const gate = card("Document the rollout");
    expect(gate.textContent).toContain("3 steps · 2 done · 1 waiting");
    expect(gate.textContent).toContain("Waiting for a person: hi-1");
    expect(gate.textContent).toContain("Held on build-box");
    // Not measured per run: "unavailable", never a zero.
    expect(within(gate).getAllByText("unavailable")).toHaveLength(2);
    expect(fake.calls.filter((c) => c.method === "runs.get").map((c) => c.params)).toContainEqual({
      runId: "run-gate",
      operations: true,
    });
  });

  it("repaints a card from run.changed before its snapshot catches up", async () => {
    renderRuns();
    await openBoard();
    await waitFor(() => expect(card("Add the SSO callback").getAttribute("aria-label")).toContain("Live"));
    const frame: NotificationMessage = {
      kind: "notification",
      method: "run.changed",
      params: {
        subscriptionId: "sub-1",
        runId: "run-parent",
        seq: 99,
        at: "2026-03-01T09:01:00.000Z",
        status: "cancelled",
        outcome: "cancelled",
        event: "run.cancelled",
      },
    };
    act(() => fake.notify(frame));
    await waitFor(() => expect(card("Add the SSO callback").textContent).toContain("cancelled"));
  });

  it("says reconnecting while the connection is down, and re-reads when it is back", async () => {
    const rerender = renderRuns();
    await openBoard();
    await waitFor(() => expect(card("Document the rollout").getAttribute("aria-label")).toContain("Live"));
    const before = fake.calls.filter((c) => c.method === "runs.get").length;
    rerender("reconnecting");
    await waitFor(() => expect(card("Document the rollout").getAttribute("aria-label")).toContain("Reconnecting"));
    rerender("live");
    await waitFor(() => expect(card("Document the rollout").getAttribute("aria-label")).toContain("Live"));
    expect(fake.calls.filter((c) => c.method === "runs.get").length).toBeGreaterThan(before);
  });

  it("drops every card on a workspace change, and never shows the old store's run under the same id", async () => {
    renderRuns();
    await openBoard();
    await waitFor(() => expect(card("Document the rollout").textContent).toContain("Held on build-box"));
    // Another store, whose run-gate is a different run that the daemon is slow to describe.
    let answer: ((r: { ok: true; result: RunsGetResult }) => void) | undefined;
    fake.script({
      "runs.get": ({ runId }) =>
        new Promise((resolve) => {
          if (runId === "run-gate") answer = resolve;
          else resolve({ ok: false, error: { code: "RUN_NOT_FOUND", message: `no run ${runId}` } });
        }),
    });
    await act(async () => {
      await window.orca.workspace.open({ path: "/elsewhere" });
    });
    // From the render that sees the switch: no card says anything the old store said.
    expect(board().textContent).not.toContain("build-box");
    expect(board().textContent).not.toContain("Document the rollout");
    const other = withOperations("run-gate")!;
    act(() =>
      answer!({
        ok: true,
        result: {
          ...other,
          run: { ...other.run, name: "A different run", operations: { ...other.run.operations!, owner: undefined } },
        },
      }),
    );
    await waitFor(() => expect(card("A different run").getAttribute("aria-label")).toContain("Live"));
    expect(card("A different run").textContent).toContain("No process holds it");
  });

  it("clears a card the daemon refuses after a reconnect, finished or not", async () => {
    const rerender = renderRuns();
    await openBoard();
    await waitFor(() => expect(card("Document the rollout").getAttribute("aria-label")).toContain("Live"));
    fake.script({
      "runs.get": () => Promise.resolve({ ok: false, error: { code: "AUTH_FORBIDDEN", message: "not permitted" } }),
    });
    rerender("reconnecting");
    act(() => fake.connect({ ...fake.connection, generation: (fake.connection.generation ?? 0) + 1 }));
    rerender("live");
    await waitFor(() => expect(within(board()).getByRole("article", { name: "run-gate, Not available" })).toBeTruthy());
    expect(board().textContent).not.toContain("Waiting for a person");
    expect(board().textContent).toContain("AUTH_FORBIDDEN");
  });

  it("hides every card the moment the stream is refused, though nothing else about it changed", async () => {
    const rerender = renderRuns();
    await openBoard();
    await waitFor(() => expect(card("Document the rollout").textContent).toContain("Held on build-box"));
    const snapshot = fake.connection;
    const reads = () => fake.calls.filter((c) => c.method === "runs.get").length;
    // An authenticated stream turned auth-failed: main publishes `disconnected` at once, with the
    // same workspace, generation, capabilities and methods. No reconnect, no refusal from a read.
    act(() => fake.connect({ ...snapshot, state: "disconnected" }));
    rerender("disconnected");
    expect(board().textContent).not.toContain("build-box");
    expect(board().textContent).not.toContain("Document the rollout");
    expect(board().textContent).not.toContain("Waiting for a person");
    expect(within(board()).getByRole("article", { name: "run-gate, Reconnecting" })).toBeTruthy();
    // Nothing is read while the connection has ended.
    const before = reads();
    await act(async () => {
      await Promise.resolve();
    });
    expect(reads()).toBe(before);
    // Signed in again: a fresh follower reads every run from nothing.
    act(() => fake.connect({ ...snapshot, generation: (snapshot.generation ?? 0) + 1 }));
    rerender("live");
    await waitFor(() => expect(card("Document the rollout").getAttribute("aria-label")).toContain("Live"));
    expect(reads()).toBeGreaterThan(before);
  });

  it("never shows the old target's run after a switch with the same path and grants", async () => {
    const rerender = renderRuns();
    await openBoard();
    await waitFor(() => expect(card("Document the rollout").textContent).toContain("Held on build-box"));
    const snapshot = fake.connection;
    let answer: ((r: { ok: true; result: RunsGetResult }) => void) | undefined;
    fake.script({
      "runs.get": ({ runId }) =>
        new Promise((resolve) => {
          if (runId === "run-gate") answer = resolve;
          else resolve({ ok: false, error: { code: "RUN_NOT_FOUND", message: `no run ${runId}` } });
        }),
    });
    // Re-pointed at another daemon behind the same display path: main resets (no quiet window,
    // the old daemon's grants dropped) and then attaches to the new one with identical grants.
    const { capabilities: _c, methods: _m, ...reset } = snapshot;
    act(() => fake.connect({ ...reset, state: "reconnecting" }));
    rerender("reconnecting");
    expect(board().textContent).not.toContain("build-box");
    expect(board().textContent).not.toContain("Document the rollout");
    act(() => fake.connect({ ...snapshot, generation: (snapshot.generation ?? 0) + 1 }));
    rerender("live");
    // The list reloads for the new generation; whatever is on screen, the old owner is not.
    expect(document.body.textContent).not.toContain("build-box");
    await waitFor(() => expect(answer).toBeDefined());
    const other = withOperations("run-gate")!;
    act(() =>
      answer!({
        ok: true,
        result: {
          ...other,
          run: { ...other.run, name: "A different run", operations: { ...other.run.operations!, owner: undefined } },
        },
      }),
    );
    await waitFor(() => expect(card("A different run").getAttribute("aria-label")).toContain("Live"));
    expect(board().textContent).not.toContain("build-box");
  });

  it("opens a card's run in the tree", async () => {
    renderRuns();
    await openBoard();
    fireEvent.click(within(card("Document the rollout")).getByRole("button", { name: "Document the rollout" }));
    const tree = await screen.findByRole("tree", { name: "Run tree" });
    await waitFor(() => expect(within(tree).getByRole("treeitem", { selected: true }).id).toBe("tree-row-run-gate"));
  });

  it("filters by workflow through runs.list, and again over what comes back", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    fireEvent.click(screen.getByRole("button", { name: /Filter by workflow/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "nightly" }));
    await waitFor(() => expect(within(screen.getByRole("tree")).getAllByRole("treeitem")).toHaveLength(1));
    const lists = fake.calls.filter((c) => c.method === "runs.list");
    expect(lists.at(-1)!.params).toEqual({ workflowId: "nightly" });
  });
});

describe("run filters and the daemon's protocol", () => {
  beforeEach(() => {
    fake = installBridge();
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("finds a match beyond the first page, because the daemon filters the whole store", async () => {
    // A store of 150 runs, the one `nightly` run the oldest: past any first page.
    const many = Array.from({ length: 150 }, (_, i) => ({
      ...RUNS[1]!,
      id: `run-${String(i).padStart(3, "0")}`,
      workflowId: i === 149 ? "nightly" : "sdlc",
    }));
    fake.script({
      "workflows.list": () =>
        Promise.resolve({
          ok: true as const,
          result: {
            workflows: [{ id: "nightly", name: "nightly", version: "1", nodeCount: 2, edgeCount: 1, start: "start" }],
            asOf: AS_OF,
          },
        }),
      "runs.list": (params) => {
        const matches = many.filter((r) => params.workflowId === undefined || r.workflowId === params.workflowId);
        const limit = params.limit ?? 100;
        return Promise.resolve({
          ok: true as const,
          result: { runs: matches.slice(0, limit), total: matches.length, asOf: AS_OF },
        });
      },
    });
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    fireEvent.click(screen.getByRole("button", { name: /Filter by workflow/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "nightly" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("tree"))
          .getAllByRole("treeitem")
          .map((r) => r.id),
      ).toEqual(["tree-row-run-149"]),
    );
    expect(screen.getByText("1 run")).toBeTruthy();
  });

  it("does not offer the filters a 2.2 daemon would ignore, rather than filter one page", async () => {
    fake.connect({ ...fake.connection, versions: { app: "2.3", daemon: "2.2" } });
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    expect(screen.queryByRole("button", { name: /Filter by workflow/ })).toBeNull();
    const workflow = screen.getByRole("button", { name: "All workflows" });
    expect(workflow.getAttribute("aria-disabled")).toBe("true");
    expect(workflow.getAttribute("title")).toContain("protocol 2.3");
    expect(fake.calls.filter((c) => c.method === "runs.list").map((c) => c.params)).toEqual([{}]);
  });
});

const step = (over: Partial<RecoveryStep>): RecoveryStep => ({
  runId: "run-gate",
  stepRunId: "s-deploy-1",
  nodeId: "deploy",
  nodeType: "agent",
  attempt: 1,
  status: "running",
  effect: "uncertain",
  asksAgain: false,
  answerCarried: false,
  artifactIds: [],
  missingArtifactIds: [],
  ...over,
});

/** A stopped run whose deploy may have acted: Resume waits on review, a checkpoint attempt does not. */
const ASSESSMENT: RecoveryAssessment = {
  runId: "run-gate",
  workflowId: "sdlc",
  workflowVersion: "2",
  status: "stale",
  options: [
    { kind: "resume", readiness: "blocked", blockers: ["effect-unreviewed"], unverified: [], runsAgain: [step({})] },
    {
      kind: "checkpoint-attempt",
      readiness: "available",
      blockers: [],
      unverified: [],
      checkpointStepRunId: "s-write",
      runsAgain: [step({ effect: "reviewed" })],
    },
    { kind: "new-run", readiness: "available", blockers: [], unverified: [], runsAgain: [] },
  ],
  checkpoints: [
    {
      stepRunId: "s-write",
      nodeId: "write",
      attempt: 1,
      readiness: "available",
      blockers: [],
      unverified: [],
      reused: [],
      ranAfter: [],
    },
  ],
  uncertain: [step({})],
};

describe("recovery previews on the board (#357)", () => {
  /** `run-gate` has stopped (stale); everything else on the board is moving. */
  function stopped(recovery: (runId: string) => Promise<unknown>, methods = ["runs.recovery"]) {
    fake = installBridge({
      connection: {
        state: "live",
        since: AS_OF,
        orcaVersion: HELLO.orcaVersion,
        capabilities: HELLO.capabilities,
        methods: [...(HELLO.methods ?? []), ...methods],
      },
    });
    fake.script({
      "runs.get": ({ runId }) => {
        const detail = withOperations(runId);
        if (!detail)
          return Promise.resolve({ ok: false as const, error: { code: "RUN_NOT_FOUND", message: "no run" } });
        const run = runId === "run-gate" ? { ...detail.run, status: "stale" as const } : detail.run;
        return Promise.resolve({ ok: true as const, result: { ...detail, run } });
      },
      "runs.recovery": (({ runId }: { runId: string }) => recovery(runId)) as never,
    });
  }
  const asked = () => fake.calls.filter((c) => c.method === "runs.recovery").map((c) => c.params);
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("says what recovering a stopped run would do, and asks only about stopped runs", async () => {
    stopped(() => Promise.resolve({ ok: true, result: { assessment: ASSESSMENT, asOf: AS_OF } }));
    renderRuns();
    await openBoard();
    const preview = await within(card("Document the rollout")).findByRole("region", {
      name: "Recovery for Document the rollout",
    });
    await waitFor(() => expect(preview.textContent).toContain("Checkpoint attempt after write"));
    expect(preview.textContent).toContain("Review first: deploy may have acted outside ORCA");
    expect(preview.textContent).toContain("Runs again: deploy");
    // The running run is not asked about, and has no preview.
    expect(within(card("Add the SSO callback")).queryByRole("region")).toBeNull();
    expect(asked()).toEqual([{ runId: "run-gate" }]);

    fireEvent.click(within(preview).getByRole("button", { name: "Open recovery" }));
    const tree = await screen.findByRole("tree", { name: "Run tree" });
    await waitFor(() => expect(within(tree).getByRole("treeitem", { selected: true }).id).toBe("tree-row-run-gate"));
  });

  it("is never asked of a daemon that does not list runs.recovery", async () => {
    stopped(() => Promise.resolve({ ok: true, result: { assessment: ASSESSMENT, asOf: AS_OF } }), []);
    renderRuns();
    await openBoard();
    await waitFor(() => expect(card("Document the rollout").getAttribute("aria-label")).toContain("Live"));
    expect(within(card("Document the rollout")).queryByRole("region")).toBeNull();
    expect(asked()).toEqual([]);
  });

  it("drops a preview when the connection ends, and never draws an answer that arrives after", async () => {
    let first: ((value: unknown) => void) | undefined;
    const answers = [
      new Promise((resolve) => (first = resolve)),
      Promise.resolve({
        ok: true,
        result: { assessment: { ...ASSESSMENT, uncertain: [], options: ASSESSMENT.options.slice(2) }, asOf: AS_OF },
      }),
    ];
    stopped(() => answers.shift() ?? new Promise(() => {}));
    const rerender = renderRuns();
    await openBoard();
    await within(card("Document the rollout")).findByText("Checking what recovery would do");
    rerender("disconnected");
    await waitFor(() => expect(screen.queryByRole("region", { name: /Recovery for/ })).toBeNull());
    rerender("live");
    // A fresh read once the connection is back: the card shows the second answer.
    const region = () => screen.getByRole("region", { name: "Recovery for Document the rollout" });
    await waitFor(() => expect(region().textContent).toContain("New run"));
    // The first answer, asked before the connection ended, arrives now: it is not drawn, though
    // the scope reads the same as it did then.
    await act(async () => first?.({ ok: true, result: { assessment: ASSESSMENT, asOf: AS_OF } }));
    expect(region().textContent).not.toContain("deploy");
    expect(asked()).toHaveLength(2);
  });
});

describe("board words", () => {
  it("previews recovery from the daemon's assessment, and says why when every way back is blocked", () => {
    expect(recoveryLines(ASSESSMENT)).toEqual([
      "Review first: deploy may have acted outside ORCA",
      "Checkpoint attempt after write",
      "Runs again: deploy",
    ]);
    const resume = { kind: "resume" as const, readiness: "unverified" as const, blockers: [], unverified: [] };
    expect(recoveryLines({ ...ASSESSMENT, uncertain: [], options: [{ ...resume, runsAgain: [] }] })).toEqual([
      "Resume (unverified)",
      "Runs nothing again",
    ]);
    expect(
      recoveryLines({
        ...ASSESSMENT,
        uncertain: [],
        options: [{ ...resume, readiness: "blocked", blockers: ["workflow-missing"], runsAgain: [] }],
      }),
    ).toEqual(["No way back: The workflow version this run used is no longer readable. Start a new run instead."]);
  });

  it("counts steps, names waits and owners, and leaves out what is not there", () => {
    const gate = RUNS.find((r) => r.id === "run-gate")!;
    expect(progressText(gate)).toBeUndefined();
    const run = { ...gate, operations: OPERATIONS };
    expect(progressText(run)).toBe("3 steps · 2 done · 1 waiting");
    expect(waitText({ ...run, waitingOn: "agent-slot", waitingDetail: "cap 2" })).toBe(
      "Waiting for an agent slot: cap 2",
    );
    expect(waitText({ ...run, waitingOn: "custom" })).toBe("Waiting on custom: hi-1");
    expect(ownerText(run)).toBe("Held on build-box");
    expect(ownerText({ ...run, operations: { ...OPERATIONS, owner: { ...OPERATIONS.owner!, lapsed: true } } })).toBe(
      "Lease lapsed on build-box",
    );
    const { owner: _owner, ...unowned } = OPERATIONS;
    expect(ownerText({ ...run, operations: unowned })).toBe("No process holds it");
  });

  it("keeps a followed run that finished, and starts from the active roots", () => {
    const finished = RUNS.find((r) => r.id === "run-old")!;
    expect(boardRuns(RUNS, [])).toEqual(["run-lost", "run-gate", "run-parent"]);
    expect(boardRuns(RUNS, ["run-old"])).toEqual(["run-lost", "run-gate", "run-parent", finished.id]);
    // A run the filter no longer shows leaves the board.
    expect(
      boardRuns(
        RUNS.filter((r) => r.id !== "run-old"),
        ["run-old"],
      ),
    ).not.toContain("run-old");
  });
});
