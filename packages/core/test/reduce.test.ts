import { describe, expect, it } from "vitest";
import { reduceRun, reduceRunSummary, runSummary, RUN_SUMMARY_EVENT_TYPES, type OrcaEvent } from "@orca/core";

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
  it("keeps artifact ids recorded during a step when step.completed does not repeat them", () => {
    const art = (id: string) => ({ id, kind: "decision", name: "decision", mediaType: "application/json", contentHash: "h", size: 1, version: 1, producedBy: { runId: "run_1" }, parents: [], data: {}, createdAt: "t" });
    const events: OrcaEvent[] = [
      ev("run.created", { workflowId: "wf", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} }),
      ev("run.started", {}),
      ev("step.scheduled", { stepRunId: "step_1", nodeId: "decide", nodeType: "decision", attempt: 1 }),
      ev("step.started", { stepRunId: "step_1", inputArtifactIds: [] }),
      ev("artifact.recorded", { stepRunId: "step_1", artifact: art("art_1") }),
      ev("artifact.recorded", { stepRunId: "step_1", artifact: art("art_2") }),
      ev("decision.resolved", { stepRunId: "step_1", choice: "approve", source: "agent" }),
      // Executor result repeats one recorded id, adds a new one, and omits art_2.
      ev("step.completed", { stepRunId: "step_1", result: { choice: "approve", artifactIds: ["art_1", "art_3"], data: { k: 1 } } }),
    ];
    const s = reduceRun(events);
    const r = s.steps.step_1?.result;
    expect(r?.artifactIds).toEqual(["art_1", "art_2", "art_3"]);
    expect(r?.choice).toBe("approve");
    expect(r?.data).toEqual({ k: 1 });
  });
  it("uses the step.completed result as-is when nothing was recorded during the step", () => {
    const events: OrcaEvent[] = [
      ev("run.created", { workflowId: "wf", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} }),
      ev("step.scheduled", { stepRunId: "step_1", nodeId: "noop", nodeType: "noop", attempt: 1 }),
      ev("step.started", { stepRunId: "step_1", inputArtifactIds: [] }),
      ev("step.completed", { stepRunId: "step_1", result: { artifactIds: ["art_9"], data: {} } }),
    ];
    expect(reduceRun(events).steps.step_1?.result).toEqual({ artifactIds: ["art_9"], data: {} });
  });
  it("rejects logs that do not start with run.created", () => {
    expect(() => reduceRun([ev("run.started", {})])).toThrow(/run.created/);
  });
});

describe("reduceRunSummary", () => {
  /** The summary reducer mirrors applyEvent's run-level cases; these logs pin them together. */
  // Built lazily: `ev` shares a sequence counter with the tests above.
  const logs: Record<string, () => OrcaEvent[]> = {
    "waiting on a step": () => [
      ev("run.created", { workflowId: "wf", workflowVersion: "1", requestId: "req_1", parentRunId: "run_0", workspace: { hostId: "local", cwd: "/w" }, vars: { a: 1 } }),
      ev("run.started", {}),
      ev("step.scheduled", { stepRunId: "step_1", nodeId: "plan", nodeType: "agent", attempt: 1 }),
      ev("step.started", { stepRunId: "step_1", inputArtifactIds: [] }),
      ev("step.waiting", { stepRunId: "step_1", on: "agent-turn" }),
      ev("agent.update", { stepRunId: "step_1", sessionId: "s", update: { kind: "agent_message_chunk", text: 'noise "type":"run.completed" noise' } }),
    ],
    "back to running after the step finishes": () => [
      ev("run.created", { workflowId: "wf", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} }),
      ev("run.started", {}),
      ev("step.scheduled", { stepRunId: "step_1", nodeId: "plan", nodeType: "agent", attempt: 1 }),
      ev("step.waiting", { stepRunId: "step_1", on: "agent-turn" }),
      ev("step.completed", { stepRunId: "step_1", result: { artifactIds: [], data: {} } }),
    ],
    "paused then resumed and completed": () => [
      ev("run.created", { workflowId: "wf", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} }),
      ev("run.started", {}),
      ev("run.paused", { reason: "human gate" }),
      ev("run.resumed", {}),
      ev("run.completed", { outcome: "success" }),
    ],
    failed: () => [
      ev("run.created", { workflowId: "wf", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} }),
      ev("run.started", {}),
      ev("run.failed", { error: { code: "STEP_FAILED", message: "boom" } }),
    ],
    cancelled: () => [
      ev("run.created", { workflowId: "wf", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} }),
      ev("run.cancelled", { reason: "user" }),
    ],
  };
  for (const [name, log] of Object.entries(logs)) {
    it(`matches the full projection: ${name}`, () => {
      const events = log();
      const full = runSummary(reduceRun(events));
      expect(reduceRunSummary(events)).toEqual(full);
      expect(reduceRunSummary(events.filter((e) => (RUN_SUMMARY_EVENT_TYPES as readonly OrcaEvent["type"][]).includes(e.type)))).toEqual(full);
    });
  }
  it("rejects logs that do not start with run.created", () => {
    expect(() => reduceRunSummary([ev("run.started", {})])).toThrow(/run.created/);
  });
});
