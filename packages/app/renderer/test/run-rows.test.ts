/**
 * The Runs list's arithmetic, without a DOM: ordering, the text filter, and folding a
 * `run.changed` into a row.
 *
 * `runs-surface.test.tsx` proves the screen wires these up; this proves the edges a screen
 * test would have to contrive a store to reach — a clock that stepped backwards, a
 * transition that arrives before the run has a `startedAt`, two runs created in the same
 * millisecond.
 */
import { describe, expect, it } from "vitest";
import { DISPLAY_STATUSES, type RunChangedParams, type RunSummaryView } from "@orca/protocol";
import { applyRunChanged, isTerminal, matchesText, mergeRun, orderRuns } from "../src/runs/run-rows.js";

const run = (over: Partial<RunSummaryView> = {}): RunSummaryView => ({
  id: "run-1",
  name: "Add the SSO callback",
  workflowId: "sdlc",
  workflowVersion: "2",
  status: "running",
  createdAt: "2026-03-01T09:00:01.000Z",
  startedAt: "2026-03-01T09:00:02.000Z",
  ...over,
});

const changed = (over: Partial<RunChangedParams> = {}): RunChangedParams => ({
  subscriptionId: "sub-1",
  runId: "run-1",
  seq: 7,
  at: "2026-03-01T09:01:02.000Z",
  status: "succeeded",
  event: "run.completed",
  ...over,
});

describe("ordering", () => {
  it("is newest first by creation, and stable on a tie, broken as the daemon breaks it", () => {
    const a = run({ id: "run-a", createdAt: "2026-03-01T09:00:00.000Z" });
    const b = run({ id: "run-b", createdAt: "2026-03-01T09:00:00.000Z" });
    const c = run({ id: "run-c", createdAt: "2026-03-01T09:00:05.000Z" });

    // Id descending on a tie, as `runs.list` pages: a later page must not swap across the boundary.
    expect(orderRuns([a, b, c]).map((r) => r.id)).toEqual(["run-c", "run-b", "run-a"]);
    expect(orderRuns([b, c, a]).map((r) => r.id)).toEqual(["run-c", "run-b", "run-a"]);
  });

  it("replaces a row it already holds rather than duplicating it", () => {
    const before = [run({ id: "run-1", name: "old" })];
    const after = mergeRun(before, run({ id: "run-1", name: "new" }));

    expect(after).toHaveLength(1);
    expect(after[0]!.name).toBe("new");
  });
});

describe("the text filter", () => {
  it("matches nothing in particular when it is empty", () => {
    expect(matchesText(run(), "")).toBe(true);
    expect(matchesText(run(), "   ")).toBe(true);
  });

  it("matches the name, the id, the workflow, the agent and the work item's slug", () => {
    const r = run({ agentId: "claude-code", workItem: { id: "wi-1", slug: "auth-api", title: "x", status: "todo" } });
    for (const needle of ["SSO", "sso", "run-1", "sdlc", "claude", "auth-api"]) {
      expect(matchesText(r, needle), needle).toBe(true);
    }
    expect(matchesText(r, "nothing here")).toBe(false);
  });
});

describe("folding a run.changed into a row", () => {
  it("knows which of the eight statuses end a run", () => {
    expect(DISPLAY_STATUSES.filter(isTerminal)).toEqual(["succeeded", "failed", "cancelled"]);
  });

  it("finishes the row and totals its duration on a terminal transition", () => {
    const next = applyRunChanged(run(), changed({ outcome: "success" }));

    expect(next.status).toBe("succeeded");
    expect(next.outcome).toBe("success");
    expect(next.finishedAt).toBe("2026-03-01T09:01:02.000Z");
    expect(next.durationMs).toBe(60_000);
  });

  it("carries the error of a failure through to the row", () => {
    const error = { code: "STEP_TIMEOUT", message: "the build never finished" };
    const next = applyRunChanged(run(), changed({ status: "failed", outcome: "failure", error }));

    expect(next.status).toBe("failed");
    expect(next.error).toEqual(error);
  });

  it("starts the clock when the transition is the one that started the run", () => {
    const next = applyRunChanged(run({ startedAt: undefined }), changed({ status: "running", event: "run.started" }));

    expect(next.startedAt).toBe("2026-03-01T09:01:02.000Z");
    expect(next.durationMs).toBeUndefined();
  });

  it("leaves a run that finished without ever starting with no duration at all", () => {
    const next = applyRunChanged(run({ startedAt: undefined }), changed({ status: "cancelled" }));

    expect(next.finishedAt).toBe("2026-03-01T09:01:02.000Z");
    expect(next.durationMs).toBeUndefined();
  });

  it("clamps rather than printing a negative duration when the clock stepped backwards", () => {
    const next = applyRunChanged(run({ startedAt: "2026-03-01T09:05:00.000Z" }), changed());

    expect(next.durationMs).toBe(0);
  });

  it("does not touch the row's identity, name or workflow", () => {
    const next = applyRunChanged(run(), changed({ status: "waiting" }));

    expect(next.id).toBe("run-1");
    expect(next.name).toBe("Add the SSO callback");
    expect(next.workflowId).toBe("sdlc");
    expect(next.finishedAt).toBeUndefined();
  });
});
