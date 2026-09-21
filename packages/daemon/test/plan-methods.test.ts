/**
 * The plan methods (#169) and `claims.release` (#88), over a plan built the way a real one is
 * (`plan-fixture.ts`).
 *
 * Every read is asserted through its own protocol schema rather than by shape, because the
 * schema is the contract: a field the daemon forgot, or one it invented, fails here and not
 * in a renderer. The two that would otherwise drift are pinned to their other implementation
 * instead of to a literal - `items.list`'s classification against `PlanService.schedule()`,
 * and `schedule.explain` against `PlanService.explain()`, which is what `orca plan explain`
 * prints.
 */
import { describe, expect, it } from "vitest";
import {
  CONTROL_METHODS,
  ClaimsReleaseResultSchema,
  DecisionsDecideResultSchema,
  DecisionsListResultSchema,
  DecisionsReopenResultSchema,
  DependenciesListResultSchema,
  DependenciesWaiveResultSchema,
  ItemsListResultSchema,
  JournalListResultSchema,
  PLAN_CHANGED,
  PLAN_READ_METHODS,
  PlanGetResultSchema,
  PlansListResultSchema,
  RisksListResultSchema,
  RisksUpdateResultSchema,
  ScheduleExplainResultSchema,
  ScheduleGetResultSchema,
  type NotificationMessage,
} from "@orca/protocol";
import { ReadModel, Subscription, methodsFor, type MethodContext } from "../src/index.js";
import { planFixture, planFixtureWithLiveClaim } from "./plan-fixture.js";

describe("plan reads", () => {
  it("plans.list answers one plan with counts that add up to its items", async () => {
    const f = await planFixture();
    const result = PlansListResultSchema.parse(await f.plans.plansList());
    expect(result.plans).toHaveLength(1);
    const plan = result.plans[0]!;
    expect(plan.key).toBe("sso");
    expect(plan.title).toBe("SSO rollout");
    expect(plan.requestIds).toEqual(["req-1"]);
    expect(plan.policy.riskAppetite).toBe("high");
    const items = await f.stores.workItems.list((w) => w.planId === f.planId);
    expect(Object.values(plan.counts).reduce((a, b) => a + b, 0)).toBe(items.length);
    // The plan as the fixture built it: one of each thing worth having one of.
    expect(plan.counts).toMatchObject({ ready: 1, running: 1, held: 1, done: 1, failed: 1 });
  });

  it("plan.get answers the same view for one plan, and refuses an unknown one", async () => {
    const f = await planFixture();
    const result = PlanGetResultSchema.parse(await f.plans.planGet({ planId: f.planId }));
    expect(result.plan.id).toBe(f.planId);
    expect(result.plan.riskMatrix.scale).toBe(5);
    await expect(f.plans.planGet({ planId: "plan_nope" })).rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
  });

  it("items.list classifies every item exactly as schedule() buckets it", async () => {
    const f = await planFixture();
    const result = ItemsListResultSchema.parse(await f.plans.itemsList({ planId: f.planId, limit: 200, offset: 0 }));
    // The scheduler's own answer, computed independently of the read model.
    const schedule = await f.plan.schedule(f.planId);
    const expected = new Map<string, string>();
    for (const r of schedule.ready) expected.set(r.workItemId, "ready");
    for (const id of schedule.running) expected.set(id, "running");
    for (const w of schedule.waiting) expected.set(w.workItemId, "waiting");
    for (const h of schedule.held) expected.set(h.workItemId, "held");
    for (const u of schedule.unschedulable) expected.set(u.workItemId, "unschedulable");
    for (const id of schedule.settled.done) expected.set(id, "done");
    for (const id of [...schedule.settled.failed, ...schedule.settled.cancelled]) expected.set(id, "failed");
    expect(result.total).toBe(expected.size);
    for (const item of result.items) expect(item.classification).toBe(expected.get(item.id));

    const bySlug = Object.fromEntries(result.items.map((i) => [i.slug, i]));
    expect(bySlug["auth-api"]!.classification).toBe("ready");
    expect(bySlug["auth-ui"]!.classification).toBe("waiting");
    expect(bySlug["auth-crypto"]!.classification).toBe("held");
    expect(bySlug["auth-metrics"]!.classification).toBe("running");
    // The held item's exposure is what holds it, and it travels with the row.
    expect(bySlug["auth-crypto"]!.risk.level).toBe("critical");
    expect(bySlug["auth-crypto"]!.risk.risks.map((r) => r.key)).toEqual(["key-leak"]);
    // The claim is the run holding the item, which is what the table's last column shows.
    expect(bySlug["auth-metrics"]!.claim).toEqual({ runId: "run-metrics" });
    expect(bySlug["auth-api"]!.claim).toBeUndefined();
    // Ready first, in the scheduler's order: the rows are the dispatch order, not a sort.
    expect(result.items[0]!.slug).toBe("auth-api");
    expect(result.items[0]!.priority!.reasons.length).toBeGreaterThan(0);
  });

  it("items.list filters and pages without reordering", async () => {
    const f = await planFixture();
    const waiting = ItemsListResultSchema.parse(
      await f.plans.itemsList({ planId: f.planId, classification: ["waiting"], limit: 200, offset: 0 }),
    );
    expect(waiting.items.map((i) => i.slug).sort()).toEqual(["auth-docs", "auth-legal", "auth-store", "auth-ui"]);
    expect(waiting.total).toBe(4);

    const page = ItemsListResultSchema.parse(
      await f.plans.itemsList({ planId: f.planId, classification: ["waiting"], limit: 2, offset: 1 }),
    );
    // `total` counts the filter and not the page, so a client pages without asking again.
    expect(page.total).toBe(4);
    expect(page.items.map((i) => i.slug)).toEqual(waiting.items.slice(1, 3).map((i) => i.slug));

    const text = ItemsListResultSchema.parse(
      await f.plans.itemsList({ planId: f.planId, text: "LOGIN", limit: 200, offset: 0 }),
    );
    // Case-insensitive, over slug and title both.
    expect(text.items.map((i) => i.slug).sort()).toEqual(["auth-legacy", "auth-metrics", "auth-ui"]);

    const byRequest = ItemsListResultSchema.parse(
      await f.plans.itemsList({ planId: f.planId, requestId: "req-nope", limit: 200, offset: 0 }),
    );
    expect(byRequest.items).toEqual([]);
  });

  it("schedule.get answers the compact schedule with ids on every bucket entry", async () => {
    const f = await planFixture();
    const { schedule } = ScheduleGetResultSchema.parse(await f.plans.scheduleGet({ planId: f.planId }));
    expect(schedule.ready.map((r) => r.slug)).toEqual(["auth-api"]);
    expect(schedule.ready[0]!.workItemId).toBe(f.ids["auth-api"]);
    expect(schedule.ready[0]!.reasons.length).toBeGreaterThan(0);
    expect(schedule.waiting.find((w) => w.slug === "auth-store")!.on).toEqual(["waiting for decision datastore"]);
    expect(schedule.held.map((h) => h.slug)).toEqual(["auth-crypto"]);
    expect(schedule.running).toEqual(["auth-metrics"]);
    expect(schedule.done).toEqual(["auth-spike"]);
    expect(schedule.failed).toEqual(["auth-legacy"]);
    expect(schedule.cycles).toEqual([]);
    expect(schedule.criticalPath[0]).toBe("auth-api");
    expect(schedule.openDecisions.map((d) => d.key)).toEqual(["datastore"]);
  });

  it("schedule.explain is `orca plan explain`'s output, line for line", async () => {
    const f = await planFixture();
    for (const slug of ["auth-api", "auth-ui", "auth-store", "auth-crypto", "auth-legacy"]) {
      const { lines } = ScheduleExplainResultSchema.parse(
        await f.plans.scheduleExplain({ planId: f.planId, workItemId: slug }),
      );
      // The CLI prints exactly `PlanService.explain`; the wire must not paraphrase it.
      expect(lines).toEqual(await f.plan.explain(f.planId, slug));
      expect(lines.length).toBeGreaterThan(0);
    }
    const held = await f.plans.scheduleExplain({ planId: f.planId, workItemId: "auth-crypto" });
    expect(held.lines.some((l) => l.startsWith("held: "))).toBe(true);
    expect(held.lines).toContain("risk key-leak: open (L4 x I5)");
    // An id works as well as a slug, and an unknown one is refused rather than guessed at.
    const byId = await f.plans.scheduleExplain({ planId: f.planId, workItemId: f.ids["auth-api"]! });
    expect(byId.lines[0]).toMatch(/^auth-api: /);
    await expect(f.plans.scheduleExplain({ planId: f.planId, workItemId: "nope" })).rejects.toMatchObject({
      code: "PLAN_INVALID",
    });
  });

  it("dependencies.list carries the live evaluation beside the stored status", async () => {
    const f = await planFixture();
    const all = DependenciesListResultSchema.parse(await f.plans.dependenciesList({ planId: f.planId }));
    // Four edges, not five: the decision's `blocks: ["auth-store"]` and that item's
    // `dependsOn: ["decision:datastore"]` are one dependency, declared from both ends.
    expect(all.dependencies).toHaveLength(4);
    const byFrom = Object.fromEntries(all.dependencies.map((d) => [d.fromSlug, d]));

    expect(byFrom["auth-ui"]!.target).toEqual({ kind: "work-item", workItemId: f.ids["auth-api"], slug: "auth-api" });
    expect(byFrom["auth-ui"]!.evaluation.state).toBe("waiting");
    expect(byFrom["auth-docs"]!.target).toMatchObject({ kind: "work-item", stage: "spec" });
    expect(byFrom["auth-store"]!.target).toEqual({
      kind: "decision",
      decisionId: f.decisionId,
      key: "datastore",
    });
    expect(byFrom["auth-legal"]!.target).toEqual({ kind: "external", key: "legal-review" });
    expect(byFrom["auth-legal"]!.evaluation.detail).toBe("waiting for external 'legal-review'");

    const one = DependenciesListResultSchema.parse(
      await f.plans.dependenciesList({ planId: f.planId, workItemId: "auth-store" }),
    );
    expect(one.dependencies).toHaveLength(1);
    const open = DependenciesListResultSchema.parse(
      await f.plans.dependenciesList({ planId: f.planId, status: ["waived"] }),
    );
    expect(open.dependencies).toEqual([]);
  });

  it("risks.list scores and levels every risk against the plan's own matrix", async () => {
    const f = await planFixture();
    const result = RisksListResultSchema.parse(await f.plans.risksList({ planId: f.planId }));
    expect(result.matrix).toEqual({ scale: 5, thresholds: { medium: 5, high: 10, critical: 16 } });
    expect(result.appetite).toBe("high");
    // Highest score first.
    expect(result.risks.map((r) => r.key)).toEqual(["key-leak", "vendor-slip"]);
    const leak = result.risks[0]!;
    expect(leak.score).toBe(20);
    expect(leak.level).toBe("critical");
    expect(leak.open).toBe(true);
    expect(leak.affects).toEqual([{ id: f.ids["auth-crypto"], slug: "auth-crypto" }]);
    expect(leak.mitigatedBy).toEqual([{ id: f.ids["auth-crypto"], slug: "auth-crypto" }]);

    const byItem = RisksListResultSchema.parse(await f.plans.risksList({ planId: f.planId, workItemId: "auth-api" }));
    expect(byItem.risks.map((r) => r.key)).toEqual(["vendor-slip"]);
  });

  it("decisions.list carries the matrix and the items each decision gates", async () => {
    const f = await planFixture();
    const result = DecisionsListResultSchema.parse(await f.plans.decisionsList({ planId: f.planId }));
    expect(result.decisions).toHaveLength(1);
    const d = result.decisions[0]!;
    expect(d.key).toBe("datastore");
    expect(d.status).toBe("open");
    expect(d.criteria.map((c) => c.key)).toEqual(["latency", "ops"]);
    expect(d.options.map((o) => o.key)).toEqual(["cookie", "redis"]);
    // `blocks` is the dependencies, resolved: the decision itself keeps no copy of them.
    expect(d.blocks).toEqual([{ id: f.ids["auth-store"], slug: "auth-store" }]);
    expect(d.chosen).toBeUndefined();

    const decided = DecisionsListResultSchema.parse(
      await f.plans.decisionsList({ planId: f.planId, status: ["decided"] }),
    );
    expect(decided.decisions).toEqual([]);
  });

  it("journal.list pages forwards and backwards over the same entries", async () => {
    const f = await planFixture();
    const whole = JournalListResultSchema.parse(await f.plans.journalList({ planId: f.planId, limit: 500 }));
    expect(whole.entries.length).toBeGreaterThan(10);
    expect(whole.hasMore).toBe(false);
    expect(whole.lastSeq).toBe(whole.entries[whole.entries.length - 1]!.seq);
    // Oldest first, and the summary is the line the CLI prints.
    expect(whole.entries[0]!.type).toBe("plan.created");
    expect(whole.entries.find((e) => e.type === "work-item.added")!.summary).toBe("auth-api");

    const first = JournalListResultSchema.parse(await f.plans.journalList({ planId: f.planId, limit: 3 }));
    expect(first.entries).toHaveLength(3);
    expect(first.hasMore).toBe(true);
    const second = JournalListResultSchema.parse(
      await f.plans.journalList({ planId: f.planId, after: first.nextCursor!, limit: 3 }),
    );
    expect(second.entries.map((e) => e.seq)).toEqual(whole.entries.slice(3, 6).map((e) => e.seq));

    // Backwards from the same anchor lands exactly on the page before it, still oldest first.
    const back = JournalListResultSchema.parse(
      await f.plans.journalList({ planId: f.planId, before: second.entries[0]!.seq, limit: 3 }),
    );
    expect(back.entries.map((e) => e.seq)).toEqual(first.entries.map((e) => e.seq));
    expect(back.hasMore).toBe(false);

    // An unknown type matches nothing rather than failing.
    const typed = JournalListResultSchema.parse(
      await f.plans.journalList({ planId: f.planId, types: ["risk.raised", "no.such.type"], limit: 500 }),
    );
    expect(typed.entries.map((e) => e.type)).toEqual(["risk.raised", "risk.raised"]);
  });

  it("carries no date estimate anywhere (#174)", async () => {
    const f = await planFixture();
    const everything = JSON.stringify([
      await f.plans.plansList(),
      await f.plans.itemsList({ planId: f.planId, limit: 200, offset: 0 }),
      await f.plans.scheduleGet({ planId: f.planId }),
      await f.plans.risksList({ planId: f.planId }),
      await f.plans.decisionsList({ planId: f.planId }),
    ]);
    // The only durations, completion percentages or forecasts ORCA could put on the wire
    // would be invented ones, so none of the field names that would carry them exists.
    for (const forbidden of ["eta", "etaMs", "readyBy", "estimatedAt", "percentComplete", "remainingMs", "dueAt"])
      expect(everything).not.toContain(`"${forbidden}"`);
    // `criticalPathLength` is in the plan's estimate units and is deliberately not a time.
    const { schedule } = await f.plans.scheduleGet({ planId: f.planId });
    expect(typeof schedule.criticalPathLength).toBe("number");
  });
});

describe("plan writes", () => {
  it("dependencies.waive waives the edge and journals it with the daemon as the actor", async () => {
    const f = await planFixture();
    const before = await f.plans.dependenciesList({ planId: f.planId, workItemId: "auth-ui" });
    const dependencyId = before.dependencies[0]!.id;

    const result = DependenciesWaiveResultSchema.parse(
      await f.control.waiveDependency({ planId: f.planId, dependencyId, rationale: "shipping without the UI" }),
    );
    expect(result.dependency.status).toBe("waived");
    expect(result.dependency.evaluation.state).toBe("waived");
    expect(result.dependency.resolution).toBe("shipping without the UI");

    const journal = await f.plan.journalOf(f.planId);
    const entry = journal.filter((e) => e.type === "dependency.resolved").at(-1)!;
    expect(entry.origin).toEqual({ kind: "human", actor: "daemon" });
    expect(entry.payload).toMatchObject({ dependencyId, status: "waived" });

    // And the item it blocked may now run.
    const after = await f.plans.itemsList({ planId: f.planId, limit: 200, offset: 0 });
    expect(after.items.find((i) => i.slug === "auth-ui")!.classification).toBe("ready");

    // A dependency from another plan is refused rather than quietly honoured.
    await expect(f.control.waiveDependency({ planId: "plan_other", dependencyId })).rejects.toMatchObject({
      code: "PLAN_NOT_FOUND",
    });
  });

  it("decisions.decide unblocks the dependency that was waiting on it", async () => {
    const f = await planFixture();
    const result = DecisionsDecideResultSchema.parse(
      await f.control.decide({ planId: f.planId, key: "datastore", option: "redis", rationale: "ops said so" }),
    );
    expect(result.choice).toBe("redis");
    expect(result.decision.status).toBe("decided");
    expect(result.decision.decidedBy).toBe("human");
    expect(result.decision.rationale).toBe("ops said so");
    // The matrix's own pick travels beside the person's, which is how a client shows that
    // they differ without the daemon deciding what that means.
    expect(result.recommended).toBe("cookie");

    const deps = DependenciesListResultSchema.parse(
      await f.plans.dependenciesList({ planId: f.planId, workItemId: "auth-store" }),
    );
    expect(deps.dependencies[0]!.status).toBe("satisfied");
    expect(deps.dependencies[0]!.evaluation).toEqual({
      state: "satisfied",
      detail: "decision datastore = redis",
    });
    const items = await f.plans.itemsList({ planId: f.planId, limit: 200, offset: 0 });
    expect(items.items.find((i) => i.slug === "auth-store")!.classification).toBe("ready");

    // An option the decision does not offer is refused, not invented.
    await expect(
      f.control.decide({ planId: f.planId, key: "datastore", option: "carrier-pigeon" }),
    ).rejects.toMatchObject({ code: "PLAN_INVALID" });
  });

  it("decisions.reopen clears the choice and names the dependencies it re-opened", async () => {
    const f = await planFixture();
    await f.control.decide({ planId: f.planId, key: "datastore", option: "redis" });
    const deps = await f.plans.dependenciesList({ planId: f.planId, workItemId: "auth-store" });
    const dependencyId = deps.dependencies[0]!.id;

    const result = DecisionsReopenResultSchema.parse(await f.control.reopen({ planId: f.planId, key: "datastore" }));
    expect(result.decision.status).toBe("open");
    expect(result.decision.chosen).toBeUndefined();
    expect(result.reopenedDependencyIds).toEqual([dependencyId]);

    const after = await f.plans.dependenciesList({ planId: f.planId, workItemId: "auth-store" });
    expect(after.dependencies[0]!.status).toBe("open");
    const items = await f.plans.itemsList({ planId: f.planId, limit: 200, offset: 0 });
    expect(items.items.find((i) => i.slug === "auth-store")!.classification).toBe("waiting");
  });

  it("risks.update accepts a risk, which releases the item it was holding", async () => {
    const f = await planFixture();
    const result = RisksUpdateResultSchema.parse(
      await f.control.updateRisk({ planId: f.planId, key: "key-leak", status: "accepted" }),
    );
    expect(result.risk.status).toBe("accepted");
    expect(result.risk.open).toBe(false);
    expect(result.risk.closedAt).toBeDefined();

    const items = await f.plans.itemsList({ planId: f.planId, limit: 200, offset: 0 });
    const crypto = items.items.find((i) => i.slug === "auth-crypto")!;
    expect(crypto.classification).toBe("ready");
    expect(crypto.risk.level).toBe("none");

    await expect(f.control.updateRisk({ planId: f.planId, key: "nope", status: "closed" })).rejects.toMatchObject({
      code: "PLAN_INVALID",
    });
  });

  it("claims.release frees an item whose owner is gone, and says what it did not fix", async () => {
    const f = await planFixture();
    const result = ClaimsReleaseResultSchema.parse(
      await f.control.releaseClaim({ workItemId: f.ids["auth-metrics"]!, force: false }),
    );
    expect(result.claim.workItemId).toBe(f.ids["auth-metrics"]);
    expect(result.claim.owner.runId).toBe("run-metrics");
    expect(result.claim.owner.missing).toBe(true);
    // The claim is gone, and the note is the one `orca claims release` prints: the item is
    // still `in-progress`, so the scheduler still treats it as running.
    expect(await f.stores.claims.get(f.ids["auth-metrics"]!)).toBeUndefined();
    expect(result.note).toContain("still in-progress");

    await expect(f.control.releaseClaim({ workItemId: "wi_nope", force: false })).rejects.toMatchObject({
      code: "CLAIM_NOT_FOUND",
    });
  });

  it("claims.release refuses while the owner run is live, and obeys force", async () => {
    const f = await planFixtureWithLiveClaim();
    const workItemId = f.ids["auth-api"]!;
    await expect(f.control.releaseClaim({ workItemId, force: false })).rejects.toMatchObject({ code: "RUN_STATE" });
    // `claims.list` predicted that refusal, which is what lets a client grey the action out.
    const listed = await f.reads.claimsList({ workItemId });
    expect(listed.claims[0]!.owner.releasable).toBe(false);

    const forced = ClaimsReleaseResultSchema.parse(await f.control.releaseClaim({ workItemId, force: true }));
    expect(forced.claim.owner.runId).toBe("run-live");
    // This item is not in-progress, so there is nothing left over to warn about.
    expect(forced.note).toBeUndefined();
    expect(await f.stores.claims.get(workItemId)).toBeUndefined();
  });
});

describe("the plan surface in the handshake", () => {
  const base = (f: Awaited<ReturnType<typeof planFixture>>, readOnly: boolean): MethodContext => ({
    orcaVersion: "0.5.0",
    capabilities: readOnly ? ["runs.read", "plan.read"] : ["runs.read", "runs.control", "plan.read", "plan.write"],
    reads: f.reads,
    ...(readOnly ? {} : { planControl: f.control }),
  });

  it("advertises the nine reads, and the writes only when it is not read-only", async () => {
    const f = await planFixture();
    const writable = Object.keys(methodsFor(base(f, false)));
    for (const method of PLAN_READ_METHODS) expect(writable).toContain(method);
    for (const method of [
      "dependencies.waive",
      "decisions.decide",
      "decisions.reopen",
      "risks.update",
      "claims.release",
    ])
      expect(writable).toContain(method);

    const readOnly = Object.keys(methodsFor(base(f, true)));
    for (const method of PLAN_READ_METHODS) expect(readOnly).toContain(method);
    // The whole of `--read-only`: absent, not present and refusing.
    for (const method of CONTROL_METHODS) expect(readOnly).not.toContain(method);
  });

  it("omits all nine reads when the daemon was given no plan service", async () => {
    const f = await planFixture();
    const runsOnly = new ReadModel({ orchestrator: f.orchestrator, clock: f.clock });
    expect(runsOnly.plans).toBeUndefined();
    const table = methodsFor({ orcaVersion: "0.5.0", capabilities: ["runs.read"], reads: runsOnly });
    for (const method of PLAN_READ_METHODS) expect(Object.keys(table)).not.toContain(method);
  });
});

describe("plan.changed", () => {
  it("reaches a store-wide subscriber after a write, and never a run-scoped one", async () => {
    const f = await planFixture();
    const sent: NotificationMessage[] = [];
    const source = { subscribe: () => () => {}, eventsRange: async () => [] };
    const wide = new Subscription({
      id: "sub-1",
      params: { methods: [PLAN_CHANGED] },
      source,
      send: (m) => void sent.push(m),
      plans: f.stores.plan.journal,
    });
    const scoped = new Subscription({
      id: "sub-2",
      params: { runId: "run-metrics" },
      source,
      send: (m) => void sent.push(m),
      plans: f.stores.plan.journal,
    });
    await wide.start();
    await scoped.start();

    await f.control.updateRisk({ planId: f.planId, key: "key-leak", status: "accepted" });
    wide.stop();
    scoped.stop();

    // One frame per journal entry, all on the store-wide subscription.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((m) => m.method === PLAN_CHANGED)).toBe(true);
    expect(new Set(sent.map((m) => (m.params as { subscriptionId: string }).subscriptionId))).toEqual(
      new Set(["sub-1"]),
    );
    const risk = sent.find((m) => (m.params as { kinds: string[] }).kinds.includes("risks"))!;
    expect(risk.params).toMatchObject({ planId: f.planId, kinds: ["risks", "schedule", "journal"] });
    expect(typeof (risk.params as { seq: number }).seq).toBe("number");
    // No `runId`: a plan outlives every run in it, so there is none to scope it to.
    expect(risk.params).not.toHaveProperty("runId");
  });
});
