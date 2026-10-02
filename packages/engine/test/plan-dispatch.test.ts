/**
 * The `custom:plan-dispatch` loop, on the fan-out `parallel` uses (issue #96):
 * `failFast` cancels the items still running rather than letting them run to completion,
 * and `onWaiting: wait` announces each distinct reason once, wakes on a plan change
 * without waiting for the poll, and gives up at `waitTimeoutMs`.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { AgentRegistry, LocalHost } from "@orca/agents";
import {
  FakeClock,
  parseWorkflow,
  RequestSchema,
  silentLogger,
  TemplateRegistry,
  WorkflowRegistry,
  type Logger,
} from "@orca/core";
import {
  LocalWorkspaceProvider,
  Orchestrator,
  PlanService,
  builtinExecutors,
  completed,
  definePlugin,
  failed,
  type StepContext,
  type StepOutcome,
} from "@orca/engine";
import { memoryStores } from "@orca/store";

const itemWorkflow = `
id: item
name: item
start: b
nodes:
  b: { type: start }
  work: { type: "custom:work" }
  e: { type: end, outcome: success }
edges: [{ from: b, to: work }, { from: work, to: e }]
`;

const dispatcher = (options: string) => `
id: plan-dispatch-test
name: plan-dispatch-test
vars:
  itemWorkflow: item
start: s
nodes:
  s: { type: start }
  dispatch: { type: "custom:plan-dispatch", scope: plan, ${options} }
  e: { type: end, outcome: success }
edges: [{ from: s, to: dispatch }, { from: dispatch, to: e }]
`;

type ItemInput = { slug: string; title: string; dependsOn?: string[] };

/** The slug of the work item whose run this step belongs to. */
const slugOf = (ctx: StepContext) => (ctx.run.state.run.vars.workItem as { slug: string }).slug;

/** Resolve when this run is cancelled - or after `ms`, so a broken signal fails the test instead of hanging it. */
const untilCancelled = (ctx: StepContext, ms = 5_000) =>
  new Promise<"cancelled" | "timeout">((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    ctx.signal.addEventListener("abort", () => (clearTimeout(timer), resolve("cancelled")), { once: true });
  });

async function setup(
  options: string,
  items: ItemInput[],
  work: (ctx: StepContext) => Promise<StepOutcome>,
  logger: Logger = silentLogger,
) {
  const stores = memoryStores();
  for (const id of ["req_1", "req_not_registered"])
    await stores.requests.put(
      RequestSchema.parse({
        id,
        title: id,
        body: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  const plan = new PlanService({ stores, defaults: { planKey: "roadmap", planName: "Roadmap" } });
  const p = await plan.ensurePlan({ requestId: "req_1" }, { kind: "human", actor: "test" });
  await plan.registerWorkItems(p.id, { requestId: "req_1", items }, { kind: "decomposition" });
  const workflows = new WorkflowRegistry()
    .register(parseWorkflow(dispatcher(options)))
    .register(parseWorkflow(itemWorkflow));
  const executors = builtinExecutors();
  void definePlugin({
    name: "test",
    register: (api) => {
      api.executors.register({ type: "custom:work", execute: work });
    },
  }).register({
    executors,
    templates: new TemplateRegistry(),
    workflows,
    agents: new AgentRegistry(),
    plan,
    setHumanInput() {},
    setWorkspaceProvider() {},
  });
  const orchestrator = new Orchestrator({
    stores,
    agents: new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })),
    workflows,
    templates: new TemplateRegistry(),
    executors,
    plan,
    workspaceProvider: new LocalWorkspaceProvider("/tmp"),
    clock: new FakeClock(),
    logger,
  });
  const run = () => orchestrator.startAndRun({ workflowId: "plan-dispatch-test", requestId: "req_1" });
  return { stores, plan, planId: p.id, orchestrator, run };
}

const dispatched = (state: { run: { vars: Record<string, unknown> } }) =>
  ((state.run.vars.dispatched as { slug: string; status: string }[]) ?? []).map((d) => `${d.slug}:${d.status}`).sort();

const statuses = async (stores: ReturnType<typeof memoryStores>) =>
  Object.fromEntries((await stores.workItems.list()).map((w) => [w.slug, w.status]));

describe("plan dispatch configuration and recovery", () => {
  it("recovers a released missing child and dispatches it from a fresh run", async () => {
    const fixture = await setup("", [{ slug: "api", title: "API" }], async () => completed());
    const wi = (await fixture.stores.workItems.list())[0]!;
    await fixture.stores.workItems.put({ ...wi, status: "in-progress", runId: "run_missing_child" });
    await fixture.stores.claims.claim({
      workItemId: wi.id,
      runId: "run_missing_parent",
      branch: wi.slug,
      at: wi.createdAt,
    });
    await fixture.orchestrator.releaseClaim(wi.id);
    expect(await fixture.stores.workItems.get(wi.id)).toMatchObject({ status: "pending" });
    expect((await fixture.stores.workItems.get(wi.id))?.runId).toBeUndefined();
    expect(dispatched(await fixture.run())).toEqual(["api:done"]);
    expect((await fixture.plan.journalOf(fixture.planId)).filter((e) => e.type === "work-item.updated")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({ changes: { status: "pending", runId: null, from: "in-progress" } }),
        }),
      ]),
    );
  });

  it.each(["created", "running"])("cancels a stale %s child before resetting its released item", async (status) => {
    const fixture = await setup("", [{ slug: "api", title: "API" }], async () => completed());
    const wi = (await fixture.stores.workItems.list())[0]!;
    const parentId = await fixture.orchestrator.startRun({ workflowId: "item" });
    await fixture.stores.events.append({ type: "run.cancelled", runId: parentId, payload: {} });
    const childId = await fixture.orchestrator.startRun({
      workflowId: "item",
      workItemId: wi.id,
      parentRunId: parentId,
    });
    if (status === "running") await fixture.stores.events.append({ type: "run.started", runId: childId, payload: {} });
    await fixture.stores.workItems.put({ ...wi, status: "in-progress", runId: childId });
    await fixture.stores.claims.claim({
      workItemId: wi.id,
      runId: parentId,
      branch: wi.slug,
      at: wi.createdAt,
    });
    await fixture.orchestrator.releaseClaim(wi.id);
    expect((await fixture.orchestrator.getState(childId)).run.status).toBe("cancelled");
    expect((await fixture.stores.workItems.get(wi.id))?.status).toBe("pending");
    expect((await fixture.stores.workItems.get(wi.id))?.runId).toBeUndefined();
    expect(dispatched(await fixture.run())).toEqual(["api:done"]);
    expect((await fixture.orchestrator.run(childId)).run.status).toBe("cancelled");
  });

  it("preserves a terminal step outcome when claim recovery finds a missing run.completed", async () => {
    const fixture = await setup("", [{ slug: "api", title: "API" }], async () => completed());
    const wi = (await fixture.stores.workItems.list())[0]!;
    const parentId = await fixture.orchestrator.startRun({ workflowId: "item" });
    await fixture.stores.events.append({ type: "run.cancelled", runId: parentId, payload: {} });
    const childId = await fixture.orchestrator.startRun({
      workflowId: "item",
      workItemId: wi.id,
      parentRunId: parentId,
    });
    await fixture.stores.events.append({ type: "run.started", runId: childId, payload: {} });
    await fixture.stores.events.append({
      type: "step.scheduled",
      runId: childId,
      payload: { stepRunId: "terminal", nodeId: "e", nodeType: "end", attempt: 1 },
    });
    await fixture.stores.events.append({
      type: "step.completed",
      runId: childId,
      payload: { stepRunId: "terminal", result: { artifactIds: [], data: {}, outcome: "success" } },
    });
    await fixture.stores.workItems.put({ ...wi, status: "in-progress", runId: childId });
    await fixture.stores.claims.claim({
      workItemId: wi.id,
      runId: parentId,
      branch: wi.slug,
      at: wi.createdAt,
    });
    await fixture.orchestrator.releaseClaim(wi.id);
    expect((await fixture.orchestrator.getState(childId)).run).toMatchObject({
      status: "completed",
      outcome: "success",
    });
    expect((await fixture.stores.workItems.get(wi.id))?.status).toBe("done");
    expect((await fixture.stores.events.read(childId)).some((event) => event.type === "run.cancelled")).toBe(false);
  });

  it("does not cancel a child that parks while orphan recovery acquires its lease", async () => {
    const fixture = await setup("", [{ slug: "api", title: "API" }], async () => completed());
    const wi = (await fixture.stores.workItems.list())[0]!;
    const parentId = await fixture.orchestrator.startRun({ workflowId: "item" });
    await fixture.stores.events.append({ type: "run.cancelled", runId: parentId, payload: {} });
    const childId = await fixture.orchestrator.startRun({
      workflowId: "item",
      workItemId: wi.id,
      parentRunId: parentId,
    });
    await fixture.stores.events.append({ type: "run.started", runId: childId, payload: {} });
    await fixture.stores.workItems.put({ ...wi, status: "in-progress", runId: childId });
    await fixture.stores.claims.claim({
      workItemId: wi.id,
      runId: parentId,
      branch: wi.slug,
      at: wi.createdAt,
    });
    const acquire = fixture.stores.leases.acquire.bind(fixture.stores.leases);
    fixture.stores.leases.acquire = async (request) => {
      await fixture.stores.events.append({
        type: "run.paused",
        runId: childId,
        payload: { reason: "waiting for person" },
      });
      return acquire(request);
    };
    await fixture.orchestrator.releaseClaim(wi.id);
    expect((await fixture.orchestrator.getState(childId)).run.status).toBe("paused");
    expect((await fixture.stores.workItems.get(wi.id))?.status).toBe("in-progress");
  });

  it("does not cancel a newly bound child belonging to a different dispatcher", async () => {
    const fixture = await setup("", [{ slug: "api", title: "API" }], async () => completed());
    const wi = (await fixture.stores.workItems.list())[0]!;
    const parentId = await fixture.orchestrator.startRun({ workflowId: "item" });
    const childId = await fixture.orchestrator.startRun({
      workflowId: "item",
      workItemId: wi.id,
      parentRunId: parentId,
    });
    await fixture.stores.workItems.put({ ...wi, status: "in-progress", runId: childId });
    await fixture.stores.claims.claim({
      workItemId: wi.id,
      runId: "old-missing-parent",
      branch: wi.slug,
      at: wi.createdAt,
    });
    await fixture.orchestrator.releaseClaim(wi.id);
    expect((await fixture.orchestrator.getState(childId)).run.status).toBe("created");
    expect(await fixture.stores.workItems.get(wi.id)).toMatchObject({ status: "in-progress", runId: childId });
  });

  it("renders the shipped risk prompts with the current plan scale", async () => {
    const rendered: string[] = [];
    const fixture = await setup("", [{ slug: "api", title: "API" }], async (ctx) => {
      for (const partial of ["work-item-context", "upstream-context"])
        ctx.templates.registerSource(await readFile(`templates/partials/${partial}.md`, "utf8"));
      for (const file of [
        "templates/program/assess-risks.md",
        "templates/program/decompose.md",
        "templates/sdlc/design.md",
      ])
        rendered.push(
          await ctx.render(await readFile(file, "utf8"), {
            request: { title: "Test" },
            artifacts: { decomposition: { data: {} } },
          }),
        );
      return completed();
    });
    await fixture.plan.updatePlan(fixture.planId, { riskMatrix: { scale: 3 } });
    expect((await fixture.run()).run.status).toBe("completed");
    expect(rendered).toHaveLength(3);
    for (const prompt of rendered) {
      expect(prompt).toContain("likelihood: 1-3");
      expect(prompt).toContain("impact: 1-3");
      expect(prompt).not.toContain("1-5");
    }
  });

  it("uses an existing selected plan before the new request has registered", async () => {
    const scales: string[] = [];
    const fixture = await setup("", [], async (ctx) => {
      scales.push(await ctx.render("{{ riskMatrix.scale }}"));
      return completed();
    });
    await fixture.plan.updatePlan(fixture.planId, { riskMatrix: { scale: 3 } });
    await fixture.plan.ensurePlan({ key: "other", riskMatrix: { scale: 7 } });
    for (const vars of [{}, { plan: "other" }]) {
      const state = await fixture.orchestrator.startAndRun({
        workflowId: "item",
        requestId: "req_not_registered",
        vars,
      });
      expect(state.run.status).toBe("completed");
    }
    expect(scales).toEqual(["3", "7"]);
  });

  it("records a node pin as the item workflow source", async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      warn: (message) => {
        warnings.push(message);
      },
      child: () => logger,
    };
    const fixture = await setup("workflow: item", [{ slug: "api", title: "API" }], async () => completed(), logger);
    const state = await fixture.orchestrator.startAndRun({
      workflowId: "plan-dispatch-test",
      requestId: "req_1",
      vars: { itemWorkflow: "shadowed" },
    });
    expect(state.run.status).toBe("completed");
    const step = Object.values(state.steps).find((s) => s.nodeId === "dispatch");
    expect(step?.result?.data).toMatchObject({ itemWorkflowSource: "node", itemWorkflow: "item" });
    expect(warnings).toContain("plan-dispatch node workflow overrides configured itemWorkflow");
  });
});

describe("plan-dispatch: failFast", () => {
  it("cancels the items still running when one fails", async () => {
    const cancelled: string[] = [];
    const { stores, run } = await setup(
      "concurrency: 2, failFast: true",
      [
        { slug: "boom", title: "Boom" },
        { slug: "slow", title: "Slow" },
      ],
      async (ctx) => {
        if (slugOf(ctx) === "boom") {
          // Let `slow` get into its own step before failing, so it is genuinely in flight.
          await new Promise((r) => setTimeout(r, 20));
          return failed("BOOM", "boom", {}, false);
        }
        cancelled.push(await untilCancelled(ctx));
        return completed();
      },
    );
    const state = await run();

    // `slow` was asked to stop through the signal `plan-dispatch` handed it, not left to finish.
    expect(cancelled).toEqual(["cancelled"]);
    expect(state.run.status).toBe("failed");
    expect(state.run.error?.message).toContain("1 cancelled by failFast");
    expect(dispatched(state)).toEqual(["boom:failed", "slow:cancelled"]);
    expect(await statuses(stores)).toEqual({ boom: "failed", slow: "cancelled" });
  });

  it("leaves unrelated items alone without it", async () => {
    const finished: string[] = [];
    const { stores, run } = await setup(
      "concurrency: 2",
      [
        { slug: "boom", title: "Boom" },
        { slug: "slow", title: "Slow" },
      ],
      async (ctx) => {
        if (slugOf(ctx) === "boom") return failed("BOOM", "boom", {}, false);
        // Still running when `boom` fails; without failFast that decides nothing.
        expect(await untilCancelled(ctx, 40)).toBe("timeout");
        finished.push(slugOf(ctx));
        return completed();
      },
    );
    const state = await run();

    expect(finished).toEqual(["slow"]);
    expect(state.run.status).toBe("failed");
    expect(dispatched(state)).toEqual(["boom:failed", "slow:done"]);
    expect(await statuses(stores)).toEqual({ boom: "failed", slow: "done" });
  });
});

describe("plan-dispatch: onWaiting wait", () => {
  const waiting = async (stores: ReturnType<typeof memoryStores>, runId: string) =>
    (await stores.events.read(runId)).filter((e) => e.type === "step.waiting");

  it("announces each distinct reason once, however many times it polls", async () => {
    const { stores, run } = await setup(
      "onWaiting: wait, pollMs: 20, waitTimeoutMs: 150",
      [{ slug: "blocked", title: "Blocked", dependsOn: ["never"] }],
      async () => completed(),
    );
    const state = await run();

    // Roughly seven polls over the timeout, and one `step.waiting` for the one reason they all saw.
    const announced = await waiting(stores, state.run.id);
    expect(announced).toHaveLength(1);
    expect((announced[0]!.payload as { on: string; detail: string }).detail).toMatch(/blocked: .*never/);
    // The wait timed out, so what is left is deferred exactly as `onWaiting: defer` would leave it.
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(state.run.vars.dispatchOutcome).toBe("partial");
    expect(dispatched(state)).toEqual(["blocked:deferred"]);
    expect((await stores.workItems.list())[0]).toMatchObject({
      status: "pending",
      deferredReason: expect.stringMatching(/never/),
    });
  });

  it("wakes on a plan change rather than on the next poll", async () => {
    // A poll interval far longer than the test: only the journal subscription can end this wait.
    const { stores, plan, planId, run } = await setup(
      "onWaiting: wait, pollMs: 60000, waitTimeoutMs: 5000",
      [{ slug: "blocked", title: "Blocked", dependsOn: ["never"] }],
      async () => completed(),
    );
    const started = run();
    await new Promise((r) => setTimeout(r, 50));
    const external = (await plan.snapshot(planId)).dependencies[0]!;
    await plan.resolveDependency(external.id, "satisfied", "delivered out of band");
    const state = await started;

    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(state.run.vars.dispatchOutcome).toBe("complete");
    expect(dispatched(state)).toEqual(["blocked:done"]);
    expect(await statuses(stores)).toEqual({ blocked: "done" });
  }, 10_000);
});
