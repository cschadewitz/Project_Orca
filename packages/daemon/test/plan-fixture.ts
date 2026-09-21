/**
 * A plan the plan methods can be tested against, built the way a real one is: through
 * `PlanService.registerWorkItems` from a decomposition, then moved along with the same calls
 * the engine and the CLI make. Nothing is written into the stores by hand, so what the read
 * methods project is exactly what a store would hold.
 *
 * It is deliberately a plan with something in every bucket: an item that may run now, one
 * waiting on another item, one waiting on a stage, one waiting on a decision, one waiting on
 * something outside ORCA, one held above the risk appetite, one done, one failed, and one
 * running under a claim held by a run that finished.
 *
 * Everything is on a `FakeClock`, so `asOf` and every `createdAt` are exact values in the
 * assertions rather than ranges. The stores are in memory for the same reason the run fixture
 * uses them: `PlanService` is the code under test here, and `JsonFileDocumentStore`'s locking
 * is #196's own test.
 */
import { AgentRegistry } from "@orca/agents";
import { FakeClock, TemplateRegistry, WorkflowRegistry, silentLogger, type PlanOrigin } from "@orca/core";
import { Orchestrator, PlanService } from "@orca/engine";
import { memoryStores, type Stores } from "@orca/store";
import { PlanControlModel, PlanModel, ReadModel } from "../src/index.js";

export const PLAN_START = Date.UTC(2026, 2, 1, 9, 0, 0);

/**
 * Every write the fixture itself makes is the planner's, so that the `human` entries in the
 * journal after a test's own write are unambiguously the daemon's.
 */
const DECOMPOSITION: PlanOrigin = { kind: "decomposition", actor: "planner" };

export interface PlanFixture {
  clock: FakeClock;
  stores: Stores;
  orchestrator: Orchestrator;
  plan: PlanService;
  reads: ReadModel;
  plans: PlanModel;
  control: PlanControlModel;
  /** The plan every method in the tests is called with. */
  planId: string;
  /** `slug -> workItemId`, so an assertion can name an item the way a person does. */
  ids: Record<string, string>;
  /** The decision's id and the risk's id, for the same reason. */
  decisionId: string;
  riskId: string;
}

export async function planFixture(): Promise<PlanFixture> {
  const clock = new FakeClock(PLAN_START);
  const stores = memoryStores(clock);
  const orchestrator = new Orchestrator({
    stores,
    clock,
    agents: new AgentRegistry(),
    workflows: new WorkflowRegistry(),
    templates: new TemplateRegistry(),
    logger: silentLogger,
  });
  const plan = new PlanService({
    stores,
    clock,
    logger: silentLogger,
    defaults: { planKey: "sso", planName: "SSO rollout" },
  });

  const p = await plan.ensurePlan({ key: "sso", requestId: "req-1" }, DECOMPOSITION);
  const registered = await plan.registerWorkItems(
    p.id,
    {
      requestId: "req-1",
      items: [
        // Nothing blocks it: the root of the graph and the head of the critical path.
        { slug: "auth-api", title: "Add the SSO callback", estimate: "L", priority: "high" },
        // A plain `blocks` edge: waits for auth-api to be *done*.
        { slug: "auth-ui", title: "Wire the login button", dependsOn: ["auth-api"], estimate: "M" },
        // A stage-level edge: satisfied as soon as auth-api has produced a `spec`.
        { slug: "auth-docs", title: "Document the rollout", dependsOn: ["auth-api@spec"] },
        // Waits for a decision nobody has made.
        { slug: "auth-store", title: "Choose and wire the session store", dependsOn: ["decision:datastore"] },
        // Waits for something outside ORCA.
        { slug: "auth-legal", title: "Legal sign-off", dependsOn: ["external:legal-review"] },
        // Carries a critical risk, which is above the plan's appetite: held.
        { slug: "auth-crypto", title: "Rotate the signing keys", risks: ["key-leak"] },
        // Already settled, two ways.
        { slug: "auth-spike", title: "Spike the provider SDK", kind: "spike" },
        { slug: "auth-legacy", title: "Retire the legacy login" },
        // In progress, and claimed by a run.
        { slug: "auth-metrics", title: "Instrument the login funnel" },
      ],
      risks: [
        {
          key: "key-leak",
          title: "Signing key could leak during rotation",
          category: "security",
          likelihood: 4,
          impact: 5,
          affects: ["auth-crypto"],
          mitigatedBy: ["auth-crypto"],
          mitigation: "Rotate through the HSM and never write a key to disk.",
        },
        {
          key: "vendor-slip",
          title: "The provider's migration window may move",
          category: "schedule",
          likelihood: 2,
          impact: 3,
          affects: ["auth-api"],
        },
      ],
      decisions: [
        {
          key: "datastore",
          title: "Where sessions live",
          question: "Cookie, Redis or the database?",
          criteria: [
            { key: "latency", name: "Latency", weight: 2 },
            { key: "ops", name: "Operational cost", weight: 1, direction: "minimize" },
          ],
          options: [
            { key: "cookie", name: "Signed cookie", scores: { latency: 9, ops: 2 }, pros: ["No new service"] },
            { key: "redis", name: "Redis", scores: { latency: 8, ops: 6 }, cons: ["Another thing to run"] },
          ],
          blocks: ["auth-store"],
        },
      ],
    },
    DECOMPOSITION,
  );

  const ids = Object.fromEntries(registered.items.map((i) => [i.slug, i.id]));

  // Settle three items the way the engine does, through the service rather than the store.
  await plan.updateWorkItem(ids["auth-spike"]!, { status: "done" }, DECOMPOSITION);
  await plan.updateWorkItem(ids["auth-legacy"]!, { status: "failed" }, DECOMPOSITION);
  await plan.updateWorkItem(ids["auth-metrics"]!, { status: "in-progress", runId: "run-metrics" }, DECOMPOSITION);

  // A claim held by a run that no longer exists: releasing it is `claims.release`'s reason to
  // be (#88), and the owner being gone is what makes it releasable without `--force`.
  await stores.claims.claim({
    workItemId: ids["auth-metrics"]!,
    runId: "run-metrics",
    branch: "auth-metrics",
    stepRunId: "s-fan",
    at: clock.isoNow(),
  });

  const reads = new ReadModel({ orchestrator, plan, clock });
  const plans = reads.plans!;
  const control = new PlanControlModel({ plan, orchestrator, plans, reads, clock });

  return {
    clock,
    stores,
    orchestrator,
    plan,
    reads,
    plans,
    control,
    planId: p.id,
    ids,
    decisionId: registered.decisions[0]!.id,
    riskId: registered.risks.find((r) => r.key === "key-leak")!.id,
  };
}

/** The same plan, plus a live run holding a claim - the case `claims.release` must refuse. */
export async function planFixtureWithLiveClaim(): Promise<PlanFixture> {
  const f = await planFixture();
  await f.stores.events.append({
    type: "run.created",
    runId: "run-live",
    payload: {
      workflowId: "sdlc-item",
      workflowVersion: "1",
      workItemId: f.ids["auth-api"]!,
      workspace: { hostId: "local", cwd: "/work/orca", repo: "orca", branch: "main" },
      vars: {},
    },
  });
  await f.stores.events.append({ type: "run.started", runId: "run-live", payload: {} });
  await f.stores.claims.claim({
    workItemId: f.ids["auth-api"]!,
    runId: "run-live",
    branch: "auth-api",
    at: f.clock.isoNow(),
  });
  return f;
}
