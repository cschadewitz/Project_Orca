/** `orca recovery` text (#357 phase 1): every blocker in words, uncertain effects called out, nothing implied run. */
import { expect, it } from "vitest";
import { assessRecovery, RECOVERY_BLOCKER_TEXT, type StepRun } from "@orca/core";
import { formatRecovery } from "../src/commands/recovery.js";

const at = "2026-11-22T00:00:00.000Z";
const step = (id: string, nodeId: string, status: StepRun["status"]): StepRun => ({
  id,
  runId: "run_1",
  nodeId,
  nodeType: "agent",
  attempt: 1,
  status,
  inputArtifactIds: [],
  childRunIds: [],
  children: [],
  skippedBranches: [],
  scheduledAt: at,
  startedAt: at,
  ...(status === "completed" ? { result: { artifactIds: [], data: {} } } : {}),
});

it("lists options with reasons, the uncertain step, and one checkpoint in detail", () => {
  const a = assessRecovery({
    state: {
      run: {
        id: "run_1",
        workflowId: "wf",
        workflowVersion: "1",
        status: "failed",
        workspace: { hostId: "h", cwd: "/" },
        vars: {},
        createdAt: at,
      },
      steps: { s1: step("s1", "spec", "completed"), s2: step("s2", "build", "failed") },
      stepOrder: ["s1", "s2"],
      artifacts: {},
      humanInputs: {},
      lastSeq: 0,
    },
    workflowStored: true,
    workflowReadable: true,
    executionInputsAvailable: true,
    leased: false,
    resumeTargetRunId: "run_1",
    artifactPresent: () => true,
    currentWorkflowVersion: "2",
  });
  const text = formatRecovery(a, "spec").join("\n");
  expect(text).toContain("Resume: not available");
  expect(text).toContain(RECOVERY_BLOCKER_TEXT.terminal);
  expect(text).toContain("Checkpoint attempt: available");
  expect(text).toContain("Review before anything runs these again:\n  build attempt 1: uncertain");
  expect(text).toContain("after spec: eligible\n    Reuses:\n      spec attempt 1: reused");
  expect(text).toContain("The workflow is now at 2; recovery from history uses 1.");
  expect(text).toMatch(/^Nothing was changed\. Approvals and permissions are never carried forward/m);
});
