/** Artifact signal mutations drive reconciliation, even when the clock does not advance. */
import { describe, expect, it, vi } from "vitest";
import { FakeClock, type Artifact, type DecisionInputLike } from "@orca/core";
import { PlanService } from "@orca/engine";
import { memoryStores } from "@orca/store";

const human = { kind: "human" as const };
const artifact = (data: Record<string, unknown>, id = "art_signals"): Artifact => ({
  id,
  kind: "spec",
  name: "spec",
  mediaType: "text/markdown",
  contentHash: id,
  size: 1,
  version: 1,
  producedBy: { runId: "run_a" },
  parents: [],
  data,
  createdAt: "t",
});

async function make() {
  const clock = new FakeClock();
  const stores = memoryStores(clock);
  const service = new PlanService({ stores, clock });
  const plan = await service.ensurePlan({ requestId: "req_1" });
  const { items } = await service.registerWorkItems(
    plan.id,
    {
      requestId: "req_1",
      items: [
        { slug: "a", title: "A" },
        { slug: "b", title: "B" },
      ],
    },
    human,
  );
  const ctx = { planId: plan.id, workItemId: items[0]!.id, runId: "run_a" };
  const reconcile = vi.spyOn(service, "reconcile");
  const snapshot = vi.spyOn(service, "snapshot");
  return { clock, stores, service, plan, items, ctx, reconcile, snapshot };
}

describe("artifact intake change detection (#105)", () => {
  it.each([1, 2])("recovers request-only decision replay after %i failed reconciliation reads", async (failures) => {
    const { service, stores, ctx, reconcile, snapshot } = await make();
    const decision = await service.upsertDecision(
      ctx.planId,
      { key: "store", title: "Store", options: [{ key: "a", name: "A" }], blocks: ["a"] },
      human,
    );
    const otherPlan = await service.ensurePlan({ key: "other" });
    await service.upsertRisk(otherPlan.id, { key: "known", title: "Known" }, human);
    const matrix: Artifact = {
      ...artifact({ key: "store", title: "Store", chosen: "a" }),
      kind: "decision-matrix",
    };
    const run = { id: ctx.runId, requestId: "req_1" }; // No recordProduced recovery pass.
    for (let i = 0; i < failures; i++) {
      snapshot.mockImplementationOnce(async () => {
        expect(await stores.plan.decisions.get(decision.id)).toMatchObject({ status: "decided", chosen: "a" });
        throw new Error("transient snapshot failure");
      });
    }

    expect(await service.onArtifactRecorded(run, matrix)).toEqual([
      expect.stringMatching(/decision 'store'.*transient snapshot failure/),
    ]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(await stores.plan.dependencies.list((d) => d.planId === ctx.planId)).toEqual([
      expect.objectContaining({ status: "open" }),
    ]);

    // Pending recovery belongs to this plan, and survives another failed replay.
    await service.ingestArtifact(artifact({ risks: ["known"] }), { planId: otherPlan.id });
    expect(reconcile).toHaveBeenCalledTimes(1);
    for (let i = 1; i < failures; i++) {
      expect(await service.onArtifactRecorded(run, matrix)).toEqual([
        expect.stringMatching(/plan intake failed: transient snapshot failure/),
      ]);
    }
    expect(await service.onArtifactRecorded(run, matrix)).toEqual([]);
    expect(reconcile).toHaveBeenCalledTimes(failures + 1);
    expect(await stores.plan.dependencies.list((d) => d.planId === ctx.planId)).toEqual([
      expect.objectContaining({ status: "satisfied" }),
    ]);
    const journal = await service.journalOf(ctx.planId);
    expect(journal.filter((e) => e.type === "decision.resolved")).toHaveLength(1);
    expect(journal.filter((e) => e.type === "dependency.resolved")).toHaveLength(1);
    expect(journal.filter((e) => e.type === "signals.rejected")).toEqual([
      expect.objectContaining({
        payload: {
          artifactId: matrix.id,
          runId: run.id,
          issues: [expect.stringMatching(/decision 'store'.*transient snapshot failure/)],
        },
      }),
    ]);

    reconcile.mockClear();
    snapshot.mockClear();
    expect(await service.onArtifactRecorded(run, matrix)).toEqual([]);
    expect(reconcile).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(await service.journalOf(ctx.planId)).toEqual(journal);
  });

  it("returns known risks, open decisions and duplicate dependencies without writing or reconciling", async () => {
    const { clock, stores, service, ctx, reconcile, snapshot } = await make();
    const spec = artifact({
      risks: [{ key: "flaky-tests", title: "Flaky tests", triggers: ["CI"], mitigatedBy: ["b"] }],
      decisions: [
        {
          key: "store",
          title: "Store",
          criteria: [{ key: "cost", name: "Cost" }],
          options: [{ key: "a", name: "A", scores: { cost: 3 } }],
          consequences: ["migration"],
          blocks: ["a"],
        },
      ],
      dependencies: ["b"],
    });
    const first = await service.ingestArtifact(spec, ctx);
    const before = await service.snapshot(ctx.planId);
    const journal = await service.journalOf(ctx.planId);
    clock.advance(1_000);
    reconcile.mockClear();
    snapshot.mockClear();
    const riskPut = vi.spyOn(stores.plan.risks, "put");
    const decisionPut = vi.spyOn(stores.plan.decisions, "put");
    const dependencyPut = vi.spyOn(stores.plan.dependencies, "put");

    for (const specId of [spec.id, "art_later"]) {
      expect(await service.ingestArtifact({ ...spec, id: specId }, ctx)).toEqual({
        risks: first.risks,
        decisions: first.decisions,
        dependencies: [],
        issues: [],
      });
    }
    expect(reconcile).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled(); // No plan-wide reads hidden behind an idempotent journal.
    expect(riskPut).not.toHaveBeenCalled();
    expect(decisionPut).not.toHaveBeenCalled();
    expect(dependencyPut).not.toHaveBeenCalled();
    expect(await service.snapshot(ctx.planId)).toEqual(before);
    expect(await service.journalOf(ctx.planId)).toEqual(journal);
  });

  it("skips key-only risks and already-decided matrices without changing a human resolution", async () => {
    const { service, ctx, reconcile, snapshot } = await make();
    const risk = await service.upsertRisk(ctx.planId, { key: "flaky-tests", title: "Flaky tests" }, human);
    const decision = await service.upsertDecision(
      ctx.planId,
      {
        key: "store",
        title: "Store",
        options: [
          { key: "a", name: "A" },
          { key: "b", name: "B" },
        ],
        chosen: "b",
      },
      human,
    );
    const journal = await service.journalOf(ctx.planId);
    reconcile.mockClear();
    snapshot.mockClear();
    const result = await service.ingestArtifact(
      artifact({
        risks: ["flaky-tests"],
        decisions: [{ key: "store", title: "Store", chosen: "a", rationale: "automated preference" }],
      }),
      { planId: ctx.planId },
    );
    expect(result).toEqual({ risks: [risk], decisions: [decision], dependencies: [], issues: [] });
    expect(reconcile).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(await service.journalOf(ctx.planId)).toEqual(journal);
  });

  it("does not treat score object property order as a matrix change", async () => {
    const { service, ctx, reconcile } = await make();
    const decision = await service.upsertDecision(
      ctx.planId,
      {
        key: "store",
        title: "Store",
        options: [{ key: "a", name: "A", scores: { cost: 3, speed: 4 } }],
      },
      human,
    );
    const journal = await service.journalOf(ctx.planId);
    const out = await service.ingestArtifact(
      artifact({
        decisions: [
          {
            key: "store",
            title: "Store",
            options: [{ key: "a", name: "A", scores: { speed: 4, cost: 3 } }],
          },
        ],
      }),
      ctx,
    );
    expect(out.decisions).toEqual([decision]);
    expect(reconcile).not.toHaveBeenCalled();
    expect(await service.journalOf(ctx.planId)).toEqual(journal);
  });

  it("reconciles creations and decision resolution, then skips the same resolved matrix", async () => {
    const { service, ctx, items, reconcile } = await make();
    const initial = await service.ingestArtifact(
      artifact({
        risks: ["flaky-tests"],
        decisions: [{ key: "store", title: "Store", options: [{ key: "a", name: "A" }], blocks: ["a"] }],
      }),
      ctx,
    );
    expect(initial).toMatchObject({ risks: [{ key: "flaky-tests" }], decisions: [{ status: "open" }], issues: [] });
    expect(reconcile).toHaveBeenCalledTimes(1);
    reconcile.mockClear();
    const matrix: Artifact = { ...artifact({ key: "store", title: "Store", chosen: "a" }), kind: "decision-matrix" };
    const resolved = await service.ingestArtifact(matrix, ctx);
    expect(resolved.decisions[0]).toMatchObject({ status: "decided", chosen: "a" });
    expect(reconcile).toHaveBeenCalled();
    expect((await service.snapshot(ctx.planId)).dependencies).toEqual([
      expect.objectContaining({ from: items[0]!.id, status: "satisfied" }),
    ]);
    const journal = await service.journalOf(ctx.planId);
    expect(journal.filter((e) => e.type === "decision.resolved")).toHaveLength(1);
    expect(journal.filter((e) => e.type === "dependency.resolved")).toHaveLength(1);
    reconcile.mockClear();
    expect(await service.ingestArtifact(matrix, ctx)).toEqual(resolved);
    expect(reconcile).not.toHaveBeenCalled();
    expect(await service.journalOf(ctx.planId)).toEqual(journal);
  });

  const decisionUpdates: { label: string; changes: Partial<DecisionInputLike> }[] = [
    { label: "title", changes: { title: "New store" } },
    { label: "question", changes: { question: "Which store?" } },
    { label: "context", changes: { context: "New workload" } },
    { label: "criteria", changes: { criteria: [{ key: "cost", name: "Cost", weight: 2 }] } },
    { label: "options", changes: { options: [{ key: "a", name: "A", scores: { cost: 4 } }] } },
    { label: "scale", changes: { scale: 5 } },
    { label: "consequences", changes: { consequences: ["new migration"] } },
  ];
  it.each(decisionUpdates)(
    "reconciles a real decision $label change without relying on timestamps",
    async ({ changes }) => {
      const { service, ctx, reconcile } = await make();
      const definition: DecisionInputLike = {
        key: "store",
        title: "Store",
        criteria: [{ key: "cost", name: "Cost" }],
        options: [{ key: "a", name: "A", scores: { cost: 3 } }],
        consequences: ["migration"],
      };
      const original = await service.upsertDecision(ctx.planId, definition, human);
      const spec = artifact({ decisions: [{ ...definition, ...changes }] });
      const out = await service.ingestArtifact(spec, ctx);
      expect(out.decisions[0]).toMatchObject(changes);
      expect(out.decisions[0]!.updatedAt).toBe(original.updatedAt);
      expect(reconcile).toHaveBeenCalledTimes(1);
      const journal = await service.journalOf(ctx.planId);
      expect(journal.filter((e) => e.type === "decision.updated")).toMatchObject([
        { payload: { decisionId: original.id, changes } },
      ]);
      reconcile.mockClear();
      expect(await service.ingestArtifact(spec, ctx)).toEqual(out);
      expect(reconcile).not.toHaveBeenCalled();
      expect(await service.journalOf(ctx.planId)).toEqual(journal);
    },
  );

  it("reconciles risk fields and new affects, mitigation and trigger members", async () => {
    const { service, ctx, items, reconcile } = await make();
    const original = await service.upsertRisk(ctx.planId, { key: "flaky-tests", title: "Flaky tests" }, human);
    const spec = artifact({
      risks: [
        {
          key: "flaky-tests",
          title: "CI flakes",
          likelihood: 4,
          impact: 5,
          status: "accepted",
          mitigation: "Retry",
          contingency: "Pause",
          owner: "QA",
          description: "Unstable CI",
          affects: ["a", "b"],
          mitigatedBy: ["b"],
          triggers: ["CI"],
        },
      ],
    });
    const out = await service.ingestArtifact(spec, ctx);
    expect(out.risks[0]).toMatchObject({
      title: "CI flakes",
      likelihood: 4,
      impact: 5,
      status: "accepted",
      closedAt: original.updatedAt,
      affects: items.map((i) => i.id),
      mitigatedBy: [items[1]!.id],
      triggers: ["CI"],
      updatedAt: original.updatedAt,
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
    const journal = await service.journalOf(ctx.planId);
    expect(journal.filter((e) => e.type === "risk.updated")).toHaveLength(1);
    reconcile.mockClear();
    expect(await service.ingestArtifact(spec, ctx)).toEqual(out);
    expect(reconcile).not.toHaveBeenCalled();
    expect(await service.journalOf(ctx.planId)).toEqual(journal);
  });

  it("reconciles a new blocker on a decided decision even when its record is unchanged", async () => {
    const { service, ctx, items, reconcile } = await make();
    const decision = await service.upsertDecision(
      ctx.planId,
      {
        key: "store",
        title: "Store",
        options: [{ key: "a", name: "A" }],
        chosen: "a",
      },
      human,
    );
    reconcile.mockClear();
    const spec = artifact({ decisions: [{ key: "store", title: "Store", blocks: ["b"] }] });
    const out = await service.ingestArtifact(spec, ctx);
    expect(out).toEqual({ risks: [], decisions: [decision], dependencies: [], issues: [] });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect((await service.snapshot(ctx.planId)).dependencies).toEqual([
      expect.objectContaining({ from: items[1]!.id, status: "satisfied" }),
    ]);
    reconcile.mockClear();
    expect(await service.ingestArtifact(spec, ctx)).toEqual(out);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("reconciles a new explicit dependency but skips its duplicate", async () => {
    const { service, ctx, reconcile } = await make();
    const spec = artifact({ dependencies: ["b"] });
    expect((await service.ingestArtifact(spec, ctx)).dependencies).toHaveLength(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    reconcile.mockClear();
    expect(await service.ingestArtifact(spec, ctx)).toEqual({ risks: [], decisions: [], dependencies: [], issues: [] });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("preserves partial decision mutations and rejection reports, without reconciling an unchanged rejection", async () => {
    const { service, ctx, reconcile } = await make();
    const spec = artifact({
      decisions: [
        {
          key: "store",
          title: "Store",
          options: [{ key: "a", name: "A" }],
          chosen: "unknown",
        },
      ],
    });
    const out = await service.ingestArtifact(spec, ctx);
    expect(out).toEqual({
      risks: [],
      decisions: [],
      dependencies: [],
      issues: [expect.stringMatching(/decision 'store'.*unknown/)],
    });
    expect(reconcile).toHaveBeenCalledTimes(1); // Opening the record precedes the rejected choice.
    expect((await service.snapshot(ctx.planId)).decisions[0]).toMatchObject({ status: "open" });
    reconcile.mockClear();
    expect(await service.ingestArtifact(spec, ctx)).toEqual(out);
    expect(reconcile).not.toHaveBeenCalled();
    const journal = await service.journalOf(ctx.planId);
    expect(journal.filter((e) => e.type === "decision.opened")).toHaveLength(1);
    expect(journal.filter((e) => e.type === "decision.resolved")).toHaveLength(0);
    expect(journal.filter((e) => e.type === "signals.rejected")).toEqual([
      expect.objectContaining({ payload: { artifactId: spec.id, runId: ctx.runId, issues: out.issues } }),
      expect.objectContaining({ payload: { artifactId: spec.id, runId: ctx.runId, issues: out.issues } }),
    ]);
    reconcile.mockClear();
    const rejectedRisk = await service.ingestArtifact(
      artifact({
        risks: [
          {
            key: "off-grid",
            title: "Off grid",
            likelihood: 10,
          },
        ],
        dependencies: [42],
      }),
      ctx,
    );
    expect(rejectedRisk.issues).toHaveLength(2);
    expect(reconcile).not.toHaveBeenCalled();
    // Rejections leave the plan lock usable for subsequent valid changes.
    expect((await service.ingestArtifact(artifact({ risks: ["valid"] }), ctx)).issues).toEqual([]);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("serialises concurrent identical intake and still adds a sibling's new risk association", async () => {
    const { service, ctx, items, reconcile } = await make();
    const spec = artifact({ risks: ["flaky-tests"], decisions: [{ key: "store", title: "Store" }] });
    const results = await Promise.all(Array.from({ length: 3 }, () => service.ingestArtifact(spec, ctx)));
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(reconcile).toHaveBeenCalledTimes(1);
    const sibling = await service.ingestArtifact(spec, { ...ctx, workItemId: items[1]!.id });
    expect(sibling.risks[0]!.affects).toEqual(items.map((i) => i.id));
    expect(reconcile).toHaveBeenCalledTimes(2);
    const journal = await service.journalOf(ctx.planId);
    expect(journal.filter((e) => e.type === "risk.raised")).toHaveLength(1);
    expect(journal.filter((e) => e.type === "risk.updated")).toHaveLength(1);
    expect(journal.filter((e) => e.type === "decision.opened")).toHaveLength(1);
  });
});
