/**
 * The run tree's arithmetic, without a DOM: the grouping, the levels, the filter and the
 * two notification folds.
 *
 * The fixture is `run-parent` from `fixtures.ts`, which is the story #156 asks a test to
 * cover — a `parallel` fan-out with one finished child, one child whose log is gone, one
 * skipped branch, and a `build` node that was retried after a transport failure. The tree
 * it produces is asserted row by row, because "the tree looks right" is a claim about an
 * order and a set of levels and nothing else.
 */
import { describe, expect, it } from "vitest";
import type { RunChangedParams, RunsGetResult, StepChangedParams } from "@orca/protocol";
import {
  applyRunChangedToDetail,
  applyStepChanged,
  buildTree,
  descendants,
  filterAttention,
  groupSteps,
  MAX_INDENT,
  parentIndex,
  treeRowId,
  type TreeRow,
} from "../src/runs/tree/tree-rows.js";
import { RUNS, RUN_DETAILS } from "./fixtures.js";

const PARENT = RUN_DETAILS["run-parent"]!;
const roots = RUNS.filter((run) => run.id === "run-parent");
const details = new Map<string, RunsGetResult>([["run-parent", PARENT]]);

/** A row said the way a test reads it: kind, level, name, status. */
const shape = (rows: readonly TreeRow[]): string[] =>
  rows.map((row) => `${row.kind} ${row.level} ${row.name} ${row.status ?? row.note ?? ""}`.trim());

const build = (expanded: string[]): TreeRow[] => buildTree({ roots, details, expanded: new Set(expanded) });

describe("the run tree's rows", () => {
  it("is the roots alone until something is opened", () => {
    expect(shape(build([]))).toEqual(["run 0 Add the SSO callback running"]);
    expect(build([])[0]!.hasChildren).toBe(true);
  });

  it("groups a retried node into one row at its highest attempt", () => {
    const rows = build(["run-parent"]);

    expect(shape(rows)).toEqual([
      "run 0 Add the SSO callback running",
      "step 1 build succeeded",
      "step 1 fanout running",
    ]);
    // Two attempts, so the row says which; the earlier one is a child, not a sibling.
    expect(rows[1]!.attempt).toEqual({ n: 2, of: 2 });
    expect(rows[1]!.stepRunId).toBe("s-build-2");
    expect(rows[1]!.hasChildren).toBe(true);
    // One attempt: no "attempt 1 of 1" on a node nobody retried.
    expect(rows[2]!.attempt).toBeUndefined();
  });

  it("puts the earlier attempts under the newest one", () => {
    const rows = build(["run-parent", "run-parent/s-build-2"]);

    expect(shape(rows)).toEqual([
      "run 0 Add the SSO callback running",
      "step 1 build succeeded",
      "attempt 2 build failed",
      "step 1 fanout running",
    ]);
    expect(rows[2]!.attempt).toEqual({ n: 1, of: 2 });
    expect(rows[2]!.stepRunId).toBe("s-build-1");
  });

  it("draws the whole fan-out: both children, the stale one, and the branch that never ran", () => {
    const rows = build(["run-parent", "run-parent/s-fan"]);

    expect(shape(rows)).toEqual([
      "run 0 Add the SSO callback running",
      "step 1 build succeeded",
      "step 1 fanout running",
      "child-run 2 Wire the login button succeeded",
      "child-run 2 run-child-gone stale",
      "note 2 auth-perf a dependency was not met",
    ]);
    // A skipped branch has no status: it never became a run, and giving it one would be a
    // ninth status or an invented state (rules 3 and 12).
    expect(rows[5]!.status).toBeUndefined();
    expect(rows[5]!.branch).toBe("auth-perf");
  });

  it("keeps a key per path, so the same run opened twice is two rows", () => {
    const rows = build(["run-parent", "run-parent/s-fan"]);
    expect(rows.map((row) => row.key)).toEqual([
      "run-parent",
      "run-parent/s-build-2",
      "run-parent/s-fan",
      "run-parent/s-fan/run-child-ok",
      "run-parent/s-fan/run-child-gone",
      "run-parent/s-fan/!auth-perf",
    ]);
    expect(treeRowId("run-parent/s-fan")).toBe("tree-row-run-parent/s-fan");
  });

  it("marks a running run for the indeterminate meter and nothing else", () => {
    const rows = build(["run-parent", "run-parent/s-fan"]);
    // The run is running, and so is the fan-out step — but only the run carries the meter.
    expect(rows.filter((row) => row.meter).map((row) => row.key)).toEqual(["run-parent"]);
  });

  it("stops indenting past six levels", () => {
    const deep: TreeRow[] = Array.from({ length: 9 }, (_unused, level) => ({
      key: `k${level}`,
      kind: "step",
      level,
      indent: Math.min(level, MAX_INDENT),
      name: `n${level}`,
      runId: "r",
      hasChildren: false,
      expanded: false,
      loading: false,
      ancestors: [],
      meter: false,
    }));
    expect(deep.map((row) => row.indent)).toEqual([0, 1, 2, 3, 4, 5, 6, 6, 6]);
  });

  it("groups by node and iteration, and orders the attempts inside a group", () => {
    const groups = groupSteps([
      { ...PARENT.steps[0]!, iteration: 1 },
      { ...PARENT.steps[1]!, iteration: 0 },
      PARENT.steps[0]!,
    ]);
    expect(groups.map((g) => `${g.nodeId}#${g.iteration ?? ""}`)).toEqual(["build#1", "build#0", "build#"]);
  });

  it("walks up and down a flattened tree", () => {
    const rows = build(["run-parent", "run-parent/s-fan"]);
    expect(descendants(rows, 2).map((row) => row.name)).toEqual([
      "Wire the login button",
      "run-child-gone",
      "auth-perf",
    ]);
    expect(parentIndex(rows, 3)).toBe(2);
    expect(parentIndex(rows, 0)).toBeUndefined();
  });

  it("keeps the failed and the waiting, and what leads to them", () => {
    const rows = build(["run-parent", "run-parent/s-build-2", "run-parent/s-fan"]);
    // The failed first attempt, and the run above it. Nothing else in this tree is failed
    // or waiting — the fan-out is running and the children succeeded or went stale.
    expect(shape(filterAttention(rows))).toEqual([
      "run 0 Add the SSO callback running",
      "step 1 build succeeded",
      "attempt 2 build failed",
    ]);
  });
});

const stepChanged = (over: Partial<StepChangedParams> & { stepRunId: string }): StepChangedParams => ({
  subscriptionId: "sub-1",
  runId: "run-parent",
  seq: 40,
  at: "2026-03-01T09:00:50.000Z",
  status: "running",
  event: "step.started",
  ...over,
});

describe("folding a notification into a projection", () => {
  it("repaints a step the projection already holds", () => {
    const next = applyStepChanged(PARENT, stepChanged({ stepRunId: "s-fan", status: "failed", event: "step.failed" }));
    expect(next.steps.find((s) => s.id === "s-fan")!.status).toBe("failed");
    // A terminal transition stops the clock and leaves a total, from two timestamps the
    // projection already held — not an estimate.
    expect(next.steps.find((s) => s.id === "s-fan")!.finishedAt).toBe("2026-03-01T09:00:50.000Z");
    expect(next.steps.find((s) => s.id === "s-fan")!.durationMs).toBe(37000);
    expect(next.lastSeq).toBe(40);
  });

  it("inserts a step it has never seen, from the step.scheduled that introduces it", () => {
    const next = applyStepChanged(
      PARENT,
      stepChanged({
        stepRunId: "s-deploy",
        status: "waiting",
        event: "step.scheduled",
        nodeId: "deploy",
        nodeType: "agent",
        attempt: 1,
      }),
    );
    expect(next.steps).toHaveLength(PARENT.steps.length + 1);
    expect(next.steps[next.steps.length - 1]).toMatchObject({ id: "s-deploy", nodeId: "deploy", status: "waiting" });
  });

  it("leaves the projection alone for a step it cannot draw", () => {
    // Every transition but `step.scheduled` carries only what changed, so there is no row
    // to invent from one about a step this projection has never heard of.
    expect(applyStepChanged(PARENT, stepChanged({ stepRunId: "s-unknown" }))).toBe(PARENT);
  });

  it("repaints a run as its own row and as somebody's child", () => {
    const params: RunChangedParams = {
      subscriptionId: "sub-1",
      runId: "run-child-ok",
      seq: 5,
      at: "2026-03-01T09:00:50.000Z",
      status: "failed",
      event: "run.failed",
    };
    const next = applyRunChangedToDetail(PARENT, params);
    expect(next.steps.find((s) => s.id === "s-fan")!.children[0]!.status).toBe("failed");
    // And the run's own summary, when the notification is about this run.
    const own = applyRunChangedToDetail(PARENT, { ...params, runId: "run-parent", status: "cancelled" });
    expect(own.run.status).toBe("cancelled");
  });

  it("is the same object when nothing moved, so the tree does not repaint", () => {
    const params: RunChangedParams = {
      subscriptionId: "sub-1",
      runId: "run-nobody-knows",
      seq: 5,
      at: "2026-03-01T09:00:50.000Z",
      status: "failed",
      event: "run.failed",
    };
    expect(applyRunChangedToDetail(PARENT, params)).toBe(PARENT);
  });
});
