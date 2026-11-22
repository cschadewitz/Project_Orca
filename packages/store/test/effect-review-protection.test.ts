/** #357: side-effect evidence and review decisions survive redaction even when a secret collides with them. */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { reduceRun, type OrcaEventInput } from "@orca/core";
import { FileExecutionStore, JsonlEventStore, ProtectedEventStore, executionEvents } from "@orca/store";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("keeps step.failed effect and step.effect.reviewed decision through the protected store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-effect-protection-"));
  directories.push(dir);
  const runId = "run-effect";
  // Secrets that collide with the enum values, and one only the note carries.
  const secrets = ["none", "run-again", "abandon", "private-review-note"];
  const execution = new FileExecutionStore(dir);
  await execution.putInputs({ runId, workflowId: "wf", workflowVersion: "1", vars: {}, sensitiveNames: [], secrets });
  const events = new ProtectedEventStore(new JsonlEventStore(dir), execution);
  const log: Omit<OrcaEventInput, "runId">[] = [
    {
      type: "run.created",
      payload: {
        workflowId: "wf",
        workflowVersion: "1",
        workspace: { hostId: "h", cwd: "/" },
        vars: {},
        executionInputsStored: true,
      },
    },
    { type: "run.started", payload: {} },
    { type: "step.scheduled", payload: { stepRunId: "s1", nodeId: "a", nodeType: "custom:x", attempt: 1 } },
    { type: "step.started", payload: { stepRunId: "s1", inputArtifactIds: [] } },
    {
      type: "step.failed",
      payload: { stepRunId: "s1", error: { code: "X", message: "none" }, willRetry: true, effect: "none" },
    },
    { type: "step.scheduled", payload: { stepRunId: "s2", nodeId: "a", nodeType: "custom:x", attempt: 2 } },
    { type: "step.started", payload: { stepRunId: "s2", inputArtifactIds: [] } },
    { type: "run.failed", payload: { error: { code: "X", message: "lost" } } },
    {
      type: "step.effect.reviewed",
      payload: { stepRunId: "s2", decision: "run-again", note: "private-review-note" },
    },
  ];
  for (const event of log) await events.append({ ...event, runId } as OrcaEventInput);

  const restarted = new ProtectedEventStore(new JsonlEventStore(dir), new FileExecutionStore(dir));
  const stored = await restarted.read(runId);
  const publicState = reduceRun(stored);
  expect(publicState.steps.s1!.noEffect).toBe(true);
  expect(publicState.steps.s2!.effectReview).toMatchObject({ decision: "run-again" });
  expect(JSON.stringify(stored)).not.toContain("private-review-note");
  const restored = reduceRun(await executionEvents(stored, new FileExecutionStore(dir)));
  expect(restored.steps.s2!.effectReview).toMatchObject({ decision: "run-again", note: "private-review-note" });
});
