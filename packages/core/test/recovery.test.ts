/** assessRecovery (#357 phase 1): pure eligibility rules, each refusal with its own reason. */
import { describe, expect, it } from "vitest";
import { assessRecovery, RECOVERY_BLOCKER_TEXT, RecoveryBlockerSchema, type RecoveryFacts } from "../src/index.js";
import type { RunState, StepRun } from "../src/schemas.js";

const at = "2026-11-22T00:00:00.000Z";
function stepRun(id: string, nodeId: string, status: StepRun["status"], extra: Partial<StepRun> = {}): StepRun {
  return {
    id,
    runId: "run",
    nodeId,
    nodeType: "agent",
    attempt: 1,
    status,
    inputArtifactIds: [],
    childRunIds: [],
    children: [],
    skippedBranches: [],
    scheduledAt: at,
    ...(status === "scheduled" ? {} : { startedAt: at }),
    ...(status === "completed" ? { result: { artifactIds: [], data: {} } } : {}),
    ...extra,
  };
}
function facts(status: RunState["run"]["status"], steps: StepRun[], extra: Partial<RecoveryFacts> = {}): RecoveryFacts {
  return {
    state: {
      run: {
        id: "run",
        workflowId: "wf",
        workflowVersion: "1",
        status,
        workspace: { hostId: "h", cwd: "/" },
        vars: {},
        createdAt: at,
      },
      steps: Object.fromEntries(steps.map((s) => [s.id, s])),
      stepOrder: steps.map((s) => s.id),
      artifacts: {},
      humanInputs: {},
      lastSeq: 0,
    },
    workflowStored: true,
    workflowReadable: true,
    executionInputsAvailable: true,
    leased: false,
    artifactPresent: () => true,
    ...extra,
  };
}
const option = (a: ReturnType<typeof assessRecovery>, kind: string) => a.options.find((o) => o.kind === kind)!;

describe("assessRecovery", () => {
  it("every blocker has an operator sentence", () => {
    for (const blocker of RecoveryBlockerSchema.options) expect(RECOVERY_BLOCKER_TEXT[blocker]).toMatch(/\.$/);
  });

  it("a completed or cancelled run offers a new run, not a checkpoint attempt", () => {
    for (const status of ["completed", "cancelled"] as const) {
      const a = assessRecovery(facts(status, [stepRun("s1", "a", "completed")]));
      expect(option(a, "checkpoint-attempt").blockers).toContain("not-failed");
      expect(option(a, "new-run").available).toBe(true);
      expect(option(a, "resume").blockers).toEqual(["terminal"]);
    }
  });

  it("a child run is resumed through its paused parent, and the parent is checked too", () => {
    const parentFacts = facts("paused", [stepRun("p1", "fan", "running")]);
    parentFacts.state.run.id = "parent";
    const f = facts("paused", [stepRun("s1", "a", "waiting")], { resumeAncestors: [parentFacts] });
    f.state.run.parentRunId = "parent";
    const a = assessRecovery(f);
    expect(option(a, "resume")).toMatchObject({ available: true, targetRunId: "parent" });
    // Both runs' unfinished steps are attempted again; the parent's first, as it is driven first.
    expect(option(a, "resume").runsAgain.map((s) => [s.runId, s.nodeId])).toEqual([
      ["parent", "fan"],
      ["run", "a"],
    ]);
    expect(option(a, "checkpoint-attempt").blockers).toEqual(expect.arrayContaining(["not-terminal", "child-run"]));

    for (const broken of [
      { leased: true, blocker: "leased" },
      { executionInputsAvailable: false, blocker: "execution-inputs-missing" },
      { workflowReadable: false, blocker: "workflow-missing" },
    ] as const) {
      const { blocker, ...fault } = broken;
      const g = facts("paused", [stepRun("s1", "a", "waiting")], { resumeAncestors: [{ ...parentFacts, ...fault }] });
      g.state.run.parentRunId = "parent";
      expect(option(assessRecovery(g), "resume")).toMatchObject({ available: false, blockers: [blocker] });
    }
  });

  it("unreadable history fails closed for every option that continues it", () => {
    const a = assessRecovery(
      facts("failed", [stepRun("s1", "a", "completed")], { executionInputsAvailable: false, workflowReadable: false }),
    );
    expect(option(a, "checkpoint-attempt").blockers).toEqual(
      expect.arrayContaining(["workflow-missing", "execution-inputs-missing"]),
    );
    const paused = assessRecovery(
      facts("paused", [stepRun("s1", "a", "waiting")], { executionInputsAvailable: false }),
    );
    expect(option(paused, "resume")).toMatchObject({ available: false, blockers: ["execution-inputs-missing"] });
  });

  it("a terminal step is not a checkpoint, and a run with nothing completed says so", () => {
    const end = stepRun("s2", "end", "completed", { result: { outcome: "failure", artifactIds: [], data: {} } });
    const a = assessRecovery(facts("failed", [stepRun("s1", "a", "failed"), end]));
    expect(a.checkpoints).toEqual([]);
    expect(option(a, "checkpoint-attempt").blockers).toContain("no-checkpoint");
  });

  it("a scheduled step that never started is not an uncertain effect; a skipped one is not either", () => {
    const a = assessRecovery(
      facts("failed", [
        stepRun("s1", "a", "completed"),
        stepRun("s2", "b", "skipped"),
        stepRun("s3", "c", "scheduled"),
      ]),
    );
    expect(a.uncertain).toEqual([]);
    expect(a.checkpoints[0]!.ranAfter.map((s) => s.effect)).toEqual(["not-started", "not-started"]);
  });

  it("no drift is reported when nothing is known about the current workflow or configuration", () => {
    expect(assessRecovery(facts("failed", [stepRun("s1", "a", "completed")])).drift).toBeUndefined();
  });
});
