/**
 * The scheduler: given a plan snapshot, decide which work items may be handed
 * to agents now, which are waiting (and on what), which are held for risk, and
 * which can never run - plus a priority order with human-readable reasons.
 *
 * Pure and deterministic. Dependencies are evaluated *live* against the
 * current work items and decisions, so the schedule never trusts a stale
 * `Dependency.status` (the PlanService persists status transitions afterwards).
 */
import {
  DEPENDENCY_START_PHASE,
  PRIORITY_RANK,
  PriorityWeightsSchema,
  RISK_LEVELS,
  SchedulingPolicySchema,
  estimateWeight,
  type Decision,
  type Dependency,
  type Plan,
  type PriorityWeights,
  type RiskLevel,
  type SchedulingPolicy,
  type SchedulingStrategy,
  type Risk,
} from "../model/plan.js";
import type { WorkItem } from "../model/request.js";
import {
  buildDependencyGraph,
  criticalPath,
  dropCycleClosingEdges,
  findCycles,
  longestDownstreamPaths,
  topologicalWaves,
  transitiveDownstream,
  type DependencyGraph,
  type GraphEdge,
  type PathInfo,
} from "./graph.js";
import {
  itemRiskExposure,
  levelRank,
  risksMitigatedBy,
  summarizeRisks,
  type RiskExposure,
  type RiskSummary,
} from "./risk.js";

export const STRATEGY_WEIGHTS: Record<SchedulingStrategy, PriorityWeights> = {
  "critical-path": PriorityWeightsSchema.parse({}),
  "risk-first": { criticalPath: 1, dependents: 1, risk: 3, mitigation: 3, priority: 1.5, age: 0.5 },
  "most-dependents": { criticalPath: 1, dependents: 3, risk: 1, mitigation: 1, priority: 1.5, age: 0.5 },
  fifo: { criticalPath: 0, dependents: 0, risk: 0, mitigation: 0, priority: 1, age: 3 },
};

export type DependencyState = "satisfied" | "waiting" | "failed" | "waived";

/**
 * Work item ids gated by a decision: the `from` side of every `blocks`
 * dependency targeting it in one of `statuses` (by default the ones that still
 * express an ordering - open or satisfied; waived and failed no longer gate).
 * This is the only source of truth; `Decision` carries no copy.
 */
export function decisionBlocks(
  decisionId: string,
  dependencies: readonly Dependency[],
  statuses: readonly Dependency["status"][] = ["open", "satisfied"],
): string[] {
  const out: string[] = [];
  for (const d of dependencies) {
    if (
      d.target.kind !== "decision" ||
      d.target.decisionId !== decisionId ||
      d.type !== "blocks" ||
      !statuses.includes(d.status)
    )
      continue;
    if (!out.includes(d.from)) out.push(d.from);
  }
  return out;
}

export interface DependencyEvaluation {
  state: DependencyState;
  /** One line a human can read: "waiting for auth-api to produce spec". */
  detail: string;
}

export interface EvaluationContext {
  itemsById: ReadonlyMap<string, WorkItem>;
  decisionsById: ReadonlyMap<string, Decision>;
}

const SETTLED: readonly WorkItem["status"][] = ["done", "failed", "cancelled"];
const TERMINAL_FAILURE: readonly WorkItem["status"][] = ["failed", "cancelled"];
/**
 * Share of an upstream estimate that elapses before a stage-level dependent (`other@spec`)
 * can start. Such edges exist to let work overlap, so the critical path charges them half
 * the upstream weight instead of all of it; a plain edge waits for the whole item.
 */
export const STAGE_EDGE_LAG = 0.5;
/**
 * Share of a dependent's own estimate that runs before a later required phase
 * (`other#build`). The dependent starts alongside the upstream item and only that phase
 * waits for it, so the critical path overlaps this much of the dependent with the upstream.
 * The schedule does not know where the phase sits in the dependent's workflow, so this is
 * a heuristic like `STAGE_EDGE_LAG`.
 */
export const LATER_PHASE_LEAD = 0.5;
/**
 * Share of an estimate the critical path still charges for an item that is already
 * underway (in progress, or dispatched per `ScheduleInput.running`). The schedule has no
 * per-item measure of elapsed work, so a started item counts as half done.
 */
export const IN_PROGRESS_REMAINING = 0.5;

export function evaluateDependency(d: Dependency, ctx: EvaluationContext): DependencyEvaluation {
  if (d.status === "waived") return { state: "waived", detail: `waived${d.resolution ? `: ${d.resolution}` : ""}` };
  if (d.status === "satisfied") return { state: "satisfied", detail: d.resolution ?? "satisfied" };
  const t = d.target;
  switch (t.kind) {
    case "work-item": {
      const up = ctx.itemsById.get(t.workItemId);
      if (!up) return { state: "failed", detail: `upstream work item ${t.workItemId} is not in the plan` };
      if (up.status === "done") return { state: "satisfied", detail: `${up.slug} is done` };
      if (t.stage && up.produced[t.stage]) return { state: "satisfied", detail: `${up.slug} produced ${t.stage}` };
      if (TERMINAL_FAILURE.includes(up.status) || up.status === "blocked")
        return { state: "failed", detail: `${up.slug} is ${up.status}` };
      return {
        state: "waiting",
        detail: t.stage
          ? `waiting for ${up.slug} to produce ${t.stage}`
          : `waiting for ${up.slug} to be done (currently ${up.status})`,
      };
    }
    case "decision": {
      const dec = ctx.decisionsById.get(t.decisionId);
      if (!dec) return { state: "failed", detail: `decision ${t.decisionId} is not in the plan` };
      if (dec.status === "decided") return { state: "satisfied", detail: `decision ${dec.key} = ${dec.chosen ?? "?"}` };
      if (dec.status === "superseded") return { state: "failed", detail: `decision ${dec.key} was superseded` };
      return {
        state: "waiting",
        detail: `waiting for decision ${dec.key}${dec.status === "deferred" ? " (deferred)" : ""}`,
      };
    }
    case "external":
      if (d.status === "failed")
        return { state: "failed", detail: d.resolution ?? `external dependency ${t.key} failed` };
      return {
        state: "waiting",
        detail: `waiting for external '${t.key}'${t.description ? ` (${t.description})` : ""}`,
      };
  }
}

export interface ItemPriority {
  score: number;
  factors: Record<string, number>;
  reasons: string[];
}

export interface ScheduledItem {
  workItemId: string;
  slug: string;
  priority: ItemPriority;
}
export interface WaitingItem {
  workItemId: string;
  slug: string;
  waitingOn: { dependencyId: string; detail: string; requiredBy: string }[];
}
export interface HeldItem {
  workItemId: string;
  slug: string;
  level: RiskLevel | "none";
  reason: string;
}
export interface UnschedulableItem {
  workItemId: string;
  slug: string;
  reason: string;
  dependencyIds: string[];
}

export interface Schedule {
  computedAt: string;
  strategy: SchedulingStrategy;
  policy: SchedulingPolicy;
  /** Dispatchable now, best first. */
  ready: ScheduledItem[];
  running: string[];
  waiting: WaitingItem[];
  held: HeldItem[];
  unschedulable: UnschedulableItem[];
  settled: { done: string[]; failed: string[]; cancelled: string[] };
  /** Topological layers over every unsettled item (plan view, not dispatch order). */
  waves: string[][];
  /** Heaviest remaining chain (settled items excluded); `length` is in estimate units. */
  criticalPath: { workItemIds: string[]; length: number };
  /** Cycles among `blocks` edges, each in edge order; every item in one is unschedulable. */
  cycles: string[][];
  /** `soft` edges left out of the ordering view because they pointed back into a cycle. */
  ignoredSoftDependencies: { dependencyId: string; from: string; to: string }[];
  risk: RiskSummary;
  exposure: Record<string, RiskExposure>;
  openDecisions: { decisionId: string; key: string; title: string; blocks: string[] }[];
  priorities: Record<string, ItemPriority>;
  dependencyStates: Record<string, DependencyEvaluation>;
}

export interface ScheduleInput {
  plan: Plan;
  items: readonly WorkItem[];
  dependencies: readonly Dependency[];
  risks: readonly Risk[];
  decisions: readonly Decision[];
  now: string;
  /** Per-call policy overrides (e.g. a node's `concurrency`). */
  policy?: Partial<SchedulingPolicy>;
  /** Limit *dispatch* candidates (ready/waiting/held) to these items; the graph still spans the whole plan. */
  inScope?: (item: WorkItem) => boolean;
  /** Items currently executing (in addition to those with status in-progress). */
  running?: readonly string[];
}

export function resolvePolicy(
  plan: Plan,
  overrides?: Partial<SchedulingPolicy>,
): { policy: SchedulingPolicy; weights: PriorityWeights } {
  const policy = SchedulingPolicySchema.parse({ ...plan.policy, ...(overrides ?? {}) });
  const weights: PriorityWeights = { ...STRATEGY_WEIGHTS[policy.strategy] };
  for (const [k, v] of Object.entries(policy.weights ?? {}))
    if (typeof v === "number") weights[k as keyof PriorityWeights] = v;
  return { policy, weights };
}

export function computeSchedule(input: ScheduleInput): Schedule {
  const { policy, weights } = resolvePolicy(input.plan, input.policy);
  const matrix = input.plan.riskMatrix;
  const items = [...input.items];
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const decisionsById = new Map(input.decisions.map((d) => [d.id, d]));
  const inScope = input.inScope ?? (() => true);
  const running = new Set<string>([
    ...items.filter((i) => i.status === "in-progress").map((i) => i.id),
    ...(input.running ?? []),
  ]);

  // The graph spans the *remaining* work: settled items are neither nodes nor edges, so an
  // edge to a done item simply disappears, waves show what is left and the critical path
  // length is the remaining estimate (an item already underway counts `IN_PROGRESS_REMAINING`
  // of its estimate).
  const candidates = items.filter((i) => !SETTLED.includes(i.status));
  const itemIds = candidates.map((i) => i.id);
  // Only `blocks` edges can make work impossible, so cycle detection runs on them alone:
  // a `soft` edge never blocks (see `DependencyType`), and a soft back-reference must not
  // strand the items it points at.
  const blockingGraph = buildDependencyGraph(itemIds, input.dependencies, { orderingTypes: ["blocks"] });
  const cycles = findCycles(blockingGraph);
  const cyclic = new Set(cycles.flat());
  // Ordering view for waves / critical path / dependent counts: `soft` edges join in when the
  // policy says so, minus the ones that would close a cycle (they are hints, so they yield).
  const { graph, dropped } = policy.orderSoftDependencies
    ? dropCycleClosingEdges(buildDependencyGraph(itemIds, input.dependencies, { orderingTypes: ["blocks", "soft"] }), [
        "soft",
      ])
    : { graph: blockingGraph, dropped: [] as GraphEdge[] };
  const ignoredSoftDependencies = dropped.map((e) => ({ dependencyId: e.dependencyId, from: e.from, to: e.to }));
  const paths = longestDownstreamPaths(
    graph,
    (id) => estimateWeight(itemsById.get(id)?.estimate) * (running.has(id) ? IN_PROGRESS_REMAINING : 1),
    (e) => {
      if (!e.stage) return 1;
      // Already produced: the dependent need not wait for any more of the upstream.
      return itemsById.get(e.to)?.produced[e.stage] ? 0 : STAGE_EDGE_LAG;
    },
    (e) => (e.requiredBy ? LATER_PHASE_LEAD : 0),
  );
  const cp = criticalPath(paths);
  const { waves } = topologicalWaves(graph);

  // Dependency evaluation, once.
  const dependencyStates: Record<string, DependencyEvaluation> = {};
  const depsByItem = new Map<string, Dependency[]>();
  for (const d of input.dependencies) {
    dependencyStates[d.id] = evaluateDependency(d, { itemsById, decisionsById });
    const list = depsByItem.get(d.from) ?? [];
    list.push(d);
    depsByItem.set(d.from, list);
  }

  // Risk.
  const exposure: Record<string, RiskExposure> = {};
  for (const i of items) exposure[i.id] = itemRiskExposure(i.id, input.risks, matrix);

  // Priorities for every unsettled item (so explanations exist for waiting items too).
  const priorities = computePriorities(
    candidates,
    graph,
    paths,
    cp,
    exposure,
    input.risks,
    matrix,
    weights,
    policy,
    input.now,
    itemsById,
  );

  const ready: ScheduledItem[] = [];
  const waiting: WaitingItem[] = [];
  const held: HeldItem[] = [];
  const unschedulable: UnschedulableItem[] = [];
  const settled = { done: [] as string[], failed: [] as string[], cancelled: [] as string[] };

  for (const item of items) {
    if (item.status === "done" || item.status === "failed" || item.status === "cancelled") {
      settled[item.status].push(item.id);
      continue;
    }
    if (running.has(item.id) || !inScope(item)) continue;
    if (cyclic.has(item.id)) {
      const cycle = cycles.find((c) => c.includes(item.id))!;
      // Members come in edge order; repeat the head so the ring reads as one.
      unschedulable.push({
        workItemId: item.id,
        slug: item.slug,
        reason: `dependency cycle: ${[...cycle, cycle[0]!].map((id) => itemsById.get(id)?.slug ?? id).join(" -> ")}`,
        dependencyIds: [],
      });
      continue;
    }
    const blocking = (depsByItem.get(item.id) ?? []).filter((d) => d.type === "blocks");
    const failedDeps = blocking.filter((d) => dependencyStates[d.id]!.state === "failed");
    if (failedDeps.length) {
      unschedulable.push({
        workItemId: item.id,
        slug: item.slug,
        reason: failedDeps.map((d) => dependencyStates[d.id]!.detail).join("; "),
        dependencyIds: failedDeps.map((d) => d.id),
      });
      continue;
    }
    const waitingDeps = blocking.filter(
      (d) => d.requiredBy === DEPENDENCY_START_PHASE && dependencyStates[d.id]!.state === "waiting",
    );
    // A later-phase dependency (`other#build`) lets the item start early, but only once the
    // upstream item is itself underway; otherwise the item would just occupy a slot waiting.
    const notStartedUpstream = blocking.filter(
      (d) =>
        d.requiredBy !== DEPENDENCY_START_PHASE &&
        dependencyStates[d.id]!.state === "waiting" &&
        d.target.kind === "work-item" &&
        !hasStarted(itemsById.get(d.target.workItemId), running),
    );
    if (waitingDeps.length || notStartedUpstream.length) {
      waiting.push({
        workItemId: item.id,
        slug: item.slug,
        waitingOn: [
          ...waitingDeps.map((d) => ({
            dependencyId: d.id,
            detail: dependencyStates[d.id]!.detail,
            requiredBy: d.requiredBy,
          })),
          ...notStartedUpstream.map((d) => ({
            dependencyId: d.id,
            detail: `waiting for ${itemsById.get((d.target as { workItemId: string }).workItemId)?.slug ?? "upstream"} to start (needed by ${d.requiredBy})`,
            requiredBy: d.requiredBy,
          })),
        ],
      });
      continue;
    }
    const exp = exposure[item.id]!;
    if (policy.holdAboveAppetite && exp.level !== "none" && levelRank(exp.level) > levelRank(policy.riskAppetite)) {
      held.push({
        workItemId: item.id,
        slug: item.slug,
        level: exp.level,
        reason: `open ${exp.level} risk${exp.risks.length > 1 ? "s" : ""} ${exp.risks.map((r) => r.key).join(", ")} exceed${exp.risks.length > 1 ? "" : "s"} the plan's appetite (${policy.riskAppetite}); accept or mitigate first`,
      });
      continue;
    }
    ready.push({ workItemId: item.id, slug: item.slug, priority: priorities[item.id]! });
  }
  ready.sort((a, b) => b.priority.score - a.priority.score || a.slug.localeCompare(b.slug));

  // `blocks` follows the live dependency states like everything else: an unsettled item whose
  // `blocks` dependency on the decision is still waiting (not a persisted `status`).
  const openDecisions = input.decisions
    .filter((d) => d.status === "open" || d.status === "deferred")
    .map((d) => ({
      decisionId: d.id,
      key: d.key,
      title: d.title,
      blocks: input.dependencies
        .filter(
          (x) =>
            x.target.kind === "decision" &&
            x.target.decisionId === d.id &&
            x.type === "blocks" &&
            dependencyStates[x.id]!.state === "waiting",
        )
        .map((x) => x.from)
        .filter((id) => itemsById.has(id) && !SETTLED.includes(itemsById.get(id)!.status)),
    }));

  return {
    computedAt: input.now,
    strategy: policy.strategy,
    policy,
    ready,
    running: [...running],
    waiting,
    held,
    unschedulable,
    settled,
    waves,
    criticalPath: { workItemIds: cp.path, length: cp.length },
    cycles,
    ignoredSoftDependencies,
    risk: summarizeRisks(input.risks, matrix),
    exposure,
    openDecisions,
    priorities,
    dependencyStates,
  };
}

function hasStarted(item: WorkItem | undefined, running: ReadonlySet<string>): boolean {
  if (!item) return false;
  return (
    item.status === "in-progress" ||
    item.status === "done" ||
    running.has(item.id) ||
    Object.keys(item.produced).length > 0
  );
}

function computePriorities(
  candidates: readonly WorkItem[],
  graph: DependencyGraph,
  paths: ReturnType<typeof longestDownstreamPaths>,
  cp: PathInfo,
  exposure: Record<string, RiskExposure>,
  risks: readonly Risk[],
  matrix: Plan["riskMatrix"],
  weights: PriorityWeights,
  policy: SchedulingPolicy,
  now: string,
  itemsById: ReadonlyMap<string, WorkItem>,
): Record<string, ItemPriority> {
  const nowMs = Date.parse(now) || 0;
  const onCriticalPath = new Set(cp.path);
  const raw = candidates.map((item) => {
    const dependents = transitiveDownstream(graph, item.id);
    const mitigates = policy.mitigateFirst ? risksMitigatedBy(item.id, risks, matrix) : [];
    return {
      item,
      dependents,
      mitigates,
      cp: paths.get(item.id)?.length ?? 0,
      risk: exposure[item.id]?.score ?? 0,
      // Level-weighted so that mitigating even a `low` risk counts for something (0.25 .. 1);
      // the "mitigates ..." reason below only appears when this factor is non-zero.
      mitigation: mitigates.length
        ? (Math.max(...mitigates.map((r) => levelRank(r.level))) + 1) / RISK_LEVELS.length
        : 0,
      priority: PRIORITY_RANK[item.priority] / 3,
      age: Math.max(0, nowMs - (Date.parse(item.createdAt) || nowMs)),
    };
  });
  const max = (f: (r: (typeof raw)[number]) => number) => Math.max(1e-9, ...raw.map(f));
  const maxCp = max((r) => r.cp);
  const maxDeps = max((r) => r.dependents.size);
  const maxRisk = max((r) => r.risk);
  const maxAge = max((r) => r.age);
  const out: Record<string, ItemPriority> = {};
  for (const r of raw) {
    const factors = {
      criticalPath: r.cp / maxCp,
      dependents: r.dependents.size / maxDeps,
      risk: r.risk / maxRisk,
      mitigation: r.mitigation,
      priority: r.priority,
      age: r.age / maxAge,
    };
    const score = Object.entries(factors).reduce((s, [k, v]) => s + v * weights[k as keyof PriorityWeights], 0);
    const reasons: string[] = [];
    if (r.dependents.size)
      reasons.push(
        `unblocks ${r.dependents.size} item${r.dependents.size > 1 ? "s" : ""} (${[...r.dependents].map((id) => itemsById.get(id)?.slug ?? id).join(", ")})`,
      );
    // Membership in `schedule.criticalPath` itself, so the reason, `explainWorkItem` and the
    // reported path never disagree (ties, or a chain that is not the heaviest from this item).
    if (onCriticalPath.has(r.item.id)) reasons.push(`on the critical path (length ${cp.length})`);
    const exp = exposure[r.item.id];
    if (exp && exp.level !== "none")
      reasons.push(`exposed to ${exp.level} risk: ${exp.risks.map((x) => x.key).join(", ")}`);
    if (r.mitigates.length) reasons.push(`mitigates ${r.mitigates.map((x) => `${x.key} (${x.level})`).join(", ")}`);
    if (r.item.priority !== "normal") reasons.push(`priority ${r.item.priority}`);
    out[r.item.id] = {
      score: Math.round(score * 1000) / 1000,
      factors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
      reasons,
    };
  }
  return out;
}

/** Human-readable lines about one item's place in the schedule (CLI `plan explain`, prompts). */
export function explainWorkItem(schedule: Schedule, items: readonly WorkItem[], workItemId: string): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const item = byId.get(workItemId);
  if (!item) return [`work item ${workItemId} is not in the plan`];
  const slug = (id: string) => byId.get(id)?.slug ?? id;
  const lines = [`${item.slug}: ${item.status}${item.priority !== "normal" ? ` (priority ${item.priority})` : ""}`];
  const ready = schedule.ready.findIndex((r) => r.workItemId === workItemId);
  if (ready >= 0)
    lines.push(
      `ready - position ${ready + 1} of ${schedule.ready.length} (score ${schedule.ready[ready]!.priority.score})`,
    );
  const waiting = schedule.waiting.find((w) => w.workItemId === workItemId);
  if (waiting) for (const w of waiting.waitingOn) lines.push(`waiting: ${w.detail}`);
  const held = schedule.held.find((h) => h.workItemId === workItemId);
  if (held) lines.push(`held: ${held.reason}`);
  const bad = schedule.unschedulable.find((u) => u.workItemId === workItemId);
  if (bad) lines.push(`cannot run: ${bad.reason}`);
  if (schedule.running.includes(workItemId)) lines.push("running");
  const p = schedule.priorities[workItemId];
  if (p) for (const r of p.reasons) lines.push(`why: ${r}`);
  if (schedule.criticalPath.workItemIds.includes(workItemId))
    lines.push(`critical path: ${schedule.criticalPath.workItemIds.map(slug).join(" -> ")}`);
  const wave = schedule.waves.findIndex((w) => w.includes(workItemId));
  if (wave >= 0) lines.push(`wave ${wave + 1} of ${schedule.waves.length}`);
  return lines;
}

/** Slug-based, JSON-friendly view for run vars, prompts, gates and the CLI. */
export interface CompactSchedule {
  computedAt: string;
  strategy: SchedulingStrategy;
  ready: { slug: string; score: number; reasons: string[] }[];
  running: string[];
  waiting: { slug: string; on: string[] }[];
  held: { slug: string; level: RiskLevel | "none"; reason: string }[];
  unschedulable: { slug: string; reason: string }[];
  done: string[];
  failed: string[];
  waves: string[][];
  criticalPath: string[];
  criticalPathLength: number;
  cycles: string[][];
  risk: {
    open: number;
    highestLevel: RiskLevel | "none";
    byLevel: Record<RiskLevel, number>;
    top: { key: string; level: RiskLevel; score: number }[];
  };
  openDecisions: { key: string; title: string; blocks: string[] }[];
}

export function compactSchedule(schedule: Schedule, items: readonly WorkItem[]): CompactSchedule {
  const byId = new Map(items.map((i) => [i.id, i]));
  const slug = (id: string) => byId.get(id)?.slug ?? id;
  return {
    computedAt: schedule.computedAt,
    strategy: schedule.strategy,
    ready: schedule.ready.map((r) => ({ slug: r.slug, score: r.priority.score, reasons: r.priority.reasons })),
    running: schedule.running.map(slug),
    waiting: schedule.waiting.map((w) => ({ slug: w.slug, on: w.waitingOn.map((x) => x.detail) })),
    held: schedule.held.map((h) => ({ slug: h.slug, level: h.level, reason: h.reason })),
    unschedulable: schedule.unschedulable.map((u) => ({ slug: u.slug, reason: u.reason })),
    done: schedule.settled.done.map(slug),
    failed: schedule.settled.failed.map(slug),
    waves: schedule.waves.map((w) => w.map(slug)),
    criticalPath: schedule.criticalPath.workItemIds.map(slug),
    criticalPathLength: schedule.criticalPath.length,
    cycles: schedule.cycles.map((c) => c.map(slug)),
    risk: {
      open: schedule.risk.open,
      highestLevel: schedule.risk.highestLevel,
      byLevel: schedule.risk.byLevel,
      top: schedule.risk.top.map((r) => ({ key: r.key, level: r.level, score: r.score })),
    },
    openDecisions: schedule.openDecisions.map((d) => ({ key: d.key, title: d.title, blocks: d.blocks.map(slug) })),
  };
}
