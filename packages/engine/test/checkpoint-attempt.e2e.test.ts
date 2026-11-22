/**
 * #357 phase 2: a checkpoint attempt of a failed run, driven through the shipped ai-sdlc
 * workflow and the scripted ACP agent. It reuses the steps up to the checkpoint (no prompt
 * is sent for them again), routes on from it, and leaves the source run untouched.
 */
import { rm } from "node:fs/promises";
import { afterAll, expect, it } from "vitest";
import { checkpointAttempts } from "@orca/engine";
import { harness } from "./helpers.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const workItem = {
  id: "wi_1",
  requestId: "req_1",
  slug: "auth-api",
  title: "Auth API",
  description: "Add login endpoint",
  kind: "task",
  acceptanceCriteria: ["POST /login returns a token"],
  dependsOn: [],
  status: "pending",
  createdAt: "t",
  updatedAt: "t",
};

async function failedBuild() {
  const h = await harness({
    kinds: {
      spec: [
        {
          data: { status: "ready", risk: "low" },
          body: "# Spec\n\nEnough words to satisfy the minimum body length requirement of the design step.",
        },
      ],
      // The first build attempt never delivers (three prompts: one plus two follow-ups); the
      // checkpoint attempt's build does.
      implementation: [{ skip: true }, { skip: true }, { skip: true }, { data: { status: "done", branch: "b" } }],
      "test-report": [{ data: { status: "done", passed: true, failures: 0 }, body: "all green" }],
      review: [{ data: { status: "done", verdict: "approve" }, body: "LGTM" }],
    },
  });
  dirs.push(h.dir);
  const state = await h.orchestrator.startAndRun({ workflowId: "ai-sdlc", vars: { workItem } });
  expect(state.run.status).toBe("failed");
  return { h, state };
}

it("refuses until the failed step is reviewed, then reuses everything up to the checkpoint", async () => {
  const { h, state: source } = await failedBuild();
  const o = h.orchestrator;
  const build = source.stepOrder.map((id) => source.steps[id]!).find((s) => s.nodeId === "build")!;
  expect(build.dispatched).toBe(true);

  // The build may have changed the workspace: no checkpoint may run it again unreviewed.
  await expect(o.startCheckpointAttempt({ runId: source.run.id })).rejects.toMatchObject({
    code: "RECOVERY_BLOCKED",
    details: { blockers: ["effect-unreviewed"] },
  });
  expect(await checkpointAttempts(o.stores, source.run.id)).toEqual([]);

  await o.reviewEffect(source.run.id, build.id, "run-again");
  const sourceLog = (await o.events(source.run.id)).length;
  const promptsBefore = (await h.prompts()).length;

  const attemptId = await o.startCheckpointAttempt({ runId: source.run.id });
  const bump = source.stepOrder.map((id) => source.steps[id]!).find((s) => s.nodeId === "bump-build")!;
  expect(await checkpointAttempts(o.stores, source.run.id)).toEqual([
    { runId: attemptId, checkpointStepRunId: bump.id },
  ]);
  // Another attempt while this one has not finished would share its workspace.
  await expect(o.startCheckpointAttempt({ runId: source.run.id })).rejects.toMatchObject({ code: "RUN_STATE" });

  const attempt = await o.run(attemptId);
  expect(attempt.run.status, JSON.stringify(attempt.run.error)).toBe("completed");
  expect(attempt.run.outcome).toBe("success");
  expect(attempt.run.checkpoint).toEqual({ runId: source.run.id, stepRunId: bump.id });
  expect(attempt.run.workspace).toEqual(source.run.workspace);

  const steps = attempt.stepOrder.map((id) => attempt.steps[id]!);
  const reused = steps.filter((s) => s.reusedFrom);
  expect(reused.map((s) => s.nodeId)).toEqual(["start", "plan", "design", "spec-gate", "await-deps", "bump-build"]);
  for (const s of reused) {
    expect(s.reusedFrom?.runId).toBe(source.run.id);
    expect(s.startedAt).toBeUndefined();
    expect(source.steps[s.reusedFrom!.stepRunId]!.nodeId).toBe(s.nodeId);
  }
  expect(steps.filter((s) => !s.reusedFrom).map((s) => s.nodeId)).toEqual([
    "build",
    "test",
    "tests-passed",
    "bump-review",
    "review",
    "review-verdict",
    "deploy",
    "delivery-status",
    "done",
  ]);
  // The vars carried on from the checkpoint, not from the launch.
  expect(attempt.run.vars).toMatchObject({ buildAttempt: 1, reviewRound: 1 });
  // The spec was reused as recorded: same artifact, no new prompt for plan or design.
  const spec = Object.values(attempt.artifacts).find((a) => a.kind === "spec")!;
  expect(spec.id).toBe(Object.values(source.artifacts).find((a) => a.kind === "spec")!.id);
  const prompts = (await h.prompts()).slice(promptsBefore);
  expect(prompts.some((p) => p.text.includes("You are the **design agent**"))).toBe(false);
  expect(prompts.filter((p) => p.text.includes("You are the **build agent**"))).toHaveLength(1);

  // The source is history: nothing was appended to it.
  expect(await o.events(source.run.id)).toHaveLength(sourceLog);
  // Once the attempt has finished, another may start.
  const second = await o.startCheckpointAttempt({ runId: source.run.id, checkpoint: "design" });
  expect((await checkpointAttempts(o.stores, source.run.id)).map((a) => a.runId)).toEqual([attemptId, second]);
  const secondState = await o.getState(second);
  expect(secondState.stepOrder.map((id) => secondState.steps[id]!.nodeId)).toEqual(["start", "plan", "design"]);
}, 60_000);

it("refuses a run that did not fail, another principal's run and an unknown checkpoint, with reasons", async () => {
  const h = await harness({
    kinds: {
      spec: [
        {
          data: { status: "ready", risk: "low" },
          body: "# Spec\n\nEnough words to satisfy the minimum body length requirement of the design step.",
        },
      ],
      implementation: [{ skip: true }, { skip: true }, { skip: true }, { data: { status: "done", branch: "b" } }],
      "test-report": [{ data: { status: "done", passed: true, failures: 0 }, body: "all green" }],
      review: [{ data: { status: "done", verdict: "approve" }, body: "LGTM" }],
    },
  });
  dirs.push(h.dir);
  const o = h.orchestrator;
  const alice = { principalId: "alice" };
  const failed = await o.startAndRun({ workflowId: "ai-sdlc", vars: { workItem }, actor: alice });
  expect(failed.run.status).toBe("failed");
  const build = failed.stepOrder.map((id) => failed.steps[id]!).find((s) => s.nodeId === "build")!;
  await o.reviewEffect(failed.run.id, build.id, "run-again");
  const completed = await o.startAndRun({ workflowId: "ai-sdlc", vars: { workItem: { ...workItem, slug: "b" } } });
  expect(completed.run.status).toBe("completed");

  await expect(o.startCheckpointAttempt({ runId: completed.run.id })).rejects.toMatchObject({
    code: "RECOVERY_BLOCKED",
    details: { blockers: expect.arrayContaining(["not-failed"]) },
  });
  await expect(o.startCheckpointAttempt({ runId: failed.run.id, actor: { principalId: "bob" } })).rejects.toMatchObject(
    { code: "RECOVERY_BLOCKED", details: { blockers: expect.arrayContaining(["cross-principal"]) } },
  );
  await expect(o.startCheckpointAttempt({ runId: failed.run.id, checkpoint: "no-such-node" })).rejects.toMatchObject({
    code: "CONFIG_INVALID",
  });
  await expect(o.startCheckpointAttempt({ runId: "run_missing" })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  expect(await checkpointAttempts(o.stores, failed.run.id)).toEqual([]);
  // Its own principal may, and the attempt records who started it.
  const attempt = await o.startCheckpointAttempt({ runId: failed.run.id, actor: alice });
  const created = (await o.events(attempt))[0]!;
  expect(created.payload).toMatchObject({ actor: alice, checkpoint: { runId: failed.run.id } });
}, 60_000);
