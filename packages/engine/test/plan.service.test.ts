/** PlanService without agents: registration across requests, dependency resolution, risks, decisions, artifact intake, scheduling. */
import { describe, expect, it } from "vitest";
import { FakeClock, silentLogger, type Artifact, type OrcaEventInput } from "@orca/core";
import { PlanService, planAwaitExecutor, type PlanAwaitNode, type StepContext } from "@orca/engine";
import { memoryStores } from "@orca/store";

const human = { kind: "human" as const, actor: "test" };

function make() {
  const clock = new FakeClock();
  const stores = memoryStores(clock);
  const plan = new PlanService({ stores, clock, defaults: { planKey: "roadmap", planName: "Roadmap" } });
  return { clock, stores, plan };
}

const art = (id: string, kind: string, data: Record<string, unknown>, runId = "run_x"): Artifact => ({ id, kind, name: kind, mediaType: "text/markdown", contentHash: id, size: 1, version: 1, producedBy: { runId }, parents: [], data, createdAt: "t" });

describe("PlanService", () => {
  it("registers work items with dependencies, risks and decisions, resolving refs batch-first", async () => {
    const { plan } = make();
    const p = await plan.ensurePlan({ requestId: "req_1" }, human);
    const reg = await plan.registerWorkItems(
      p.id,
      {
        requestId: "req_1",
        items: [
          { slug: "schema", title: "Schema", risks: ["migration"] },
          { slug: "api", title: "API", dependsOn: ["schema@spec", "decision:store", "soft:docs"], priority: "high" },
          { slug: "docs", title: "Docs", dependsOn: [{ on: "api", type: "informs", stage: "spec" }, "external:legal-review"] },
          { slug: "later", title: "Later", dependsOn: ["billing"] }, // billing is not registered yet
        ],
        risks: [{ key: "migration", title: "Migration locks table", likelihood: 2, impact: 4, mitigatedBy: ["api"] }],
        decisions: [{ key: "store", title: "Session store", options: [{ key: "cookie", name: "Cookie" }, { key: "redis", name: "Redis" }], blocks: ["api"] }],
      },
      { kind: "decomposition" },
    );
    expect(reg.items.map((i) => i.slug)).toEqual(["schema", "api", "docs", "later"]);
    expect(reg.warnings).toEqual([expect.stringMatching(/'later' depends on 'billing'.*external dependency/)]);
    const snap = await plan.snapshot(p.id);
    const bySlug = Object.fromEntries(snap.items.map((i) => [i.slug, i]));
    const targets = snap.dependencies.map((d) => `${bySlug[snap.items.find((i) => i.id === d.from)!.slug]!.slug}:${d.type}:${d.requiredBy}:${JSON.stringify(d.target)}`).sort();
    expect(targets).toEqual(
      [
        `api:blocks:start:{"kind":"decision","decisionId":"${snap.decisions[0]!.id}"}`,
        `api:blocks:start:{"kind":"work-item","workItemId":"${bySlug.schema!.id}","stage":"spec"}`,
        `api:soft:start:{"kind":"work-item","workItemId":"${bySlug.docs!.id}"}`,
        `docs:blocks:start:{"kind":"external","key":"legal-review"}`,
        `docs:informs:start:{"kind":"work-item","workItemId":"${bySlug.api!.id}","stage":"spec"}`,
        `later:blocks:start:{"kind":"external","key":"billing"}`,
      ].sort(),
    );
    expect(snap.risks[0]).toMatchObject({ key: "migration", affects: [bySlug.schema!.id], mitigatedBy: [bySlug.api!.id] });
    expect(snap.decisions[0]).toMatchObject({ key: "store", status: "open", blocks: [bySlug.api!.id] });
    expect(p.requestIds).toEqual(["req_1"]);

    // Schedule: only schema is ready; api waits on spec + decision; docs on the external; later on billing.
    const s = await plan.compactSchedule(p.id);
    expect(s).toMatchObject({ ready: [{ slug: "schema" }], waiting: [{ slug: "api" }, { slug: "docs" }, { slug: "later" }] });

    // A stage-level dependency clears as soon as the artifact exists, before the item is done.
    await plan.recordProduced(bySlug.schema!.id, art("art_spec", "spec", { status: "ready" }), { kind: "system" });
    let evals = await plan.evaluateDependenciesOf(bySlug.api!.id);
    expect(evals.map((e) => [e.dependency.type, e.state])).toEqual(expect.arrayContaining([["blocks", "satisfied"], ["soft", "waiting"], ["blocks", "waiting"]])); // spec ok; soft:docs and the decision still open

    // Deciding through the matrix unblocks api.
    await plan.upsertDecision(p.id, { key: "store", title: "Session store", criteria: [{ key: "simple", name: "Simple", weight: 1 }], options: [{ key: "cookie", name: "Cookie", scores: { simple: 9 } }, { key: "redis", name: "Redis", scores: { simple: 4 } }] }, { kind: "agent" });
    const decided = await plan.evaluateDecision(p.id, "store", {}, { kind: "agent" });
    expect(decided).toMatchObject({ choice: "cookie", decision: { status: "decided", decidedBy: "matrix" } });
    evals = await plan.evaluateDependenciesOf(bySlug.api!.id);
    expect(evals.find((e) => e.dependency.target.kind === "decision")).toMatchObject({ state: "satisfied", detail: "decision store = cookie" });
    expect((await plan.compactSchedule(p.id)).ready.map((r) => r.slug)).toEqual(["schema", "api"]); // schema was never dispatched here; api no longer waits
    const journal = await plan.journalOf(p.id);
    expect(journal.map((e) => e.type)).toEqual(expect.arrayContaining(["plan.created", "request.linked", "work-item.added", "dependency.added", "risk.raised", "decision.opened", "work-item.updated", "dependency.resolved", "decision.resolved"]));

    // A later request registers `billing`: the placeholder binds to it.
    const reg2 = await plan.registerWorkItems(p.id, { requestId: "req_2", items: [{ slug: "billing", title: "Billing" }, { slug: "api", title: "Another API" }] }, { kind: "decomposition" });
    expect(reg2.warnings).toEqual([expect.stringMatching(/slug 'api' already exists.*registered as 'api-2'/)]);
    const snap2 = await plan.snapshot(p.id);
    const laterDep = snap2.dependencies.find((d) => d.from === bySlug.later!.id)!;
    expect(laterDep.target).toEqual({ kind: "work-item", workItemId: reg2.items[0]!.id });
    expect((await plan.journalOf(p.id)).some((e) => e.type === "dependency.bound")).toBe(true);
    expect((await plan.getPlan("roadmap"))!.requestIds).toEqual(["req_1", "req_2"]);
    expect(await plan.planForRun({ requestId: "req_2" })).toMatchObject({ id: p.id });

    // Human overrides: waive the external, accept a risk, explain.
    const ext = snap2.dependencies.find((d) => d.target.kind === "external" && d.target.key === "legal-review")!;
    await plan.resolveDependency(ext.id, "waived", "legal signed off by email", human);
    expect((await plan.compactSchedule(p.id)).ready.map((r) => r.slug)).toEqual(expect.arrayContaining(["docs"]));
    const lines = await plan.explain(p.id, "docs");
    expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(/^docs: pending/), expect.stringMatching(/^ready - position/), expect.stringMatching(/dependency \(blocks\): waived: legal signed off/)]));
  });

  it("ingests artifact signals: risks attach to the producing item, dependencies are discovered, decisions decided", async () => {
    const { plan, stores } = make();
    const p = await plan.ensurePlan({ key: "k", requestId: "req_1" });
    const reg = await plan.registerWorkItems(p.id, { requestId: "req_1", items: [{ slug: "a", title: "A" }, { slug: "b", title: "B" }] }, { kind: "decomposition" });
    const [a, b] = reg.items;
    const spec = art("art_1", "spec", { status: "ready", risk: "medium", risks: ["Third-party rate limits", { key: "pii", title: "PII in logs", likelihood: 3, impact: 5, affects: ["b"] }], dependencies: ["b#build"], decisions: [{ key: "queue", title: "Queue tech", options: [{ key: "sqs", name: "SQS" }], chosen: "sqs", rationale: "already in use" }] }, "run_a");
    await plan.onArtifactRecorded({ id: "run_a", workItemId: a!.id, requestId: "req_1" }, spec);
    const snap = await plan.snapshot(p.id);
    expect(snap.items.find((i) => i.id === a!.id)!.produced).toEqual({ spec: "art_1" });
    expect(snap.risks.map((r) => [r.key, r.affects])).toEqual([
      ["third-party-rate-limits", [a!.id]],
      ["pii", [b!.id]],
    ]);
    expect(snap.dependencies).toEqual([expect.objectContaining({ from: a!.id, target: { kind: "work-item", workItemId: b!.id }, requiredBy: "build", origin: { kind: "artifact", artifactId: "art_1", runId: "run_a" } })]);
    expect(snap.decisions[0]).toMatchObject({ key: "queue", status: "decided", chosen: "sqs", decidedBy: "agent", rationale: "already in use" });
    // The same artifact again is idempotent.
    await plan.onArtifactRecorded({ id: "run_a", workItemId: a!.id, requestId: "req_1" }, spec);
    expect((await plan.snapshot(p.id)).dependencies).toHaveLength(1);
    // Upstream context for a: b's artifacts once b produces something.
    const impl = art("art_2", "implementation", { status: "done" }, "run_b");
    await stores.artifacts.put(impl, "# done");
    await plan.recordProduced(b!.id, impl);
    const up = await plan.upstreamContext(a!.id);
    expect(up).toEqual([expect.objectContaining({ slug: "b", requiredBy: "build", artifacts: { implementation: { id: "art_2", data: { status: "done" } } } })]);
    // Run completion marks the item and reconciles.
    await plan.onRunFinished({ id: "run_b", workItemId: b!.id, requestId: "req_1", status: "completed", outcome: "success" });
    expect((await plan.evaluateDependenciesOf(a!.id, "build"))[0]).toMatchObject({ state: "satisfied", detail: "b is done" });
  });

  it("holds items above the risk appetite until the risk is accepted, honouring plan policy", async () => {
    const { plan } = make();
    const p = await plan.ensurePlan({ key: "strict", policy: { riskAppetite: "low", strategy: "risk-first" } });
    const reg = await plan.registerWorkItems(p.id, { requestId: "req_1", items: [{ slug: "x", title: "X", risks: ["big"] }, { slug: "y", title: "Y" }], risks: [{ key: "big", title: "Big", likelihood: 3, impact: 3 }] }, { kind: "decomposition" });
    let s = await plan.schedule(p.id);
    expect(s.held.map((h) => h.slug)).toEqual(["x"]);
    expect(s.ready.map((r) => r.slug)).toEqual(["y"]);
    await plan.updateRisk(p.id, "big", { status: "accepted" }, human);
    s = await plan.schedule(p.id);
    expect(s.ready.map((r) => r.slug)).toEqual(["x", "y"]);
    expect(reg.items[0]!.priority).toBe("normal");
    expect((await plan.journalOf(p.id)).filter((e) => e.type === "risk.updated")).toHaveLength(1);
  });

  it("custom:plan-await waits for build-phase dependencies and wakes when the plan changes", async () => {
    const { plan, stores, clock } = make();
    const p = await plan.ensurePlan({ key: "k" });
    const reg = await plan.registerWorkItems(p.id, { requestId: "req_1", items: [{ slug: "up", title: "Up" }, { slug: "down", title: "Down", dependsOn: ["up#build"] }] }, { kind: "decomposition" });
    const [up, down] = reg.items;
    const emitted: OrcaEventInput["type"][] = [];
    const vars: Record<string, unknown> = {};
    const node: PlanAwaitNode = { type: "custom:plan-await", phase: "build", pollMs: 10_000 };
    const ctx = {
      run: { id: "run_down", state: { run: { id: "run_down", workItemId: down!.id, requestId: "req_1", vars } } },
      step: { id: "step_1" },
      node,
      nodeId: "await-deps",
      stores,
      plan,
      clock,
      logger: silentLogger,
      signal: new AbortController().signal,
      emit: async (e: { type: OrcaEventInput["type"]; payload: { vars?: Record<string, unknown> } }) => {
        emitted.push(e.type);
        if (e.type === "vars.set") Object.assign(vars, e.payload.vars);
      },
    } as unknown as StepContext & { node: PlanAwaitNode };

    // Nothing to wait for when the run has no work item.
    const noop = await planAwaitExecutor.execute({ ...ctx, run: { ...ctx.run, state: { run: { id: "r", vars: {} } } } } as never);
    expect(noop).toMatchObject({ kind: "completed", result: { data: { skipped: "no work item" } } });

    // Waits (poll interval is long) until `up` finishes, then exposes upstream context.
    const started = Date.now();
    const pending = planAwaitExecutor.execute(ctx);
    setTimeout(() => void plan.onRunFinished({ id: "run_up", workItemId: up!.id, requestId: "req_1", status: "completed", outcome: "success" }), 50);
    const outcome = await pending;
    expect(Date.now() - started).toBeLessThan(5_000); // woke on the journal event, not the poll
    expect(outcome).toMatchObject({ kind: "completed", result: { data: { phase: "build", satisfied: ["up is done"] } } });
    expect(emitted).toEqual(["step.waiting", "vars.set"]);
    expect(vars.upstream).toEqual([expect.objectContaining({ slug: "up", status: "done", requiredBy: "build" })]);

    // Fails fast when the upstream item failed.
    const reg2 = await plan.registerWorkItems(p.id, { requestId: "req_2", items: [{ slug: "bad", title: "Bad" }, { slug: "needs-bad", title: "Needs bad", dependsOn: ["bad#build"] }] }, { kind: "decomposition" });
    await plan.updateWorkItem(reg2.items[0]!.id, { status: "failed" });
    const failed = await planAwaitExecutor.execute({ ...ctx, run: { ...ctx.run, state: { run: { id: "run_nb", workItemId: reg2.items[1]!.id, vars: {} } } } } as never);
    expect(failed).toMatchObject({ kind: "failed", error: { code: "RUN_STATE", message: expect.stringMatching(/bad is failed/) } });
  });
});
