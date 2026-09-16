import { describe, expect, it } from "vitest";
import { reduceRun, type OrcaEvent } from "@orca/core";

let seq = 0;
const ev = (type: OrcaEvent["type"], payload: unknown): OrcaEvent => ({ id: `evt_${seq}`, seq: seq++, runId: "run_1", at: "2026-01-01T00:00:00.000Z", type, payload } as OrcaEvent);

describe("reduceRun", () => {
  it("projects events into run state", () => {
    const events: OrcaEvent[] = [
      ev("run.created", { workflowId: "wf", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: { a: 1 } }),
      ev("run.started", {}),
      ev("step.scheduled", { stepRunId: "step_1", nodeId: "plan", nodeType: "agent", attempt: 1 }),
      ev("step.started", { stepRunId: "step_1", inputArtifactIds: [] }),
      ev("step.waiting", { stepRunId: "step_1", on: "agent-turn" }),
      ev("artifact.recorded", { stepRunId: "step_1", artifact: { id: "art_1", kind: "intent", name: "intent", mediaType: "text/markdown", contentHash: "h", size: 1, version: 1, producedBy: { runId: "run_1" }, parents: [], data: {}, createdAt: "t" } }),
      ev("step.completed", { stepRunId: "step_1", result: { artifactIds: ["art_1"], data: {} } }),
      ev("vars.set", { vars: { b: 2 } }),
      ev("run.completed", { outcome: "success" }),
    ];
    const s = reduceRun(events);
    expect(s.run.status).toBe("completed");
    expect(s.run.vars).toEqual({ a: 1, b: 2 });
    expect(s.steps.step_1?.status).toBe("completed");
    expect(s.steps.step_1?.result?.artifactIds).toEqual(["art_1"]);
    expect(Object.keys(s.artifacts)).toEqual(["art_1"]);
    expect(s.lastSeq).toBe(8);
  });
  it("tracks child runs per branch with their final status", () => {
    const events: OrcaEvent[] = [
      ev("run.created", { workflowId: "wf", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} }),
      ev("run.started", {}),
      ev("step.scheduled", { stepRunId: "step_1", nodeId: "par", nodeType: "parallel", attempt: 2 }),
      ev("child.spawned", { stepRunId: "step_1", childRunId: "run_a", branch: "a", resumed: true }),
      ev("child.spawned", { stepRunId: "step_1", childRunId: "run_b", branch: "b" }),
      ev("child.finished", { stepRunId: "step_1", childRunId: "run_a", status: "completed", outcome: "success" }),
    ];
    const s = reduceRun(events);
    expect(s.steps.step_1?.childRunIds).toEqual(["run_a", "run_b"]);
    expect(s.steps.step_1?.children).toEqual([
      { runId: "run_a", branch: "a", resumed: true, status: "completed", outcome: "success" },
      { runId: "run_b", branch: "b" },
    ]);
  });
  it("rejects logs that do not start with run.created", () => {
    expect(() => reduceRun([ev("run.started", {})])).toThrow(/run.created/);
  });
});
