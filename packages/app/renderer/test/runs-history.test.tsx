// @vitest-environment happy-dom
/**
 * The Runs surface over a large history (#340): the list is read a page at a time and never
 * whole, older pages come by `cursor` on a 2.8 daemon and by `offset` on an older one, a page
 * that answers after the filter changed is dropped, and a link to a run no page holds yet
 * still opens it.
 */
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { STATUS_PRESENTATION } from "@orca/design";
import type { RunSummaryView } from "@orca/protocol";
import { RunsSurface, type RunsSurfaceProps } from "../src/runs/runs-surface.js";
import { RUNS, RUN_DETAILS } from "./fixtures.js";
import { installBridge, harness } from "./harness.js";
import { runsPage, type FakeBridge } from "./fake-bridge.js";

let fake: FakeBridge;
const teardown: (() => void)[] = [];

/** 250 finished runs a minute apart, newest first, as the daemon orders them. */
const HISTORY: readonly RunSummaryView[] = Array.from({ length: 250 }, (_, i) => {
  const n = 249 - i;
  const base = RUNS.find((r) => r.id === "run-old")!;
  return {
    ...base,
    id: `run-h${String(n).padStart(3, "0")}`,
    name: `History ${n}`,
    createdAt: new Date(Date.UTC(2026, 1, 1) + n * 60_000).toISOString(),
  };
});

function scriptHistory(): void {
  fake.script({
    "runs.list": (params) => {
      const rows = HISTORY.filter((r) => !params.status?.length || params.status.includes(r.status));
      return { ok: true, result: runsPage(rows, params.cursor, params.offset ?? 0, params.limit ?? 100) };
    },
    "runs.get": ({ runId }) => {
      const run = HISTORY.find((r) => r.id === runId);
      if (!run) return { ok: false, error: { code: "RUN_NOT_FOUND", message: `no run ${runId}` } };
      return {
        ok: true,
        result: { ...RUN_DETAILS["run-parent"]!, run, steps: [], traversal: [], artifacts: [], vars: {} },
      };
    },
  });
}

function Surface(props: Partial<RunsSurfaceProps>): JSX.Element {
  return <RunsSurface connection="live" {...props} />;
}

function renderRuns(props: Partial<RunsSurfaceProps> = {}): (next: Partial<RunsSurfaceProps>) => void {
  const h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  const view = render(
    <Providers>
      <Surface {...props} />
    </Providers>,
  );
  return (next) =>
    view.rerender(
      <Providers>
        <Surface {...next} />
      </Providers>,
    );
}

const listCalls = () => fake.calls.filter((c) => c.method === "runs.list").map((c) => c.params);
const older = () => screen.queryByRole("button", { name: /older runs/ });
const count = (text: RegExp) => screen.getByText(text);
const tree = () => screen.getByRole("tree", { name: "Run tree" });

describe("the Runs surface over a large history", () => {
  beforeEach(() => {
    fake = installBridge();
    scriptHistory();
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("reads one page, then pages back by cursor until the store has nothing older", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    expect(count(/100\sof\s250\sruns/)).toBeTruthy();
    expect(listCalls()).toEqual([{}]);

    fireEvent.click(older()!);
    await waitFor(() => expect(count(/200\sof\s250\sruns/)).toBeTruthy());
    // The second read continues from the first page's last row, and is one page long.
    expect(listCalls()[1]).toEqual({ limit: 100, cursor: `${HISTORY[99]!.createdAt}|${HISTORY[99]!.id}` });

    fireEvent.click(older()!);
    await waitFor(() => expect(count(/^250\sruns$/)).toBeTruthy());
    expect(listCalls()).toHaveLength(3);
    // Nothing older: the way back goes, rather than offering a read that returns nothing.
    expect(older()).toBeNull();
  });

  it("pages a 2.7 daemon by offset, since it would answer a cursor with the first page again", async () => {
    fake.connect({ ...fake.connection, versions: { app: "2.8", daemon: "2.7" } });
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    fireEvent.click(older()!);
    await waitFor(() => expect(count(/200\sof\s250\sruns/)).toBeTruthy());
    expect(listCalls()[1]).toEqual({ limit: 100, offset: 100 });
    fireEvent.click(older()!);
    await waitFor(() => expect(older()).toBeNull());
    expect(listCalls()[2]).toEqual({ limit: 100, offset: 200 });
  });

  it("keeps one page in flight, and drops one that answers after the filter changed", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    const release = fake.hold("runs.list");
    fireEvent.click(older()!);
    // In flight: the control says so, and a second press asks nothing more.
    const busy = await screen.findByRole("button", { name: "Loading older runs" });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(busy);
    expect(listCalls()).toHaveLength(2);

    // The filter changes while the older page is still out.
    fireEvent.click(screen.getByRole("button", { name: /Filter by status/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: STATUS_PRESENTATION.failed.word }));
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(listCalls()).toHaveLength(3));
    await waitFor(() => expect(count(/100\sof\s250\sruns/)).toBeTruthy());
    // The superseded page never landed: the new filter's list is its own first page.
    expect(
      within(tree())
        .queryAllByRole("treeitem")
        .some((row) => row.id === `tree-row-${HISTORY[150]!.id}`),
    ).toBe(false);
    expect(listCalls()[2]).toEqual({ status: ["failed"] });
  });

  it("opens a link to a run no page holds yet, by reading that one run", async () => {
    const target = HISTORY[200]!;
    renderRuns({ open: { runId: target.id } });
    await waitFor(() => expect(fake.calls.some((c) => c.method === "runs.get")).toBe(true));
    const read = fake.calls.find((c) => c.method === "runs.get")!;
    expect(read.params).toEqual({ runId: target.id });
    // The run is in the tree, selected, and the history count did not grow a phantom row.
    await waitFor(() =>
      expect(screen.getByRole("treeitem", { name: new RegExp(target.name) }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
    expect(count(/101\sof\s250\sruns/)).toBeTruthy();
    // Only that run was read: no page was fetched to find it.
    expect(listCalls()).toHaveLength(1);
  });

  it("keeps a link pending through a failed read, and opens it when a reconnect reads it", async () => {
    const target = HISTORY[200]!;
    let failing = true;
    fake.script({
      "runs.get": ({ runId }) => {
        if (failing) return { ok: false, error: { code: "DAEMON_UNAVAILABLE", message: "connection reset" } };
        const run = HISTORY.find((r) => r.id === runId)!;
        return {
          ok: true,
          result: { ...RUN_DETAILS["run-parent"]!, run, steps: [], traversal: [], artifacts: [], vars: {} },
        };
      },
    });
    renderRuns({ open: { runId: target.id } });
    await waitFor(() => expect(fake.calls.filter((c) => c.method === "runs.get")).toHaveLength(1));
    await screen.findByRole("tree", { name: "Run tree" });
    // Not an answer about the run: nothing is selected, and nothing marks the link as dead.
    expect(
      within(tree())
        .queryAllByRole("treeitem")
        .some((row) => row.getAttribute("aria-selected") === "true"),
    ).toBe(false);

    // The transport comes back: the list is read again, and so is the link's run.
    failing = false;
    act(() => fake.connect({ ...fake.connection, generation: 1 }));
    await waitFor(() => expect(fake.calls.filter((c) => c.method === "runs.get")).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByRole("treeitem", { name: new RegExp(target.name) }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
  });

  it("selects nothing for a link to a run the daemon does not know, and stops asking", async () => {
    renderRuns({ open: { runId: "run-gone" } });
    await waitFor(() => expect(fake.calls.filter((c) => c.method === "runs.get")).toHaveLength(1));
    await screen.findByRole("tree", { name: "Run tree" });
    expect(
      within(tree())
        .queryAllByRole("treeitem")
        .some((row) => row.getAttribute("aria-selected") === "true"),
    ).toBe(false);
    expect(fake.calls.filter((c) => c.method === "runs.get")).toHaveLength(1);
  });
});
