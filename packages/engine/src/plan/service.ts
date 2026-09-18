/**
 * PlanService - the API over the long-term plan.
 *
 * It owns every mutation of plans, work items (plan-side fields), dependencies,
 * risks and decisions, writes each to the plan journal, and answers the two
 * questions the orchestrator asks: "what may run now, and why?" (`schedule`)
 * and "what did this artifact change?" (`onArtifactRecorded`).
 *
 * The orchestrator calls the `on*` hooks synchronously while it records
 * artifacts and finishes runs, so a node that runs *after* an agent step always
 * sees the plan updated with that step's signals. Nothing here talks to agents.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  compactSchedule,
  computeSchedule,
  DecompositionItemSchema,
  DEPENDENCY_START_PHASE,
  DecisionInputSchema,
  defaultSignalExtractor,
  evaluateDecisionMatrix,
  evaluateDependency,
  explainWorkItem,
  extractPlanSignals,
  keyedId,
  newId,
  OrcaError,
  parseDependencyRef,
  PlanSchema,
  RiskMatrixConfigSchema,
  SchedulingPolicySchema,
  silentLogger,
  systemClock,
  type Artifact,
  type Clock,
  type CompactSchedule,
  type Decision,
  type DecisionInputLike,
  type DecisionMatrixResult,
  type DecompositionItemInput,
  type Dependency,
  type DependencyRef,
  type DependencyTarget,
  type Logger,
  type ParsedDependencyRef,
  type Plan,
  type PlanEventInput,
  type PlanOrigin,
  RiskInputSchema,
  type Risk,
  type RiskInputLike,
  type RiskMatrixConfig,
  type Run,
  type Schedule,
  type SchedulingPolicy,
  type SignalExtractor,
  type WorkItem,
} from "@orca/core";
import type { Stores } from "@orca/store";
import { projectWorkItemForRun, type ProjectedWorkItem } from "../program/work-items.js";

export interface PlanDefaults {
  /** Plan used when a request does not name one. */
  planKey: string;
  planName: string;
  policy: Partial<SchedulingPolicy>;
  riskMatrix: Partial<RiskMatrixConfig>;
}

export interface PlanServiceOptions {
  stores: Stores;
  clock?: Clock;
  logger?: Logger;
  defaults?: Partial<PlanDefaults>;
  /** Additional front-matter extractors (plugins). The default extractor always runs. */
  signalExtractors?: SignalExtractor[];
}

export interface PlanSnapshot {
  plan: Plan;
  items: WorkItem[];
  dependencies: Dependency[];
  risks: Risk[];
  decisions: Decision[];
}

export interface RegisterInput {
  requestId: string;
  /** Decomposition items as agents write them (defaults are filled in). */
  items: DecompositionItemInput[];
  risks?: RiskInputLike[];
  decisions?: DecisionInputLike[];
}

export interface RegisterResult {
  items: WorkItem[];
  dependencies: Dependency[];
  risks: Risk[];
  decisions: Decision[];
  warnings: string[];
}

export interface ScheduleOptions {
  policy?: Partial<SchedulingPolicy>;
  inScope?: (item: WorkItem) => boolean;
  running?: readonly string[];
  /** Append a `schedule.computed` journal entry. */
  record?: boolean;
  runId?: string;
  origin?: PlanOrigin;
}

/** What a downstream item's agents are told about an upstream item. */
export interface UpstreamContext {
  slug: string;
  title: string;
  status: WorkItem["status"];
  type: Dependency["type"];
  stage?: string;
  requiredBy: string;
  artifacts: Record<string, { id: string; path?: string; data: Record<string, unknown> }>;
}

const SYSTEM: PlanOrigin = { kind: "system" };

/** The plan locks the current async context already owns (see `PlanService.withPlan`). */
const ownedLocks = new AsyncLocalStorage<ReadonlySet<string>>();

export class PlanService {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly defaults: PlanDefaults;
  private readonly stores: Stores;
  private readonly extractors: SignalExtractor[];
  /** Tail of the mutation chain per plan; see `withPlan`. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(opts: PlanServiceOptions) {
    this.stores = opts.stores;
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? silentLogger;
    this.defaults = { planKey: "default", planName: "Default plan", policy: {}, riskMatrix: {}, ...(opts.defaults ?? {}) };
    this.extractors = opts.signalExtractors ?? [];
  }

  addSignalExtractor(extractor: SignalExtractor): void {
    this.extractors.push(extractor);
  }

  /**
   * Serialise every mutation of one plan onto a promise chain, the way the
   * journal already serialises appends.
   *
   * Sibling child runs record artifacts concurrently and each mutation here is
   * list-then-put: without this, two runs whose specs declare the same risk key
   * both find nothing and both create a record, and two `reconcile` passes
   * journal `dependency.resolved` twice for one dependency.
   *
   * Reentrant: a locked method called from inside another one for the same plan
   * runs straight through, because the chain already owns the lock. Ownership
   * is tracked per async context, so concurrent chains never mistake another
   * chain's lock for their own.
   */
  private withPlan<T>(planId: string, fn: () => Promise<T>): Promise<T> {
    const owned = ownedLocks.getStore();
    if (owned?.has(planId)) return fn();
    const next = new Set(owned ?? []).add(planId);
    const result = (this.locks.get(planId) ?? Promise.resolve()).then(() => ownedLocks.run(next, fn));
    // The chain must survive a rejected link, or one failed mutation would wedge the plan.
    this.locks.set(
      planId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  // ------------------------------------------------------------------ plans

  async ensurePlan(input: { key?: string; name?: string; description?: string; policy?: Partial<SchedulingPolicy>; riskMatrix?: Partial<RiskMatrixConfig>; requestId?: string } = {}, origin: PlanOrigin = SYSTEM): Promise<Plan> {
    const key = input.key ?? this.defaults.planKey;
    // Locked on the key, not the id: the id does not exist yet, and two callers
    // racing to create the same plan is exactly what has to be serialised.
    return this.withPlan(`key:${key}`, () => this.ensurePlanLocked(key, input, origin));
  }

  private async ensurePlanLocked(key: string, input: { name?: string; description?: string; policy?: Partial<SchedulingPolicy>; riskMatrix?: Partial<RiskMatrixConfig>; requestId?: string }, origin: PlanOrigin): Promise<Plan> {
    let plan = await this.getPlan(key);
    if (!plan) {
      const now = this.clock.isoNow();
      plan = PlanSchema.parse({
        id: newId("plan", this.clock.now()),
        key,
        name: input.name ?? (key === this.defaults.planKey ? this.defaults.planName : key),
        description: input.description ?? "",
        policy: SchedulingPolicySchema.parse({ ...this.defaults.policy, ...(input.policy ?? {}) }),
        riskMatrix: RiskMatrixConfigSchema.parse({ ...this.defaults.riskMatrix, ...(input.riskMatrix ?? {}) }),
        createdAt: now,
        updatedAt: now,
      });
      await this.stores.plan.plans.put(plan);
      await this.journal({ type: "plan.created", planId: plan.id, origin, payload: { plan } });
    }
    if (input.requestId) plan = await this.linkRequest(plan.id, input.requestId, origin);
    return plan;
  }

  async getPlan(idOrKey: string): Promise<Plan | undefined> {
    return (await this.stores.plan.plans.get(idOrKey)) ?? (await this.stores.plan.plans.list((p) => p.key === idOrKey))[0];
  }

  async requirePlan(idOrKey: string): Promise<Plan> {
    const p = await this.getPlan(idOrKey);
    if (!p) throw new OrcaError("PLAN_NOT_FOUND", `plan '${idOrKey}' not found`);
    return p;
  }

  listPlans(): Promise<Plan[]> {
    return this.stores.plan.plans.list();
  }

  async updatePlan(planId: string, changes: Partial<Pick<Plan, "name" | "description" | "status" | "policy" | "riskMatrix" | "meta">>, origin: PlanOrigin = SYSTEM): Promise<Plan> {
    return this.withPlan(planId, () => this.updatePlanLocked(planId, changes, origin));
  }

  private async updatePlanLocked(planId: string, changes: Partial<Pick<Plan, "name" | "description" | "status" | "policy" | "riskMatrix" | "meta">>, origin: PlanOrigin): Promise<Plan> {
    const plan = await this.requirePlan(planId);
    const next = PlanSchema.parse({ ...plan, ...changes, updatedAt: this.clock.isoNow() });
    await this.stores.plan.plans.put(next);
    await this.journal({ type: "plan.updated", planId: plan.id, origin, payload: { changes } });
    return next;
  }

  async linkRequest(planId: string, requestId: string, origin: PlanOrigin = SYSTEM): Promise<Plan> {
    return this.withPlan(planId, () => this.linkRequestLocked(planId, requestId, origin));
  }

  private async linkRequestLocked(planId: string, requestId: string, origin: PlanOrigin): Promise<Plan> {
    const plan = await this.requirePlan(planId);
    if (plan.requestIds.includes(requestId)) return plan;
    const next = { ...plan, requestIds: [...plan.requestIds, requestId], updatedAt: this.clock.isoNow() };
    await this.stores.plan.plans.put(next);
    await this.journal({ type: "request.linked", planId: plan.id, origin, payload: { requestId } });
    return next;
  }

  /** The plan a run belongs to: through its work item, else through its request. */
  async planForRun(run: Pick<Run, "workItemId" | "requestId">): Promise<Plan | undefined> {
    if (run.workItemId) {
      const wi = await this.stores.workItems.get(run.workItemId);
      if (wi?.planId) return this.stores.plan.plans.get(wi.planId);
    }
    if (run.requestId) {
      const requestId = run.requestId;
      return (await this.stores.plan.plans.list((p) => p.requestIds.includes(requestId)))[0];
    }
    return undefined;
  }

  async snapshot(planId: string): Promise<PlanSnapshot> {
    const plan = await this.requirePlan(planId);
    const [items, dependencies, risks, decisions] = await Promise.all([
      this.stores.workItems.list((w) => w.planId === plan.id),
      this.stores.plan.dependencies.list((d) => d.planId === plan.id),
      this.stores.plan.risks.list((r) => r.planId === plan.id),
      this.stores.plan.decisions.list((d) => d.planId === plan.id),
    ]);
    // Stable sort: ties keep insertion order, so registration order is preserved.
    const byCreated = <T extends { createdAt: string }>(a: T, b: T) => a.createdAt.localeCompare(b.createdAt);
    return { plan, items: items.sort(byCreated), dependencies: dependencies.sort(byCreated), risks: risks.sort(byCreated), decisions: decisions.sort(byCreated) };
  }

  journalOf(planId: string) {
    return this.stores.plan.journal.read(planId);
  }

  // ------------------------------------------------------------- work items

  async findItem(planId: string, slugOrId: string): Promise<WorkItem | undefined> {
    const byId = await this.stores.workItems.get(slugOrId);
    if (byId && byId.planId === planId) return byId;
    return (await this.stores.workItems.list((w) => w.planId === planId && w.slug === slugOrId))[0];
  }

  async requireItem(planId: string, slugOrId: string): Promise<WorkItem> {
    const wi = await this.findItem(planId, slugOrId);
    if (!wi) throw new OrcaError("PLAN_INVALID", `work item '${slugOrId}' is not in plan ${planId}`);
    return wi;
  }

  /**
   * Register a decomposition in the plan: work items, their dependencies
   * (resolved across the whole plan, so a request may depend on another
   * request's items), and any risks / decisions the decomposition declares.
   * Slugs are unique per plan; a clash with an earlier request gets a suffix.
   */
  async registerWorkItems(planId: string, input: RegisterInput, origin: PlanOrigin): Promise<RegisterResult> {
    const plan = await this.requirePlan(planId);
    return this.withPlan(plan.id, () => this.registerWorkItemsLocked(plan, input, origin));
  }

  private async registerWorkItemsLocked(plan: Plan, input: RegisterInput, origin: PlanOrigin): Promise<RegisterResult> {
    const warnings: string[] = [];
    const existing = await this.stores.workItems.list((w) => w.planId === plan.id);
    const planBySlug = new Map(existing.map((w) => [w.slug, w]));
    const now = this.clock.isoNow();

    // 1. Items.
    const parsedItems = input.items.map((raw) => DecompositionItemSchema.parse(raw));
    const batch = new Map<string, WorkItem>(); // original slug -> item
    const created: WorkItem[] = [];
    for (const item of parsedItems) {
      let slug = item.slug;
      for (let n = 2; planBySlug.has(slug) || created.some((c) => c.slug === slug); n++) slug = `${item.slug}-${n}`;
      if (slug !== item.slug) warnings.push(`slug '${item.slug}' already exists in plan '${plan.key}'; registered as '${slug}'`);
      const wi: WorkItem = {
        id: newId("wi", this.clock.now()),
        requestId: input.requestId,
        planId: plan.id,
        slug,
        title: item.title,
        description: item.description,
        kind: item.kind,
        acceptanceCriteria: item.acceptanceCriteria,
        dependsOn: item.dependsOn,
        priority: item.priority,
        produced: {},
        status: "pending",
        createdAt: now,
        updatedAt: now,
        ...(item.workflow ? { workflowId: item.workflow } : {}),
        ...(item.repo ? { repo: item.repo } : {}),
        ...(item.estimate ? { estimate: item.estimate } : {}),
      };
      batch.set(item.slug, wi);
      created.push(wi);
    }
    for (const item of parsedItems) {
      if (item.parent) {
        const parent = batch.get(item.parent) ?? planBySlug.get(item.parent);
        if (parent) batch.get(item.slug)!.parentId = parent.id;
        else warnings.push(`work item '${item.slug}' names unknown parent '${item.parent}'`);
      }
    }
    for (const wi of created) {
      await this.stores.workItems.put(wi);
      await this.journal({ type: "work-item.added", planId: plan.id, origin, payload: { workItem: wi } });
    }
    const resolveSlug = (slug: string): WorkItem | undefined => batch.get(slug) ?? planBySlug.get(slug) ?? created.find((c) => c.slug === slug);

    // 2. Risks declared by the decomposition (+ per-item `risks` keys).
    const risks: Risk[] = [];
    const itemRiskKeys = new Map<string, string[]>();
    for (const item of parsedItems) for (const key of item.risks) itemRiskKeys.set(key, [...(itemRiskKeys.get(key) ?? []), batch.get(item.slug)!.id]);
    for (const r of input.risks ?? []) risks.push(await this.upsertRisk(plan.id, r, origin, { resolveSlug, extraAffects: itemRiskKeys.get(r.key) ?? [] }));
    for (const [key, ids] of itemRiskKeys) {
      if (risks.some((r) => r.key === key)) continue;
      const known = (await this.stores.plan.risks.list((r) => r.planId === plan.id && r.key === key))[0];
      if (known) risks.push(await this.upsertRisk(plan.id, { key, title: known.title }, origin, { resolveSlug, extraAffects: ids }));
      else warnings.push(`work item(s) reference unknown risk '${key}'`);
    }

    // 3. Decisions declared by the decomposition; `blocks` become decision dependencies.
    const decisions: Decision[] = [];
    for (const d of input.decisions ?? []) decisions.push(await this.upsertDecision(plan.id, d, origin));
    const dependencies: Dependency[] = [];
    for (const d of input.decisions ?? []) {
      const dec = decisions.find((x) => x.key === d.key)!;
      for (const slug of d.blocks ?? []) {
        const item = resolveSlug(slug);
        if (!item) {
          warnings.push(`decision '${d.key}' blocks unknown work item '${slug}'`);
          continue;
        }
        const dep = await this.addDependencyRecord(plan.id, item.id, { kind: "decision", decisionId: dec.id }, { type: "blocks", requiredBy: DEPENDENCY_START_PHASE, rationale: `decision ${d.key} must be made first` }, origin);
        if (dep) dependencies.push(dep);
      }
    }

    // 4. Dependencies from `dependsOn`, resolved batch-first, then plan-wide.
    for (const item of parsedItems) {
      const from = batch.get(item.slug)!;
      for (const ref of item.dependsOn) {
        let parsed: ParsedDependencyRef;
        try {
          parsed = parseDependencyRef(ref);
        } catch (e) {
          warnings.push(`work item '${item.slug}': ${(e as Error).message}`);
          continue;
        }
        const dep = await this.addDependencyFromRef(plan.id, from, parsed, origin, resolveSlug, warnings);
        if (dep) dependencies.push(dep);
      }
    }

    // 5. Bind earlier `external` placeholders whose key matches a newly registered slug.
    const placeholders = await this.stores.plan.dependencies.list((d) => d.planId === plan.id && d.target.kind === "external" && d.status === "open");
    for (const ph of placeholders) {
      const target = ph.target;
      if (target.kind !== "external") continue;
      const bound = created.find((c) => c.slug === target.key) ?? batch.get(target.key);
      if (!bound || bound.id === ph.from) continue;
      const next: Dependency = { ...ph, target: { kind: "work-item", workItemId: bound.id, ...(target.description?.startsWith("stage:") ? { stage: target.description.slice(6) } : {}) }, updatedAt: now };
      await this.stores.plan.dependencies.put(next);
      await this.journal({ type: "dependency.bound", planId: plan.id, origin, payload: { dependencyId: ph.id, workItemId: bound.id } });
    }

    await this.linkRequest(plan.id, input.requestId, origin);
    await this.reconcile(plan.id, origin);
    return { items: created, dependencies, risks, decisions, warnings };
  }

  async updateWorkItem(workItemId: string, changes: Partial<Omit<WorkItem, "deferredReason">> & { deferredReason?: string | null }, origin: PlanOrigin = SYSTEM): Promise<WorkItem> {
    const cur = await this.stores.workItems.get(workItemId);
    if (!cur) throw new OrcaError("PLAN_INVALID", `work item ${workItemId} not found`);
    const apply = () => this.updateWorkItemLocked(workItemId, changes, origin);
    return cur.planId ? this.withPlan(cur.planId, apply) : apply();
  }

  private async updateWorkItemLocked(workItemId: string, changes: Partial<Omit<WorkItem, "deferredReason">> & { deferredReason?: string | null }, origin: PlanOrigin): Promise<WorkItem> {
    const cur = await this.stores.workItems.get(workItemId);
    if (!cur) throw new OrcaError("PLAN_INVALID", `work item ${workItemId} not found`);
    const { deferredReason, ...rest } = changes;
    const next: WorkItem = { ...cur, ...rest, updatedAt: this.clock.isoNow(), ...(typeof deferredReason === "string" ? { deferredReason } : {}) };
    if (deferredReason === null) delete next.deferredReason;
    await this.stores.workItems.put(next);
    if (cur.planId) await this.journal({ type: "work-item.updated", planId: cur.planId, origin, payload: { workItemId, changes: changes as Record<string, unknown> } });
    return next;
  }

  /**
   * Record that the scheduler cannot offer an item right now: the reason goes on the document
   * *and* into the journal, in one place, so a dispatch summary can never describe a deferral
   * the journal does not hold. Idempotent.
   *
   * `blocked` is the one status the plan side owns - an item the scheduler refuses to start
   * never gets a run branch, so the run-log projection has nothing to say about it. The guard
   * makes that explicit: a status the projection wrote is never overwritten here.
   */
  async deferWorkItem(workItemId: string, reason: string, opts: { blocked?: boolean } = {}, origin: PlanOrigin = SYSTEM): Promise<void> {
    const cur = await this.stores.workItems.get(workItemId);
    if (!cur?.planId) return;
    const block = opts.blocked === true && (cur.status === "pending" || cur.status === "blocked");
    if (cur.deferredReason === reason && (!block || cur.status === "blocked")) return;
    await this.updateWorkItem(workItemId, { deferredReason: reason, ...(block ? { status: "blocked" as const } : {}) }, origin);
    await this.journal({ type: "dispatch.deferred", planId: cur.planId, origin, payload: { workItemId, reason } });
  }

  /** The item is being offered again: drop the reason an earlier deferral left on it. */
  async clearDeferral(workItemId: string, origin: PlanOrigin = SYSTEM): Promise<void> {
    const cur = await this.stores.workItems.get(workItemId);
    if (!cur || cur.deferredReason === undefined) return;
    await this.updateWorkItem(workItemId, { deferredReason: null }, origin);
  }

  /** Remember that the item produced an artifact kind (drives stage-level dependencies), then reconcile. */
  async recordProduced(workItemId: string, artifact: Artifact, origin: PlanOrigin = SYSTEM): Promise<void> {
    const item = await this.stores.workItems.get(workItemId);
    if (!item?.planId) return;
    return this.withPlan(item.planId, () => this.recordProducedLocked(workItemId, artifact, origin));
  }

  private async recordProducedLocked(workItemId: string, artifact: Artifact, origin: PlanOrigin): Promise<void> {
    const cur = await this.stores.workItems.get(workItemId);
    if (!cur?.planId) return;
    await this.updateWorkItem(workItemId, { produced: { ...cur.produced, [artifact.kind]: artifact.id, ...(artifact.name !== artifact.kind ? { [artifact.name]: artifact.id } : {}) } }, origin);
    await this.reconcile(cur.planId, origin);
  }

  // ----------------------------------------------------------- dependencies

  async addDependency(planId: string, fromSlugOrId: string, ref: DependencyRef, origin: PlanOrigin = SYSTEM): Promise<Dependency> {
    return this.withPlan(planId, () => this.addDependencyLocked(planId, fromSlugOrId, ref, origin));
  }

  private async addDependencyLocked(planId: string, fromSlugOrId: string, ref: DependencyRef, origin: PlanOrigin): Promise<Dependency> {
    const from = await this.requireItem(planId, fromSlugOrId);
    const warnings: string[] = [];
    const dep = await this.addDependencyFromRef(planId, from, parseDependencyRef(ref), origin, undefined, warnings);
    if (!dep) throw new OrcaError("PLAN_INVALID", warnings.join("; ") || "dependency already exists");
    if (warnings.length) this.logger.warn("dependency added with warnings", { warnings });
    await this.reconcile(planId, origin);
    return dep;
  }

  async resolveDependency(dependencyId: string, status: "satisfied" | "failed" | "waived" | "open", resolution: string | undefined, origin: PlanOrigin = SYSTEM): Promise<Dependency> {
    const dep = await this.stores.plan.dependencies.get(dependencyId);
    if (!dep) throw new OrcaError("PLAN_INVALID", `dependency ${dependencyId} not found`);
    return this.withPlan(dep.planId, () => this.resolveDependencyLocked(dependencyId, status, resolution, origin));
  }

  private async resolveDependencyLocked(dependencyId: string, status: "satisfied" | "failed" | "waived" | "open", resolution: string | undefined, origin: PlanOrigin): Promise<Dependency> {
    const cur = await this.stores.plan.dependencies.get(dependencyId);
    if (!cur) throw new OrcaError("PLAN_INVALID", `dependency ${dependencyId} not found`);
    const now = this.clock.isoNow();
    const next: Dependency = { ...cur, status, updatedAt: now, ...(status === "open" ? {} : { resolvedAt: now }), ...(resolution ? { resolution } : {}) };
    if (status === "open") {
      delete next.resolvedAt;
      delete next.resolution;
    }
    await this.stores.plan.dependencies.put(next);
    await this.journal({ type: "dependency.resolved", planId: cur.planId, origin, payload: { dependencyId, status, ...(resolution ? { resolution } : {}) } });
    return next;
  }

  /** Live evaluation of one item's dependencies (used by `custom:plan-await`). */
  async evaluateDependenciesOf(workItemId: string, phase?: string): Promise<{ dependency: Dependency; state: ReturnType<typeof evaluateDependency>["state"]; detail: string }[]> {
    const wi = await this.stores.workItems.get(workItemId);
    if (!wi?.planId) return [];
    const snap = await this.snapshot(wi.planId);
    const itemsById = new Map(snap.items.map((i) => [i.id, i]));
    const decisionsById = new Map(snap.decisions.map((d) => [d.id, d]));
    return snap.dependencies
      .filter((d) => d.from === workItemId && (phase === undefined || d.requiredBy === phase))
      .map((dependency) => ({ dependency, ...evaluateDependency(dependency, { itemsById, decisionsById }) }));
  }

  /**
   * Persist live dependency transitions (open -> satisfied / failed) so the
   * journal records *when* each dependency cleared. Idempotent.
   */
  async reconcile(planId: string, origin: PlanOrigin = SYSTEM): Promise<{ satisfied: string[]; failed: string[] }> {
    return this.withPlan(planId, () => this.reconcileLocked(planId, origin));
  }

  private async reconcileLocked(planId: string, origin: PlanOrigin): Promise<{ satisfied: string[]; failed: string[] }> {
    const snap = await this.snapshot(planId);
    const itemsById = new Map(snap.items.map((i) => [i.id, i]));
    const decisionsById = new Map(snap.decisions.map((d) => [d.id, d]));
    const out = { satisfied: [] as string[], failed: [] as string[] };
    for (const d of snap.dependencies) {
      if (d.status === "satisfied" || d.status === "waived") continue;
      const live = evaluateDependency(d, { itemsById, decisionsById });
      if (live.state === "satisfied" || (live.state === "failed" && d.status !== "failed")) {
        await this.resolveDependency(d.id, live.state, live.detail, origin);
        out[live.state].push(d.id);
      }
    }
    return out;
  }

  private async addDependencyFromRef(planId: string, from: WorkItem, ref: ParsedDependencyRef, origin: PlanOrigin, resolveSlug: ((slug: string) => WorkItem | undefined) | undefined, warnings: string[]): Promise<Dependency | undefined> {
    const meta = { type: ref.type, requiredBy: ref.requiredBy, ...(ref.rationale ? { rationale: ref.rationale } : {}) };
    let target: DependencyTarget;
    switch (ref.targetKind) {
      case "work-item": {
        const up = resolveSlug?.(ref.key) ?? (await this.findItem(planId, ref.key));
        if (!up) {
          warnings.push(`work item '${from.slug}' depends on '${ref.key}', which is not in the plan yet; recorded as an external dependency until it is registered`);
          target = { kind: "external", key: ref.key, ...(ref.stage ? { description: `stage:${ref.stage}` } : {}) };
        } else if (up.id === from.id) {
          warnings.push(`work item '${from.slug}' cannot depend on itself`);
          return undefined;
        } else target = { kind: "work-item", workItemId: up.id, ...(ref.stage ? { stage: ref.stage } : {}) };
        break;
      }
      case "decision": {
        let dec = (await this.stores.plan.decisions.list((d) => d.planId === planId && d.key === ref.key))[0];
        if (!dec) {
          dec = await this.upsertDecision(planId, { key: ref.key, title: ref.key, question: `Decision '${ref.key}' referenced by ${from.slug}` }, origin);
          warnings.push(`work item '${from.slug}' depends on decision '${ref.key}', which was opened as a placeholder`);
        }
        target = { kind: "decision", decisionId: dec.id };
        break;
      }
      case "external":
        target = { kind: "external", key: ref.key };
        break;
    }
    return this.addDependencyRecord(planId, from.id, target, meta, origin);
  }

  private async addDependencyRecord(planId: string, from: string, target: DependencyTarget, meta: { type: Dependency["type"]; requiredBy: string; rationale?: string }, origin: PlanOrigin): Promise<Dependency | undefined> {
    const dup = await this.stores.plan.dependencies.list((d) => d.planId === planId && d.from === from && d.type === meta.type && d.requiredBy === meta.requiredBy && JSON.stringify(d.target) === JSON.stringify(target));
    if (dup.length) return undefined;
    const now = this.clock.isoNow();
    const dep: Dependency = { id: keyedId("dep", planId, from, meta.type, meta.requiredBy, JSON.stringify(target)), planId, from, target, type: meta.type, requiredBy: meta.requiredBy, status: "open", origin, createdAt: now, updatedAt: now, ...(meta.rationale ? { rationale: meta.rationale } : {}) };
    await this.stores.plan.dependencies.put(dep);
    await this.journal({ type: "dependency.added", planId, origin, payload: { dependency: dep } });
    return dep;
  }

  // ------------------------------------------------------------------ risks

  /** Create or update a risk by key. Slugs in `affects` / `mitigatedBy` are resolved to work item ids. */
  async upsertRisk(planId: string, raw: RiskInputLike, origin: PlanOrigin, opts: { resolveSlug?: (slug: string) => WorkItem | undefined; extraAffects?: string[] } = {}): Promise<Risk> {
    return this.withPlan(planId, () => this.upsertRiskLocked(planId, raw, origin, opts));
  }

  private async upsertRiskLocked(planId: string, raw: RiskInputLike, origin: PlanOrigin, opts: { resolveSlug?: (slug: string) => WorkItem | undefined; extraAffects?: string[] }): Promise<Risk> {
    const input = RiskInputSchema.parse(raw);
    const toIds = async (slugs: string[]) => {
      const ids: string[] = [];
      for (const s of slugs) {
        const wi = opts.resolveSlug?.(s) ?? (await this.findItem(planId, s));
        if (wi) ids.push(wi.id);
        else this.logger.warn("risk references unknown work item", { risk: input.key, slug: s });
      }
      return ids;
    };
    const affects = [...new Set([...(await toIds(input.affects)), ...(opts.extraAffects ?? [])])];
    const mitigatedBy = await toIds(input.mitigatedBy);
    const now = this.clock.isoNow();
    const cur = (await this.stores.plan.risks.list((r) => r.planId === planId && r.key === input.key))[0];
    if (!cur) {
      const risk: Risk = {
        // Keyed, not random: a concurrent creator of the same risk writes the
        // same record instead of a duplicate, even from outside the plan lock.
        id: keyedId("risk", planId, input.key),
        planId,
        key: input.key,
        title: input.title,
        description: input.description,
        category: input.category,
        likelihood: input.likelihood,
        impact: input.impact,
        status: input.status ?? "open",
        triggers: input.triggers,
        affects,
        mitigatedBy,
        origin,
        createdAt: now,
        updatedAt: now,
        ...(input.mitigation ? { mitigation: input.mitigation } : {}),
        ...(input.contingency ? { contingency: input.contingency } : {}),
        ...(input.owner ? { owner: input.owner } : {}),
      };
      await this.stores.plan.risks.put(risk);
      await this.journal({ type: "risk.raised", planId, origin, payload: { risk } });
      return risk;
    }
    const changes: Partial<Risk> = {};
    if (input.title !== cur.title && input.title !== input.key) changes.title = input.title;
    if (input.description && input.description !== cur.description) changes.description = input.description;
    if (raw.likelihood !== undefined && input.likelihood !== cur.likelihood) changes.likelihood = input.likelihood;
    if (raw.impact !== undefined && input.impact !== cur.impact) changes.impact = input.impact;
    if (input.mitigation && input.mitigation !== cur.mitigation) changes.mitigation = input.mitigation;
    if (input.contingency && input.contingency !== cur.contingency) changes.contingency = input.contingency;
    if (input.owner && input.owner !== cur.owner) changes.owner = input.owner;
    if (input.status && input.status !== cur.status) changes.status = input.status;
    const mergedAffects = [...new Set([...cur.affects, ...affects])];
    if (mergedAffects.length !== cur.affects.length) changes.affects = mergedAffects;
    const mergedMit = [...new Set([...cur.mitigatedBy, ...mitigatedBy])];
    if (mergedMit.length !== cur.mitigatedBy.length) changes.mitigatedBy = mergedMit;
    const mergedTriggers = [...new Set([...cur.triggers, ...input.triggers])];
    if (mergedTriggers.length !== cur.triggers.length) changes.triggers = mergedTriggers;
    if (Object.keys(changes).length === 0) return cur;
    return this.updateRisk(planId, cur.id, changes, origin);
  }

  async updateRisk(planId: string, keyOrId: string, changes: Partial<Risk>, origin: PlanOrigin = SYSTEM): Promise<Risk> {
    return this.withPlan(planId, () => this.updateRiskLocked(planId, keyOrId, changes, origin));
  }

  private async updateRiskLocked(planId: string, keyOrId: string, changes: Partial<Risk>, origin: PlanOrigin): Promise<Risk> {
    const cur = (await this.stores.plan.risks.get(keyOrId)) ?? (await this.stores.plan.risks.list((r) => r.planId === planId && r.key === keyOrId))[0];
    if (!cur || cur.planId !== planId) throw new OrcaError("PLAN_INVALID", `risk '${keyOrId}' not found in plan ${planId}`);
    const now = this.clock.isoNow();
    const closing = changes.status && ["mitigated", "accepted", "closed"].includes(changes.status) && !["mitigated", "accepted", "closed"].includes(cur.status);
    const next: Risk = { ...cur, ...changes, updatedAt: now, ...(closing ? { closedAt: now } : {}) };
    await this.stores.plan.risks.put(next);
    await this.journal({ type: "risk.updated", planId, origin, payload: { riskId: cur.id, changes: changes as Record<string, unknown> } });
    return next;
  }

  // -------------------------------------------------------------- decisions

  /** Create or update a decision by key. A valid `chosen` decides it immediately. */
  async upsertDecision(planId: string, input: DecisionInputLike, origin: PlanOrigin): Promise<Decision> {
    return this.withPlan(planId, () => this.upsertDecisionLocked(planId, input, origin));
  }

  private async upsertDecisionLocked(planId: string, input: DecisionInputLike, origin: PlanOrigin): Promise<Decision> {
    const parsed = DecisionInputSchema.parse(input);
    const now = this.clock.isoNow();
    let dec = (await this.stores.plan.decisions.list((d) => d.planId === planId && d.key === parsed.key))[0];
    if (!dec) {
      dec = {
        id: keyedId("dec", planId, parsed.key),
        planId,
        key: parsed.key,
        title: parsed.title,
        question: parsed.question,
        status: "open",
        criteria: parsed.criteria,
        options: parsed.options,
        scale: parsed.scale,
        consequences: parsed.consequences,
        origin,
        createdAt: now,
        updatedAt: now,
        ...(parsed.context ? { context: parsed.context } : {}),
        ...(parsed.dueBy ? { dueBy: parsed.dueBy } : {}),
      };
      await this.stores.plan.decisions.put(dec);
      await this.journal({ type: "decision.opened", planId, origin, payload: { decision: dec } });
    } else if (dec.status !== "decided") {
      const changes: Partial<Decision> = {};
      if (parsed.title !== dec.title && parsed.title !== parsed.key) changes.title = parsed.title;
      if (parsed.question && parsed.question !== dec.question) changes.question = parsed.question;
      if (parsed.context && parsed.context !== dec.context) changes.context = parsed.context;
      if (parsed.criteria.length) changes.criteria = parsed.criteria;
      if (parsed.options.length) changes.options = parsed.options;
      if (parsed.consequences.length) changes.consequences = parsed.consequences;
      if (parsed.scale !== dec.scale && input.scale !== undefined) changes.scale = parsed.scale;
      if (Object.keys(changes).length) {
        dec = { ...dec, ...changes, updatedAt: now };
        await this.stores.plan.decisions.put(dec);
        await this.journal({ type: "decision.updated", planId, origin, payload: { decisionId: dec.id, changes: changes as Record<string, unknown> } });
      }
    }
    // Slugs in `blocks` become dependencies when the caller registers items; here we only handle already-known items.
    for (const slug of parsed.blocks) {
      const item = await this.findItem(planId, slug);
      if (item) await this.addDependencyRecord(planId, item.id, { kind: "decision", decisionId: dec.id }, { type: "blocks", requiredBy: DEPENDENCY_START_PHASE, rationale: `decision ${dec.key} must be made first` }, origin);
    }
    if (parsed.chosen && dec.status !== "decided") {
      const decided = await this.evaluateDecision(planId, dec.id, { chosen: parsed.chosen, decidedBy: origin.kind === "human" ? "human" : "agent", ...(parsed.rationale ? { rationale: parsed.rationale } : {}) }, origin);
      return decided.decision;
    }
    return dec;
  }

  /**
   * Run the matrix (when criteria and options exist) and decide. An explicit
   * `chosen` wins when it names a known option; otherwise the top-ranked option
   * is chosen. Dependencies on the decision are reconciled afterwards.
   */
  async evaluateDecision(planId: string, keyOrId: string, opts: { chosen?: string; decidedBy?: Decision["decidedBy"]; rationale?: string } = {}, origin: PlanOrigin = SYSTEM): Promise<{ decision: Decision; result?: DecisionMatrixResult; choice: string }> {
    return this.withPlan(planId, () => this.evaluateDecisionLocked(planId, keyOrId, opts, origin));
  }

  private async evaluateDecisionLocked(planId: string, keyOrId: string, opts: { chosen?: string; decidedBy?: Decision["decidedBy"]; rationale?: string }, origin: PlanOrigin): Promise<{ decision: Decision; result?: DecisionMatrixResult; choice: string }> {
    const cur = (await this.stores.plan.decisions.get(keyOrId)) ?? (await this.stores.plan.decisions.list((d) => d.planId === planId && d.key === keyOrId))[0];
    if (!cur || cur.planId !== planId) throw new OrcaError("PLAN_INVALID", `decision '${keyOrId}' not found in plan ${planId}`);
    const now = this.clock.isoNow();
    let result: DecisionMatrixResult | undefined;
    if (cur.criteria.length && cur.options.length) result = evaluateDecisionMatrix({ criteria: cur.criteria, options: cur.options, scale: cur.scale }, now);
    const optionKeys = cur.options.map((o) => o.key);
    const explicit = opts.chosen && (optionKeys.length === 0 || optionKeys.includes(opts.chosen)) ? opts.chosen : undefined;
    const choice = explicit ?? result?.recommended;
    if (!choice) throw new OrcaError("PLAN_INVALID", `decision '${cur.key}' has no options to choose from${opts.chosen ? ` ('${opts.chosen}' is not one of ${optionKeys.join(", ")})` : ""}`);
    const decidedBy: Decision["decidedBy"] = explicit ? (opts.decidedBy ?? "agent") : "matrix";
    const decision: Decision = { ...cur, status: "decided", chosen: choice, decidedBy, updatedAt: now, decidedAt: now, ...(result ? { result } : {}), ...(opts.rationale ? { rationale: opts.rationale } : {}) };
    await this.stores.plan.decisions.put(decision);
    await this.journal({ type: "decision.resolved", planId, origin, payload: { decisionId: cur.id, chosen: choice, decidedBy, ...(opts.rationale ? { rationale: opts.rationale } : {}) } });
    await this.reconcile(planId, origin);
    return { decision, choice, ...(result ? { result } : {}) };
  }

  async reopenDecision(planId: string, keyOrId: string, origin: PlanOrigin = SYSTEM): Promise<Decision> {
    return this.withPlan(planId, () => this.reopenDecisionLocked(planId, keyOrId, origin));
  }

  private async reopenDecisionLocked(planId: string, keyOrId: string, origin: PlanOrigin): Promise<Decision> {
    const cur = (await this.stores.plan.decisions.get(keyOrId)) ?? (await this.stores.plan.decisions.list((d) => d.planId === planId && d.key === keyOrId))[0];
    if (!cur) throw new OrcaError("PLAN_INVALID", `decision '${keyOrId}' not found`);
    const next: Decision = { ...cur, status: "open", updatedAt: this.clock.isoNow() };
    delete next.chosen;
    delete next.decidedAt;
    delete next.decidedBy;
    await this.stores.plan.decisions.put(next);
    await this.journal({ type: "decision.updated", planId, origin, payload: { decisionId: cur.id, changes: { status: "open" } } });
    for (const d of await this.stores.plan.dependencies.list((d) => d.planId === planId && d.target.kind === "decision" && d.target.decisionId === cur.id && d.status === "satisfied")) await this.resolveDependency(d.id, "open", undefined, origin);
    return next;
  }

  // --------------------------------------------------------------- schedule

  async schedule(planId: string, opts: ScheduleOptions = {}): Promise<Schedule> {
    const snap = await this.snapshot(planId);
    const schedule = computeSchedule({ ...snap, now: this.clock.isoNow(), ...(opts.policy ? { policy: opts.policy } : {}), ...(opts.inScope ? { inScope: opts.inScope } : {}), ...(opts.running ? { running: opts.running } : {}) });
    if (opts.record) {
      await this.journal({
        type: "schedule.computed",
        planId,
        origin: opts.origin ?? SYSTEM,
        payload: {
          ...(opts.runId ? { runId: opts.runId } : {}),
          ready: schedule.ready.map((r) => r.workItemId),
          waiting: schedule.waiting.map((w) => w.workItemId),
          held: schedule.held.map((h) => h.workItemId),
          unschedulable: schedule.unschedulable.map((u) => u.workItemId),
          criticalPath: schedule.criticalPath.workItemIds,
        },
      });
    }
    return schedule;
  }

  async compactSchedule(planId: string, opts: ScheduleOptions = {}): Promise<CompactSchedule> {
    const [schedule, snap] = await Promise.all([this.schedule(planId, opts), this.snapshot(planId)]);
    return compactSchedule(schedule, snap.items);
  }

  async explain(planId: string, slugOrId: string): Promise<string[]> {
    const item = await this.requireItem(planId, slugOrId);
    const [schedule, snap] = await Promise.all([this.schedule(planId), this.snapshot(planId)]);
    const lines = explainWorkItem(schedule, snap.items, item.id);
    const deps = snap.dependencies.filter((d) => d.from === item.id);
    for (const d of deps) lines.push(`dependency (${d.type}${d.requiredBy !== DEPENDENCY_START_PHASE ? `, by ${d.requiredBy}` : ""}): ${schedule.dependencyStates[d.id]?.detail ?? d.status}`);
    for (const r of snap.risks.filter((r) => r.affects.includes(item.id))) lines.push(`risk ${r.key}: ${r.status} (L${r.likelihood} x I${r.impact})`);
    return lines;
  }

  /** Upstream items and their artifacts, for the dependent item's prompts (`vars.upstream`). */
  async upstreamContext(workItemId: string): Promise<UpstreamContext[]> {
    const wi = await this.stores.workItems.get(workItemId);
    if (!wi?.planId) return [];
    const deps = await this.stores.plan.dependencies.list((d) => d.planId === wi.planId && d.from === workItemId && d.target.kind === "work-item" && d.status !== "waived");
    const out: UpstreamContext[] = [];
    for (const d of deps) {
      if (d.target.kind !== "work-item") continue;
      const up = await this.stores.workItems.get(d.target.workItemId);
      if (!up) continue;
      const artifacts: UpstreamContext["artifacts"] = {};
      for (const [kind, id] of Object.entries(up.produced)) {
        const a = await this.stores.artifacts.get(id);
        if (a) artifacts[kind] = { id: a.id, data: a.data, ...(a.path ? { path: a.path } : {}) };
      }
      out.push({ slug: up.slug, title: up.title, status: up.status, type: d.type, requiredBy: d.requiredBy, artifacts, ...(d.target.stage ? { stage: d.target.stage } : {}) });
    }
    return out;
  }

  // -------------------------------------------------------- artifact intake

  /**
   * Apply the planning signals an artifact carries: risks (attached to the
   * producing work item unless they name others), decisions (decided when the
   * artifact says `chosen`), and dependencies discovered mid-flight.
   */
  async ingestArtifact(artifact: Artifact, ctx: { planId: string; workItemId?: string | undefined; runId?: string | undefined }): Promise<{ risks: Risk[]; decisions: Decision[]; dependencies: Dependency[]; issues: string[] }> {
    return this.withPlan(ctx.planId, () => this.ingestArtifactLocked(artifact, ctx));
  }

  private async ingestArtifactLocked(artifact: Artifact, ctx: { planId: string; workItemId?: string | undefined; runId?: string | undefined }): Promise<{ risks: Risk[]; decisions: Decision[]; dependencies: Dependency[]; issues: string[] }> {
    const signals = extractPlanSignals(artifact, [defaultSignalExtractor, ...this.extractors]);
    const origin: PlanOrigin = { kind: "artifact", artifactId: artifact.id, ...(ctx.runId ? { runId: ctx.runId } : {}) };
    const out = { risks: [] as Risk[], decisions: [] as Decision[], dependencies: [] as Dependency[], issues: [...signals.issues] };
    // Each signal is applied on its own: a rejected one (an unknown `chosen`,
    // say) is reported, not allowed to drop the signals behind it.
    for (const r of signals.risks) {
      const extraAffects = r.affects.length === 0 && ctx.workItemId ? [ctx.workItemId] : [];
      try {
        out.risks.push(await this.upsertRisk(ctx.planId, r, origin, { extraAffects }));
      } catch (e) {
        out.issues.push(`risk '${r.key}': ${(e as Error).message}`);
      }
    }
    for (const d of signals.decisions) {
      try {
        out.decisions.push(await this.upsertDecision(ctx.planId, d, origin));
      } catch (e) {
        out.issues.push(`decision '${d.key}': ${(e as Error).message}`);
      }
    }
    if (ctx.workItemId) {
      const from = await this.stores.workItems.get(ctx.workItemId);
      if (from?.planId === ctx.planId) {
        for (const ref of signals.dependencies) {
          try {
            const dep = await this.addDependencyFromRef(ctx.planId, from, parseDependencyRef(ref), origin, undefined, out.issues);
            if (dep) out.dependencies.push(dep);
          } catch (e) {
            out.issues.push((e as Error).message);
          }
        }
      }
    }
    if (out.risks.length || out.decisions.length || out.dependencies.length) await this.reconcile(ctx.planId, origin);
    if (out.issues.length) {
      this.logger.warn("plan signals with issues", { artifact: artifact.id, issues: out.issues });
      await this.journal({ type: "signals.rejected", planId: ctx.planId, origin, payload: { artifactId: artifact.id, ...(ctx.runId ? { runId: ctx.runId } : {}), issues: out.issues } });
    }
    return out;
  }

  // ----------------------------------------------------- orchestrator hooks

  /**
   * Called by the orchestrator right after `artifact.recorded`. Never throws;
   * returns the signals the plan refused, for the run to surface.
   *
   * The whole intake runs under the plan lock, so sibling child runs recording
   * artifacts at the same time take turns rather than interleaving their
   * list-then-put updates.
   */
  async onArtifactRecorded(run: Pick<Run, "id" | "workItemId" | "requestId">, artifact: Artifact): Promise<string[]> {
    try {
      const plan = await this.planForRun(run);
      if (!plan) return [];
      return await this.withPlan(plan.id, async () => {
        const origin: PlanOrigin = { kind: "artifact", artifactId: artifact.id, runId: run.id };
        if (run.workItemId) await this.recordProduced(run.workItemId, artifact, origin);
        const { issues } = await this.ingestArtifact(artifact, { planId: plan.id, workItemId: run.workItemId, runId: run.id });
        return issues;
      });
    } catch (e) {
      const message = (e as Error).message;
      this.logger.error("plan: artifact intake failed", { artifact: artifact.id, error: message });
      return [`plan intake failed: ${message}`];
    }
  }

  /**
   * Called by the orchestrator when a run reaches a terminal state. Never throws.
   *
   * The status itself is *not* written here. A run dispatched by a container step is
   * projected from its parent's log the moment the parent records `child.finished`
   * (`RunContext.syncWorkItems`); this only projects the item run that no parent is
   * driving, through the very same mapping, and then re-evaluates the plan.
   */
  async onRunFinished(run: Pick<Run, "id" | "workItemId" | "requestId" | "status" | "outcome" | "parentRunId">): Promise<void> {
    try {
      if (!run.workItemId) return;
      const planId = (await this.stores.workItems.get(run.workItemId))?.planId;
      if (!planId) return;
      await this.withPlan(planId, async () => {
        // Re-read under the lock: a sibling's intake may have moved the item on.
        const wi = await this.stores.workItems.get(run.workItemId!);
        if (!wi || wi.planId !== planId || (wi.runId && wi.runId !== run.id)) return;
        if (!run.parentRunId) await this.onWorkItemsProjected(await projectWorkItemForRun(this.stores, run, this.clock.isoNow()), run.id);
        await this.reconcile(planId, { kind: "system", runId: run.id });
      });
    } catch (e) {
      this.logger.error("plan: run completion intake failed", { run: run.id, error: (e as Error).message });
    }
  }

  /**
   * Called by `RunContext.syncWorkItems` after the run-log projection has mirrored a status
   * onto the WorkItem documents. The projection owns `status` / `runId`; the plan side only
   * records what it did, so the journal (`orca plan journal`) can never fall behind the read
   * model (`orca plan show`) - not even if the process dies mid-dispatch. Never throws.
   */
  async onWorkItemsProjected(changes: readonly ProjectedWorkItem[], runId?: string): Promise<void> {
    const origin: PlanOrigin = { kind: "system", ...(runId ? { runId } : {}) };
    try {
      const plans = new Set<string>();
      for (const c of changes) {
        const planId = c.workItem.planId;
        if (!planId) continue;
        plans.add(planId);
        await this.journal({ type: "work-item.updated", planId, origin, payload: { workItemId: c.workItem.id, changes: { ...c.changes, from: c.previous } } });
      }
      // A finished item can satisfy what its dependants were waiting for.
      for (const planId of plans) await this.reconcile(planId, origin);
    } catch (e) {
      this.logger.error("plan: work-item projection intake failed", { ...(runId ? { run: runId } : {}), error: (e as Error).message });
    }
  }

  // ---------------------------------------------------------------- journal

  private journal(input: PlanEventInput) {
    return this.stores.plan.journal.append(input);
  }
}
