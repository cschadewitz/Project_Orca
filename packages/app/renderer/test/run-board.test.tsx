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
import type { NotificationMessage, RunsGetResult, RunOperationsView } from "@orca/protocol";
import { RunsSurface } from "../src/runs/runs-surface.js";
import { boardRuns, ownerText, progressText, waitText } from "../src/runs/board/board-model.js";
import { AS_OF, RUN_DETAILS, RUNS } from "./fixtures.js";
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

function renderRuns(connection: "live" | "reconnecting" = "live"): (next: "live" | "reconnecting") => void {
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
    const names = within(board())
      .getAllByRole("article")
      .map((a) => a.getAttribute("aria-label")!.split(",")[0]);
    // Running, waiting and stale roots; not the finished root, not the child.
    expect(names).toEqual(["sdlc", "Document the rollout", "Add the SSO callback"]);

    await waitFor(() => expect(card("Document the rollout").getAttribute("aria-label")).toContain("Live"));
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

describe("board words", () => {
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
