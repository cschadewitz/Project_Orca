/** #357: a checkpoint attempt's seed keeps its structure through redaction; its data and vars stay private. */
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

it("round-trips a checkpoint seed whose identities collide with secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-checkpoint-protection-"));
  directories.push(dir);
  const runId = "run-attempt";
  // Values that collide with structural fields, plus one only the data and vars carry.
  const secrets = ["approve", "build", "s_src", 1, "private-token-value"];
  const execution = new FileExecutionStore(dir);
  await execution.putInputs({
    runId,
    workflowId: "wf",
    workflowVersion: "1",
    vars: { token: "private-token-value" },
    sensitiveNames: ["token"],
    secrets,
  });
  const events = new ProtectedEventStore(new JsonlEventStore(dir), execution);
  const artifact = {
    id: "art_1",
    kind: "spec",
    name: "spec",
    mediaType: "text/markdown",
    contentHash: "0".repeat(64),
    size: 1,
    version: 1,
    producedBy: { runId: "run-src", stepRunId: "s_src" },
    parents: [],
    data: { note: "private-token-value" },
    createdAt: "2026-11-22T00:00:00.000Z",
  };
  const created: OrcaEventInput = {
    type: "run.created",
    runId,
    payload: {
      workflowId: "wf",
      workflowVersion: "1",
      workspace: { hostId: "h", cwd: "/w" },
      vars: { token: "private-token-value" },
      executionInputsStored: true,
      checkpoint: {
        runId: "run-src",
        stepRunId: "s_src",
        steps: [
          {
            stepRunId: "s_new",
            from: { runId: "run-src", stepRunId: "s_src" },
            nodeId: "build",
            nodeType: "gate",
            attempt: 1,
            result: { choice: "approve", artifactIds: ["art_1"], data: { said: "private-token-value" } },
            children: [],
            completedAt: "2026-11-22T00:00:00.000Z",
          },
        ],
        artifacts: [artifact],
        vars: { token: "private-token-value", buildAttempt: 1 },
      },
    },
  };
  await events.append(created);

  const restarted = new ProtectedEventStore(new JsonlEventStore(dir), new FileExecutionStore(dir));
  const stored = await restarted.read(runId);
  const publicState = reduceRun(stored);
  expect(publicState.run.checkpoint).toEqual({ runId: "run-src", stepRunId: "s_src" });
  expect(publicState.steps.s_new).toMatchObject({
    nodeId: "build",
    attempt: 1,
    status: "completed",
    reusedFrom: { runId: "run-src", stepRunId: "s_src" },
    result: { choice: "approve", artifactIds: ["art_1"] },
  });
  expect(publicState.artifacts.art_1).toMatchObject({ id: "art_1", producedBy: { stepRunId: "s_src" } });
  expect(JSON.stringify(stored)).not.toContain("private-token-value");
  const restored = reduceRun(await executionEvents(stored, new FileExecutionStore(dir)));
  expect(restored.steps.s_new!.result?.data).toEqual({ said: "private-token-value" });
  expect(restored.run.vars).toMatchObject({ token: "private-token-value", buildAttempt: 1 });
});
