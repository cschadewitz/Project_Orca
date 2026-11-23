// @vitest-environment happy-dom
/**
 * Dry runs in the Runs surface (#183): never listed as work - `runs.list` leaves them out, and
 * one a notification names is read once and kept out - but a link opens one, and then every
 * status chip in its tree reads "… · dry" and the header names the draft revision it ran.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { NotificationMessage, RunSummaryView } from "@orca/protocol";
import type { Crumb } from "../src/ui/index.js";
import { RunsSurface } from "../src/runs/runs-surface.js";
import { buildTree } from "../src/runs/tree/tree-rows.js";
import { AS_OF, RUNS, RUN_DETAILS } from "./fixtures.js";
import { installBridge, harness } from "./harness.js";
import type { FakeBridge } from "./fake-bridge.js";

let fake: FakeBridge;
const teardown: (() => void)[] = [];

const DRY: RunSummaryView = {
  ...RUNS.find((run) => run.id === "run-parent")!,
  id: "run-dry",
  name: "ai-sdlc",
  workflowId: "ai-sdlc",
  workflowVersion: "1+dryrun.0123456789abcdef",
  status: "running",
  dryRun: { definitionRevision: "sha256:def", draftRevision: 4 },
};

const runChanged = (runId: string, seq: number): NotificationMessage => ({
  kind: "notification",
  method: "run.changed",
  params: {
    subscriptionId: "sub-1",
    runId,
    seq,
    at: "2026-03-01T09:01:00.000Z",
    status: "running",
    event: "run.started",
  },
});

function renderRuns(props: { open?: { runId: string }; onCrumbs?: (crumbs: readonly Crumb[]) => void } = {}) {
  const h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      <RunsSurface connection="live" {...props} />
    </Providers>,
  );
}

const rows = (): HTMLElement[] => within(screen.getByRole("tree", { name: "Run tree" })).getAllByRole("treeitem");
const gets = () =>
  fake.calls.filter((c) => c.method === "runs.get" && (c.params as { runId: string }).runId === DRY.id);

describe("dry runs in the Runs surface", () => {
  beforeEach(() => {
    fake = installBridge();
    fake.script({
      "runs.list": () => ({ ok: true, result: { runs: [...RUNS], total: RUNS.length, asOf: AS_OF } }),
      "runs.get": ({ runId }) =>
        runId === DRY.id
          ? {
              ok: true,
              result: { ...RUN_DETAILS["run-parent"]!, run: DRY, steps: [], traversal: [], artifacts: [], vars: {} },
            }
          : { ok: true, result: RUN_DETAILS[runId] ?? RUN_DETAILS["run-parent"]! },
    });
  });
  afterEach(() => {
    cleanup();
    while (teardown.length) teardown.pop()?.();
  });

  it("keeps a dry run a notification names out of the list, and reads it only once", async () => {
    renderRuns();
    await screen.findByRole("tree", { name: "Run tree" });
    await act(async () => fake.notify(runChanged(DRY.id, 1)));
    await waitFor(() => expect(gets()).toHaveLength(1));
    await act(async () => fake.notify(runChanged(DRY.id, 2)));
    await act(async () => {});
    expect(rows()).toHaveLength(RUNS.length);
    expect(rows().some((row) => row.id === `tree-row-${DRY.id}`)).toBe(false);
    expect(gets()).toHaveLength(1);
  });

  it("opens a dry run a link names, marked dry on its chip and in its header", async () => {
    let crumbs: readonly Crumb[] = [];
    renderRuns({
      open: { runId: DRY.id },
      onCrumbs: (next) => {
        crumbs = next;
      },
    });
    const row = await waitFor(() => {
      const found = rows().find((r) => r.id === `tree-row-${DRY.id}`);
      expect(found).toBeTruthy();
      return found!;
    });
    expect(row.textContent).toContain("running · dry");
    await waitFor(() =>
      expect(crumbs.find((c) => c.type === "run")?.version).toBe("dry run · ai-sdlc draft revision 4"),
    );
    // No counterpart to the published workflow: the viewer would overlay a graph it never ran.
    expect(crumbs.find((c) => c.type === "run")?.counterpartIds).toBeUndefined();
  });

  it("marks every row of a dry run's tree dry, and no other tree's", () => {
    const parent = RUN_DETAILS["run-parent"]!;
    const dryRoot = { ...RUNS.find((run) => run.id === "run-parent")!, dryRun: DRY.dryRun };
    const built = buildTree({
      roots: [dryRoot, RUNS.find((run) => run.id === "run-old")!],
      details: new Map([["run-parent", parent]]),
      expanded: new Set(["run-parent"]),
    });
    const dry = built.filter((row) => row.dry);
    expect(dry.length).toBeGreaterThan(1);
    expect(dry.every((row) => row.key.startsWith("run-parent"))).toBe(true);
    expect(built.find((row) => row.runId === "run-old")?.dry).toBeUndefined();
  });
});
