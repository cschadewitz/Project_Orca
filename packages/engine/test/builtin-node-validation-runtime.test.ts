/** Exercise parsed builtin defaults and templates through the real planning service. */
import { describe, expect, it, vi } from "vitest";
import { FakeClock, renderTemplate, silentLogger, type NodeDef } from "@orca/core";
import { memoryStores } from "@orca/store";
import { builtinExecutors, PlanService, type StepContext } from "../src/index.js";
import { PlanDispatchNodeSchema, PlanAwaitNodeSchema } from "../src/plan/nodes.js";

function fixture(node: NodeDef) {
  const clock = new FakeClock();
  const stores = memoryStores(clock);
  const plan = new PlanService({ stores, clock });
  const vars: Record<string, unknown> = { plan: "roadmap", title: "Roadmap", decision: "database" };
  const emit = vi.fn(async () => {});
  const recordArtifact = vi.fn(async () => ({ id: "artifact_schedule" }));
  const ctx = {
    node,
    nodeId: "check",
    step: { id: "step_1" },
    run: { id: "run_1", state: { run: { id: "run_1", vars } }, request: async () => undefined },
    stores,
    plan,
    clock,
    logger: silentLogger,
    signal: new AbortController().signal,
    workspace: { cwd: "/tmp", hostId: "local" },
    render: async (body: string) => renderTemplate(body, { vars }),
    emit,
    recordArtifact,
  } as unknown as StepContext;
  return { ctx, stores, plan, vars, emit, recordArtifact };
}

const execute = (ctx: StepContext) => builtinExecutors().get(ctx.node.type)!.execute(ctx);

describe("builtin parsing during execution", () => {
  it.each(["plan-register", "materialize-work-items"])(
    "uses the omitted decomposition artifact in %s",
    async (type) => {
      const { ctx, stores, plan } = fixture({
        type: `custom:${type}`,
        plan: "{{ vars.plan }}",
        planName: "{{ vars.title }}",
      });
      const resolveInputs = vi.fn(async () => [
        { id: "decomposition", data: { items: [{ slug: "api", title: "API" }] } },
      ]);
      const outcome = await execute({ ...ctx, resolveInputs } as unknown as StepContext);
      expect(outcome.kind).toBe("completed");
      expect(resolveInputs).toHaveBeenCalledWith([{ name: "decomposition", required: false }]);
      expect(await stores.workItems.list()).toEqual([expect.objectContaining({ slug: "api", title: "API" })]);
      if (type === "plan-register") expect(await plan.requirePlan("roadmap")).toMatchObject({ name: "Roadmap" });
    },
  );

  it("uses the omitted decisionMatrix name and decision-matrix kind, rendering the decision key", async () => {
    const { ctx } = fixture({ type: "custom:decision-matrix", decision: "{{ vars.decision }}" });
    const resolveInputs = vi
      .fn()
      .mockResolvedValueOnce([undefined])
      .mockResolvedValueOnce([{ id: "matrix", name: "decisionMatrix", data: { title: "Database", chosen: "sqlite" } }]);
    expect(await execute({ ...ctx, resolveInputs })).toMatchObject({
      kind: "completed",
      result: { choice: "sqlite", data: { decision: "database" } },
    });
    expect(resolveInputs.mock.calls).toEqual([
      [[{ name: "decisionMatrix", required: false }]],
      [[{ kind: "decision-matrix", required: true }]],
    ]);
  });

  it.each([{}, { weights: { age: 0 } }, { strategy: undefined }])(
    "preserves plan policy through sparse overrides %j",
    async (policy) => {
      const { ctx, plan, recordArtifact } = fixture({ type: "custom:plan-schedule", plan: "{{ vars.plan }}", policy });
      await plan.ensurePlan({
        key: "roadmap",
        policy: { strategy: "fifo", concurrency: 7, holdAboveAppetite: false, riskAppetite: "critical" },
      });
      const schedule = vi.spyOn(plan, "schedule");
      expect((await execute(ctx)).kind).toBe("completed");
      const result: Awaited<ReturnType<PlanService["schedule"]>> = await schedule.mock.results[0]!.value;
      expect(result.policy).toMatchObject({
        strategy: "fifo",
        concurrency: 7,
        holdAboveAppetite: false,
        riskAppetite: "critical",
      });
      expect(schedule.mock.calls[0]![1]?.policy).toEqual("strategy" in policy ? {} : policy);
      expect(recordArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ path: ".orca/plans/roadmap/schedule.md" }),
        expect.any(String),
        { path: "/tmp/.orca/plans/roadmap/schedule.md" },
      );
    },
  );

  it("preserves an empty schedule artifact path and record: false", async () => {
    const { ctx, plan, recordArtifact } = fixture({ type: "custom:plan-schedule", artifactPath: "", record: false });
    const p = await plan.ensurePlan({ key: "roadmap" });
    expect((await execute(ctx)).kind).toBe("completed");
    expect(recordArtifact).not.toHaveBeenCalled();
    expect((await plan.journalOf(p.id)).some((event) => event.type === "schedule.computed")).toBe(false);
  });

  it("awaits build by default and exposes the upstream context", async () => {
    const { ctx, plan, emit } = fixture({ type: "custom:plan-await" });
    const p = await plan.ensurePlan({ key: "roadmap" });
    const registered = await plan.registerWorkItems(
      p.id,
      { requestId: "req_1", items: [{ slug: "api", title: "API" }] },
      { kind: "decomposition" },
    );
    const evaluate = vi.spyOn(plan, "evaluateDependenciesOf");
    const workItemId = registered.items[0]!.id;
    ctx.run.state.run.workItemId = workItemId;
    expect(await execute(ctx)).toMatchObject({ kind: "completed", result: { data: { phase: "build" } } });
    expect(evaluate).toHaveBeenCalledWith(workItemId, "build");
    expect(emit).toHaveBeenCalledWith({ type: "vars.set", payload: { vars: { upstream: expect.anything() } } });
  });

  it("keeps dispatch selection and concurrency inherited until runtime", async () => {
    const { ctx, plan, vars } = fixture({ type: "custom:plan-dispatch", policy: {} });
    await plan.ensurePlan({ key: "roadmap", policy: { concurrency: 5 } });
    vars.itemWorkflow = "chosen-workflow";
    ctx.run.state.stepOrder = [];
    const schedule = vi.spyOn(plan, "schedule");
    expect(await execute(ctx)).toMatchObject({
      kind: "completed",
      result: { data: { itemWorkflow: "chosen-workflow", itemWorkflowSource: "var" } },
    });
    expect(schedule.mock.calls[0]![1]?.policy).toEqual({});
    expect(PlanDispatchNodeSchema.parse(ctx.node)).toMatchObject({
      scope: "request",
      leavesOnly: true,
      failFast: false,
      onWaiting: "defer",
      pollMs: 5_000,
      waitTimeoutMs: 1_800_000,
    });
    expect(PlanDispatchNodeSchema.parse(ctx.node)).not.toHaveProperty("concurrency");
    expect(PlanDispatchNodeSchema.parse(ctx.node)).not.toHaveProperty("workflow");
    expect(PlanAwaitNodeSchema.parse({ type: "custom:plan-await" })).toMatchObject({
      pollMs: 2_000,
      timeoutMs: 1_800_000,
    });
  });
});
