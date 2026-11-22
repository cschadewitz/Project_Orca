/**
 * Side-effect review (#357 phase 2): a step that may have acted and never reported an outcome is
 * never run again on its own. An operator's recorded review lets resume run it again, or ends the
 * run; duplicate, conflicting and stale reviews are refused or are no-ops, and nothing is written
 * by a refusal.
 */
import { describe, expect, it } from "vitest";
import { AgentRegistry, LocalHost } from "@orca/agents";
import { parseWorkflow, TemplateRegistry, WorkflowRegistry, type OrcaEventInput } from "@orca/core";
import {
  LocalWorkspaceProvider,
  Orchestrator,
  PausingHumanInput,
  builtinExecutors,
  completed,
  runLeaseResource,
} from "@orca/engine";
import { memoryStores, type Stores } from "@orca/store";

const WORKFLOW = `
id: deploys
name: deploys
start: s
nodes:
  s: { type: start }
  deploy: { type: "custom:deploy" }
  approve: { type: gate, question: "Ship?", options: [ship] }
  e: { type: end }
edges: [{ from: s, to: deploy }, { from: deploy, to: approve }, { from: approve, to: e }]
`;

function make(stores: Stores = memoryStores()) {
  const deploys: string[] = [];
  const executors = builtinExecutors().register({
    type: "custom:deploy",
    execute: async (ctx) => (deploys.push(ctx.step.id), completed()),
  });
  const orchestrator = new Orchestrator({
    stores,
    agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })),
    workflows: new WorkflowRegistry().register(parseWorkflow(WORKFLOW)),
    templates: new TemplateRegistry(),
    executors,
    humanInput: new PausingHumanInput(),
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
  });
  return { orchestrator, stores, deploys };
}

/** A run whose interpreter died inside `deploy`: started, never finished, lease long gone. */
async function interrupted(app: ReturnType<typeof make>): Promise<string> {
  const runId = await app.orchestrator.startRun({ workflowId: "deploys" });
  const e = (event: Omit<OrcaEventInput, "runId">) => app.stores.events.append({ ...event, runId } as OrcaEventInput);
  await e({ type: "run.started", payload: {} } as never);
  await e({
    type: "step.scheduled",
    payload: { stepRunId: "s_dep", nodeId: "deploy", nodeType: "custom:deploy", attempt: 1 },
  });
  await e({ type: "step.started", payload: { stepRunId: "s_dep", inputArtifactIds: [] } });
  return runId;
}

describe("side-effect review", () => {
  it("an interrupted step is not run again until reviewed, then resume runs it once", async () => {
    const app = make();
    const runId = await interrupted(app);
    const before = await app.orchestrator.events(runId);
    for (const drive of [() => app.orchestrator.resume(runId), () => app.orchestrator.run(runId)])
      await expect(drive()).rejects.toMatchObject({
        code: "EFFECT_REVIEW_REQUIRED",
        details: { runId, stepRunId: "s_dep", nodeId: "deploy" },
      });
    // Refused before anything was written or run, and no lease is left behind.
    expect(await app.orchestrator.events(runId)).toEqual(before);
    expect(app.deploys).toEqual([]);
    expect(await app.stores.leases.get(runLeaseResource(runId))).toBeUndefined();

    const reviewed = await app.orchestrator.reviewEffect(runId, "s_dep", "run-again", {
      actor: { principalId: "casey" },
      note: "the deploy never reached the target",
    });
    expect(reviewed.steps.s_dep!.effectReview).toMatchObject({
      decision: "run-again",
      note: "the deploy never reached the target",
      actor: { principalId: "casey" },
    });
    const state = await app.orchestrator.resume(runId);
    expect(state.run.status).toBe("paused"); // at the gate, after deploy ran again
    expect(app.deploys).toHaveLength(1);
    expect(state.steps.s_dep!.status).toBe("cancelled");
  });

  it("a repeated review is a no-op; a different decision or a stale step is refused", async () => {
    const app = make();
    const runId = await interrupted(app);
    await app.orchestrator.reviewEffect(runId, "s_dep", "run-again");
    const once = await app.orchestrator.events(runId);
    // A retried request (a reconnect that resent it) records nothing new.
    await app.orchestrator.reviewEffect(runId, "s_dep", "run-again");
    expect(await app.orchestrator.events(runId)).toEqual(once);
    await expect(app.orchestrator.reviewEffect(runId, "s_dep", "abandon")).rejects.toMatchObject({
      code: "RUN_STATE",
      details: { decision: "run-again" },
    });
    await expect(app.orchestrator.reviewEffect(runId, "s_nope", "run-again")).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    // Once resumed past it, a review of a step that settled is stale and refused.
    const state = await app.orchestrator.resume(runId);
    const next = state.stepOrder.find((id) => state.steps[id]!.nodeId === "deploy" && id !== "s_dep")!;
    await expect(app.orchestrator.reviewEffect(runId, next, "run-again")).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    expect((await app.orchestrator.events(runId)).filter((e) => e.type === "step.effect.reviewed")).toHaveLength(1);
  });

  it("a step paused on purpose needs no review: answering and resuming works as before", async () => {
    const app = make();
    const paused = await app.orchestrator.startAndRun({ workflowId: "deploys" });
    expect(paused.run.status).toBe("paused");
    const gateStep = paused.stepOrder.at(-1)!;
    expect(paused.steps[gateStep]!.parked).toBe(true);
    await expect(app.orchestrator.reviewEffect(paused.run.id, gateStep, "run-again")).rejects.toMatchObject({
      code: "RUN_STATE",
    });
    const [request] = await app.orchestrator.pendingInputs(paused.run.id);
    await app.orchestrator.answer(request!.id, "ship", paused.run.id);
    expect((await app.orchestrator.resume(paused.run.id)).run.status).toBe("completed");
  });

  it("abandon ends the run cancelled, and nothing runs the step again", async () => {
    const app = make();
    const runId = await interrupted(app);
    const state = await app.orchestrator.reviewEffect(runId, "s_dep", "abandon", { note: "rolled back by hand" });
    expect(state.run.status).toBe("cancelled");
    const events = await app.orchestrator.events(runId);
    expect(events.find((e) => e.type === "run.cancelled")?.payload).toMatchObject({
      reason: "abandoned after side-effect review",
    });
    // The same review again is safe; resuming an ended run runs nothing.
    await app.orchestrator.reviewEffect(runId, "s_dep", "abandon");
    expect(await app.orchestrator.events(runId)).toEqual(events);
    expect(app.deploys).toEqual([]);
  });

  it("a review is refused while another interpreter holds the run", async () => {
    const app = make();
    const runId = await interrupted(app);
    await app.stores.leases.acquire({ resource: runLeaseResource(runId), holder: "elsewhere", ttlMs: 60_000 });
    const before = await app.orchestrator.events(runId);
    await expect(app.orchestrator.reviewEffect(runId, "s_dep", "run-again")).rejects.toMatchObject({
      code: "RUN_LEASED",
    });
    // Driving is refused for the lease, not for the review: the step is that interpreter's.
    await expect(app.orchestrator.resume(runId)).rejects.toMatchObject({ code: "RUN_LEASED" });
    expect(await app.orchestrator.events(runId)).toEqual(before);
  });
});
