/** Reading ORCA's own file executor's record (#703). */
import { describe, expect, it } from "vitest";
import { ownedFsExecutions, type OrcaEvent } from "../src/index.js";

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>): OrcaEvent =>
  ({ id: `evt_${seq}`, seq: seq++, runId: "run_1", at: "2026-01-01T00:00:00.000Z", type, payload }) as OrcaEvent;
const authorized = (operationId: string) =>
  ev("agent.fs.authorized", {
    stepRunId: "s",
    sessionId: "x",
    operationId,
    access: "write",
    path: "/w/a",
    decision: "allow",
  });
const completed = (operationId: string, outcome: string) =>
  ev("agent.fs.completed", { stepRunId: "s", sessionId: "x", operationId, outcome });

describe("ownedFsExecutions", () => {
  it("gives each authorization its outcome, and none is execution-unknown", () => {
    const ops = ownedFsExecutions([
      authorized("a"),
      completed("a", "completed"),
      authorized("b"),
      completed("b", "failed"),
      authorized("c"),
      completed("c", "not-dispatched"),
      authorized("d"),
    ]);
    expect(ops.map((o) => [o.operationId, o.state])).toEqual([
      ["a", "completed"],
      ["b", "failed"],
      ["c", "not-dispatched"],
      ["d", "execution-unknown"],
    ]);
  });

  it("takes an outcome once, only after its authorization, and never lets a repeat reset it", () => {
    const ops = ownedFsExecutions([
      completed("a", "completed"),
      authorized("a"),
      authorized("b"),
      completed("b", "failed"),
      completed("b", "completed"),
      authorized("b"),
    ]);
    expect(ops.map((o) => [o.operationId, o.state])).toEqual([
      ["a", "execution-unknown"],
      ["b", "failed"],
    ]);
  });
});
