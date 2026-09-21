/**
 * The plan read model: a `PlanService` and its stores in, the display shapes of
 * `@orca/protocol`'s `plan.ts` out. `ReadModel` holds one of these when the daemon was given
 * a plan service, and the method table is a thin wrapper over it, exactly as it is over the
 * run reads.
 *
 * Two things happen here that no client should have to do for itself.
 *
 * **One schedule per call.** `computeSchedule` is a pure function of the whole plan - items,
 * dependencies, risks, decisions - and almost everything a plan screen shows is a projection
 * of it: which bucket an item is in, why it is there, what order the ready ones go in, which
 * dependency is live rather than merely stored. So every method builds a `PlanPass`, which
 * reads the snapshot once and computes the schedule once (lazily - `journal.list` needs
 * neither), and nothing here calls `PlanService.schedule()` or `PlanService.explain()`,
 * because those take a snapshot of their own and `explain` takes two.
 *
 * **The explanation is not re-derived.** `schedule.explain` returns `core`'s
 * `explainWorkItem` verbatim, followed by the dependency and risk lines `orca plan explain`
 * appends (`PlanService.explain`). The wire and the terminal say the same words about the
 * same item, and a test pins the two together rather than trusting that they stayed level.
 *
 * Nothing here writes. `PlanService` journals every mutation, so a read that quietly
 * reconciled a stale dependency status would append to the audit trail on a `GET`; the live
 * evaluation travels on the view beside the stored status instead (`DependencyView`).
 */
import {
  DEPENDENCY_START_PHASE,
  OrcaError,
  compactSchedule,
  computeSchedule,
  decisionBlocks,
  explainWorkItem,
  isOpenRisk,
  itemRiskExposure,
  riskLevel,
  riskScore,
  type Clock,
  type Decision,
  type Dependency,
  type Plan,
  type PlanEvent,
  type Risk,
  type Schedule,
  type WorkItem,
} from "@orca/core";
import type { Orchestrator, PlanService, PlanSnapshot } from "@orca/engine";
import type {
  DecisionView,
  DecisionsListParams,
  DecisionsListResult,
  DependenciesListParams,
  DependenciesListResult,
  DependencyTargetView,
  DependencyView,
  ItemClassification,
  ItemRef,
  ItemsListParams,
  ItemsListResult,
  JournalListParams,
  JournalListResult,
  PlanGetParams,
  PlanGetResult,
  PlanItemView,
  PlanJournalEntryView,
  PlansListResult,
  PlanView,
  RiskExposureView,
  RiskView,
  RisksListParams,
  RisksListResult,
  ScheduleExplainParams,
  ScheduleExplainResult,
  ScheduleGetParams,
  ScheduleGetResult,
  ScheduleView,
} from "@orca/protocol";

/** The order `items.list` returns in, and the order the counts are reported in. */
const CLASSIFICATION_ORDER: readonly ItemClassification[] = [
  "ready",
  "running",
  "waiting",
  "held",
  "unschedulable",
  "done",
  "failed",
];

const ZERO_COUNTS = (): Record<ItemClassification, number> => ({
  ready: 0,
  running: 0,
  waiting: 0,
  held: 0,
  unschedulable: 0,
  done: 0,
  failed: 0,
});

/**
 * One call's plan: the snapshot read once, the schedule computed once from it, and the claim
 * index read once. Nothing outlives the call, so no read here serves a plan it cached
 * earlier - the same rule the run reads' `Pass` follows, for the same reason.
 */
class PlanPass {
  private snap: PlanSnapshot | undefined;
  private sched: Schedule | undefined;
  private claims: Map<string, string> | undefined;

  constructor(
    private readonly svc: PlanService,
    private readonly orc: Orchestrator,
    readonly asOf: string,
  ) {}

  async snapshot(planId: string): Promise<PlanSnapshot> {
    this.snap ??= await this.svc.snapshot(planId);
    return this.snap;
  }

  /** The schedule, computed from the snapshot this pass already holds. Never journalled. */
  async schedule(planId: string): Promise<Schedule> {
    if (!this.sched) {
      const snap = await this.snapshot(planId);
      this.sched = computeSchedule({ ...snap, now: this.asOf });
    }
    return this.sched;
  }

  /** `workItemId -> runId` for every held claim in the store. One directory read per call. */
  async claimedBy(): Promise<Map<string, string>> {
    if (!this.claims) {
      this.claims = new Map();
      for (const c of await this.orc.stores.claims.list()) this.claims.set(c.workItemId, c.runId);
    }
    return this.claims;
  }
}

/** Where the scheduler put each item, as one lookup. Every item lands in exactly one bucket. */
function classify(schedule: Schedule, items: readonly WorkItem[]): Map<string, ItemClassification> {
  const out = new Map<string, ItemClassification>();
  for (const r of schedule.ready) out.set(r.workItemId, "ready");
  for (const id of schedule.running) out.set(id, "running");
  for (const w of schedule.waiting) out.set(w.workItemId, "waiting");
  for (const h of schedule.held) out.set(h.workItemId, "held");
  for (const u of schedule.unschedulable) out.set(u.workItemId, "unschedulable");
  for (const id of schedule.settled.done) out.set(id, "done");
  for (const id of schedule.settled.failed) out.set(id, "failed");
  // A cancelled item is `failed` on the wire: the seven classes are what a person filters by,
  // and both mean the item will not be delivered. Its own `status` still says `cancelled`.
  for (const id of schedule.settled.cancelled) out.set(id, "failed");
  // Nothing should fall through - `computeSchedule` buckets every item it is given - but an
  // item the schedule does not know is better reported as unschedulable than dropped from a
  // list a person is counting.
  for (const i of items) if (!out.has(i.id)) out.set(i.id, "unschedulable");
  return out;
}

function exposureView(workItemId: string, schedule: Schedule, plan: Plan, risks: readonly Risk[]): RiskExposureView {
  // `computeSchedule` exposes every item it was given, settled ones included; the fallback is
  // for an item the schedule never saw, and it is the same arithmetic.
  const exp = schedule.exposure[workItemId] ?? itemRiskExposure(workItemId, risks, plan.riskMatrix);
  return { score: exp.score, level: exp.level, risks: [...exp.risks] };
}

function scored(r: Risk, plan: Plan) {
  const score = riskScore(r);
  return { id: r.id, key: r.key, title: r.title, status: r.status, score, level: riskLevel(score, plan.riskMatrix) };
}

/** A work item as another object links to it. Unknown ids keep the id as the slug. */
function refs(ids: readonly string[], byId: ReadonlyMap<string, WorkItem>): ItemRef[] {
  return ids.map((id) => ({ id, slug: byId.get(id)?.slug ?? id }));
}

function riskView(r: Risk, plan: Plan, byId: ReadonlyMap<string, WorkItem>): RiskView {
  const s = scored(r, plan);
  return {
    id: r.id,
    key: r.key,
    title: r.title,
    description: r.description,
    category: r.category,
    likelihood: r.likelihood,
    impact: r.impact,
    score: s.score,
    level: s.level,
    status: r.status,
    open: isOpenRisk(r),
    triggers: [...r.triggers],
    affects: refs(r.affects, byId),
    mitigatedBy: refs(r.mitigatedBy, byId),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(r.mitigation ? { mitigation: r.mitigation } : {}),
    ...(r.contingency ? { contingency: r.contingency } : {}),
    ...(r.owner ? { owner: r.owner } : {}),
    ...(r.closedAt ? { closedAt: r.closedAt } : {}),
  };
}

function decisionView(
  d: Decision,
  dependencies: readonly Dependency[],
  byId: ReadonlyMap<string, WorkItem>,
): DecisionView {
  return {
    id: d.id,
    key: d.key,
    title: d.title,
    question: d.question,
    status: d.status,
    criteria: d.criteria,
    options: d.options,
    scale: d.scale,
    consequences: [...d.consequences],
    // The dependencies are the only record of what a decision gates; `Decision` keeps none.
    blocks: refs(decisionBlocks(d.id, dependencies), byId),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    ...(d.context ? { context: d.context } : {}),
    ...(d.result ? { result: d.result } : {}),
    ...(d.chosen ? { chosen: d.chosen } : {}),
    ...(d.decidedBy ? { decidedBy: d.decidedBy } : {}),
    ...(d.rationale ? { rationale: d.rationale } : {}),
    ...(d.supersedes ? { supersedes: d.supersedes } : {}),
    ...(d.dueBy ? { dueBy: d.dueBy } : {}),
    ...(d.decidedAt ? { decidedAt: d.decidedAt } : {}),
  };
}

function targetView(
  target: Dependency["target"],
  byId: ReadonlyMap<string, WorkItem>,
  decisionsById: ReadonlyMap<string, Decision>,
): DependencyTargetView {
  switch (target.kind) {
    case "work-item": {
      const up = byId.get(target.workItemId);
      return {
        kind: "work-item",
        workItemId: target.workItemId,
        ...(up ? { slug: up.slug } : {}),
        ...(target.stage ? { stage: target.stage } : {}),
      };
    }
    case "decision": {
      const dec = decisionsById.get(target.decisionId);
      return { kind: "decision", decisionId: target.decisionId, ...(dec ? { key: dec.key } : {}) };
    }
    case "external":
      return {
        kind: "external",
        key: target.key,
        ...(target.description ? { description: target.description } : {}),
      };
  }
}

function dependencyView(
  d: Dependency,
  schedule: Schedule,
  byId: ReadonlyMap<string, WorkItem>,
  decisionsById: ReadonlyMap<string, Decision>,
): DependencyView {
  // The schedule evaluated every dependency in the plan once; the stored `status` is what was
  // last written, which can lag it until `reconcile` runs. Both travel, live one first.
  const live = schedule.dependencyStates[d.id];
  return {
    id: d.id,
    from: d.from,
    target: targetView(d.target, byId, decisionsById),
    type: d.type,
    requiredBy: d.requiredBy,
    status: d.status,
    evaluation: live ?? { state: d.status === "open" ? "waiting" : d.status, detail: d.resolution ?? d.status },
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    ...(byId.get(d.from) ? { fromSlug: byId.get(d.from)!.slug } : {}),
    ...(d.rationale ? { rationale: d.rationale } : {}),
    ...(d.resolution ? { resolution: d.resolution } : {}),
    ...(d.resolvedAt ? { resolvedAt: d.resolvedAt } : {}),
  };
}

/**
 * The one line `orca plan journal` prints in its last column, for the entry types that have
 * one. A timeline row renders this; a client that wants more reads `payload`, which travels
 * as the journal recorded it.
 */
export function journalSummary(entry: PlanEvent, slug: (id: string) => string): string {
  const p = entry.payload as Record<string, unknown>;
  switch (entry.type) {
    case "work-item.added":
      return (p["workItem"] as { slug: string }).slug;
    case "work-item.updated":
      return `${slug(p["workItemId"] as string)} ${JSON.stringify(p["changes"])}`;
    case "dependency.added": {
      const dep = p["dependency"] as { from: string; target: unknown };
      return `${slug(dep.from)} -> ${JSON.stringify(dep.target)}`;
    }
    case "dependency.resolved":
      return `${String(p["dependencyId"])} ${String(p["status"])}${p["resolution"] ? `: ${String(p["resolution"])}` : ""}`;
    case "risk.raised":
      return (p["risk"] as { key: string }).key;
    case "risk.updated":
      return `${String(p["riskId"])} ${JSON.stringify(p["changes"])}`;
    case "decision.opened":
      return (p["decision"] as { key: string }).key;
    case "decision.resolved":
      return `${String(p["decisionId"])} = ${String(p["chosen"])} (${String(p["decidedBy"])})`;
    case "schedule.computed":
      return `ready: ${(p["ready"] as string[]).map(slug).join(", ") || "-"}; waiting: ${(p["waiting"] as string[]).length}; held: ${(p["held"] as string[]).length}`;
    case "dispatch.started":
    case "dispatch.finished":
    case "dispatch.deferred":
      return `${slug(p["workItemId"] as string)}${p["status"] ? ` ${String(p["status"])}` : ""}${p["reason"] ? ` ${String(p["reason"])}` : ""}`;
    default:
      return JSON.stringify(p);
  }
}

export interface PlanModelOptions {
  plan: PlanService;
  /** For the claim index: which run holds which item. The plan itself does not know. */
  orchestrator: Orchestrator;
  /** Defaults to the plan service's own clock, so a test can pin every `asOf`. */
  clock?: Clock | undefined;
}

export class PlanModel {
  private readonly svc: PlanService;
  private readonly orc: Orchestrator;
  private readonly clock: Clock;

  constructor(opts: PlanModelOptions) {
    this.svc = opts.plan;
    this.orc = opts.orchestrator;
    this.clock = opts.clock ?? opts.plan.clock;
  }

  private pass(): PlanPass {
    return new PlanPass(this.svc, this.orc, this.clock.isoNow());
  }

  /** The plan service, for the control model beside this one. */
  get service(): PlanService {
    return this.svc;
  }

  /**
   * `plans.list`: every plan in the store with its counts. One schedule per plan, which is
   * what `counts` costs; a store holds a handful of plans, not a run's worth.
   */
  async plansList(): Promise<PlansListResult> {
    const asOf = this.clock.isoNow();
    const plans = await this.svc.listPlans();
    plans.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const views: PlanView[] = [];
    for (const p of plans) views.push(await this.planView(p.id, new PlanPass(this.svc, this.orc, asOf)));
    return { plans: views, asOf };
  }

  /** `plan.get`: one plan's header and counts. Not the snapshot - that is five paged calls. */
  async planGet(params: PlanGetParams): Promise<PlanGetResult> {
    const pass = this.pass();
    return { plan: await this.planView(params.planId, pass), asOf: pass.asOf };
  }

  /**
   * `items.list`: the schedule table. Rows come back in schedule order - ready first and best
   * first - so a client that renders them as given is showing the order the dispatcher would
   * actually take, and filtering never reorders.
   */
  async itemsList(params: ItemsListParams): Promise<ItemsListResult> {
    const pass = this.pass();
    const snap = await pass.snapshot(params.planId);
    const schedule = await pass.schedule(params.planId);
    const claims = await pass.claimedBy();
    const where = classify(schedule, snap.items);
    const readyAt = new Map(schedule.ready.map((r, i) => [r.workItemId, i]));
    const text = params.text?.trim().toLowerCase();

    const rows = snap.items
      .map((item) => this.itemView(item, where.get(item.id)!, schedule, snap.plan, snap.risks, claims))
      .filter(
        (v) =>
          (!params.status?.length || params.status.includes(v.status as WorkItem["status"])) &&
          (!params.classification?.length || params.classification.includes(v.classification)) &&
          (!params.requestId || v.requestId === params.requestId) &&
          (!text || v.slug.toLowerCase().includes(text) || v.title.toLowerCase().includes(text)),
      );
    rows.sort(
      (a, b) =>
        CLASSIFICATION_ORDER.indexOf(a.classification) - CLASSIFICATION_ORDER.indexOf(b.classification) ||
        (readyAt.get(a.id) ?? 0) - (readyAt.get(b.id) ?? 0) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
    return {
      items: rows.slice(params.offset, params.offset + params.limit),
      total: rows.length,
      asOf: pass.asOf,
    };
  }

  /** `schedule.get`: the compact schedule, with the work-item id on every bucket entry. */
  async scheduleGet(params: ScheduleGetParams): Promise<ScheduleGetResult> {
    const pass = this.pass();
    const snap = await pass.snapshot(params.planId);
    const schedule = await pass.schedule(params.planId);
    const compact = compactSchedule(schedule, snap.items);
    const view: ScheduleView = {
      planId: snap.plan.id,
      computedAt: compact.computedAt,
      strategy: compact.strategy,
      ready: schedule.ready.map((r) => ({
        workItemId: r.workItemId,
        slug: r.slug,
        score: r.priority.score,
        reasons: [...r.priority.reasons],
      })),
      running: [...compact.running],
      waiting: schedule.waiting.map((w) => ({
        workItemId: w.workItemId,
        slug: w.slug,
        on: w.waitingOn.map((x) => x.detail),
      })),
      held: schedule.held.map((h) => ({ workItemId: h.workItemId, slug: h.slug, level: h.level, reason: h.reason })),
      unschedulable: schedule.unschedulable.map((u) => ({
        workItemId: u.workItemId,
        slug: u.slug,
        reason: u.reason,
      })),
      done: [...compact.done],
      failed: [...compact.failed],
      waves: compact.waves.map((w) => [...w]),
      criticalPath: [...compact.criticalPath],
      criticalPathLength: compact.criticalPathLength,
      cycles: compact.cycles.map((c) => [...c]),
      risk: compact.risk,
      openDecisions: compact.openDecisions,
      asOf: pass.asOf,
    };
    return { schedule: view, asOf: pass.asOf };
  }

  /**
   * `schedule.explain`: `core`'s own account of one item, word for word.
   *
   * This is `PlanService.explain` over a snapshot and a schedule that were already read for
   * this call, rather than the two snapshots that method takes. The lines are identical, and
   * a test asserts that against the CLI's own output rather than leaving it to inspection.
   */
  async scheduleExplain(params: ScheduleExplainParams): Promise<ScheduleExplainResult> {
    const pass = this.pass();
    const item = await this.svc.requireItem(params.planId, params.workItemId);
    const snap = await pass.snapshot(params.planId);
    const schedule = await pass.schedule(params.planId);
    const lines = explainWorkItem(schedule, snap.items, item.id);
    for (const d of snap.dependencies.filter((d) => d.from === item.id))
      lines.push(
        `dependency (${d.type}${d.requiredBy !== DEPENDENCY_START_PHASE ? `, by ${d.requiredBy}` : ""}): ${schedule.dependencyStates[d.id]?.detail ?? d.status}`,
      );
    for (const r of snap.risks.filter((r) => r.affects.includes(item.id)))
      lines.push(`risk ${r.key}: ${r.status} (L${r.likelihood} x I${r.impact})`);
    return { lines, asOf: pass.asOf };
  }

  /** `dependencies.list`: the edges, each with the scheduler's live evaluation beside its status. */
  async dependenciesList(params: DependenciesListParams): Promise<DependenciesListResult> {
    const pass = this.pass();
    const snap = await pass.snapshot(params.planId);
    const schedule = await pass.schedule(params.planId);
    const byId = new Map(snap.items.map((i) => [i.id, i]));
    const decisionsById = new Map(snap.decisions.map((d) => [d.id, d]));
    const from = params.workItemId ? (await this.svc.requireItem(params.planId, params.workItemId)).id : undefined;
    const rows = snap.dependencies
      .filter((d) => (!from || d.from === from) && (!params.status?.length || params.status.includes(d.status)))
      .map((d) => dependencyView(d, schedule, byId, decisionsById));
    return { dependencies: rows, asOf: pass.asOf };
  }

  /** `risks.list`: the register, highest score first, with the matrix it is scored against. */
  async risksList(params: RisksListParams): Promise<RisksListResult> {
    const pass = this.pass();
    const snap = await pass.snapshot(params.planId);
    const byId = new Map(snap.items.map((i) => [i.id, i]));
    const affecting = params.workItemId ? (await this.svc.requireItem(params.planId, params.workItemId)).id : undefined;
    const rows = snap.risks
      .filter(
        (r) =>
          (!params.status?.length || params.status.includes(r.status)) && (!affecting || r.affects.includes(affecting)),
      )
      .map((r) => riskView(r, snap.plan, byId))
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    return {
      risks: rows,
      matrix: snap.plan.riskMatrix,
      appetite: snap.plan.policy.riskAppetite,
      asOf: pass.asOf,
    };
  }

  /** `decisions.list`: the decisions, each with the work items it gates. */
  async decisionsList(params: DecisionsListParams): Promise<DecisionsListResult> {
    const pass = this.pass();
    const snap = await pass.snapshot(params.planId);
    const byId = new Map(snap.items.map((i) => [i.id, i]));
    const rows = snap.decisions
      .filter((d) => !params.status?.length || params.status.includes(d.status))
      .map((d) => decisionView(d, snap.dependencies, byId));
    return { decisions: rows, asOf: pass.asOf };
  }

  /**
   * `journal.list`: one page of the audit trail, with `runs.events`'s cursor semantics.
   *
   * The store reads the journal whole and this cuts it in memory. `runs.events` no longer does
   * (#208 gave the event store a ranged read), so this is now the last of the two and it says
   * so rather than pointing at a sibling that has moved on: `JsonlLogDir` has no index by
   * sequence number, and a plan's journal is orders of magnitude shorter than a run's log, so
   * the range seam #208 built for one has not been worth building for the other yet.
   */
  async journalList(params: JournalListParams): Promise<JournalListResult> {
    const pass = this.pass();
    const plan = await this.svc.requirePlan(params.planId);
    const all = await this.svc.journalOf(plan.id);
    const lastSeq = all.length ? all[all.length - 1]!.seq : 0;
    const types = params.types;
    // An unknown type matches nothing rather than failing: a newer client may ask for an
    // entry type this daemon's engine does not write.
    const matching = types?.length ? all.filter((e) => types.includes(e.type)) : all;

    let page: PlanEvent[];
    let hasMore: boolean;
    if (params.before !== undefined) {
      const earlier = matching.filter((e) => e.seq < params.before!);
      page = earlier.slice(Math.max(0, earlier.length - params.limit));
      hasMore = earlier.length > page.length;
    } else {
      const after = params.after;
      const later = after === undefined ? matching : matching.filter((e) => e.seq > after);
      page = later.slice(0, params.limit);
      hasMore = later.length > page.length;
    }

    // Slugs for the summaries. The page is a handful of entries; the item list is the plan's.
    const items = await this.orc.stores.workItems.list((w) => w.planId === plan.id);
    const byId = new Map(items.map((i) => [i.id, i]));
    const slug = (id: string) => byId.get(id)?.slug ?? id;
    const entries: PlanJournalEntryView[] = page.map((e) => ({
      id: e.id,
      seq: e.seq,
      planId: e.planId,
      at: e.at,
      type: e.type,
      origin: e.origin,
      payload: e.payload,
      summary: journalSummary(e, slug),
    }));
    const first = page[0];
    const last = page[page.length - 1];
    return {
      entries,
      ...(last ? { nextCursor: last.seq } : {}),
      ...(first ? { prevCursor: first.seq } : {}),
      hasMore,
      lastSeq,
      asOf: pass.asOf,
    };
  }

  // ------------------------------------------------------------------ pieces

  /** One risk, as `risks.update` answers with it. Shared with the control model. */
  async riskViewOf(planId: string, risk: Risk): Promise<RiskView> {
    const plan = await this.svc.requirePlan(planId);
    const items = await this.orc.stores.workItems.list((w) => w.planId === planId);
    return riskView(risk, plan, new Map(items.map((i) => [i.id, i])));
  }

  /** One decision, with what it gates. Shared with the control model. */
  async decisionViewOf(planId: string, decision: Decision): Promise<DecisionView> {
    const snap = await this.svc.snapshot(planId);
    return decisionView(decision, snap.dependencies, new Map(snap.items.map((i) => [i.id, i])));
  }

  /** One dependency, with the evaluation recomputed against the plan as it now stands. */
  async dependencyViewOf(planId: string, dependency: Dependency): Promise<DependencyView> {
    const pass = this.pass();
    const snap = await pass.snapshot(planId);
    const schedule = await pass.schedule(planId);
    return dependencyView(
      dependency,
      schedule,
      new Map(snap.items.map((i) => [i.id, i])),
      new Map(snap.decisions.map((d) => [d.id, d])),
    );
  }

  private async planView(planId: string, pass: PlanPass): Promise<PlanView> {
    const plan = await this.svc.requirePlan(planId);
    const snap = await pass.snapshot(plan.id);
    const schedule = await pass.schedule(plan.id);
    const counts = ZERO_COUNTS();
    for (const c of classify(schedule, snap.items).values()) counts[c] += 1;
    return {
      id: plan.id,
      key: plan.key,
      title: plan.name,
      description: plan.description,
      status: plan.status,
      requestIds: [...plan.requestIds],
      counts,
      riskMatrix: plan.riskMatrix,
      policy: {
        strategy: plan.policy.strategy,
        concurrency: plan.policy.concurrency,
        riskAppetite: plan.policy.riskAppetite,
      },
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }

  private itemView(
    item: WorkItem,
    classification: ItemClassification,
    schedule: Schedule,
    plan: Plan,
    risks: readonly Risk[],
    claims: ReadonlyMap<string, string>,
  ): PlanItemView {
    const priority = schedule.priorities[item.id];
    const claimedBy = claims.get(item.id);
    return {
      id: item.id,
      slug: item.slug,
      title: item.title,
      status: item.status,
      requestId: item.requestId,
      kind: item.kind,
      priorityBand: item.priority,
      classification,
      risk: exposureView(item.id, schedule, plan, risks),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...(priority ? { priority: { score: priority.score, reasons: [...priority.reasons] } } : {}),
      ...(claimedBy ? { claim: { runId: claimedBy } } : {}),
      ...(item.runId ? { runId: item.runId } : {}),
      ...(item.deferredReason ? { deferredReason: item.deferredReason } : {}),
    };
  }
}

/** The refusal a daemon with no plan service gives, if an embedder built its own table. */
export function noPlanService(): never {
  throw new OrcaError("NOT_SUPPORTED", "this daemon serves no plan: it answers the run methods only");
}
