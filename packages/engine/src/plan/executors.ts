/**
 * Plan-aware node types. Together they supersede the request-scoped
 * `custom:materialize-work-items` + `parallel forEach` pair used by a plain
 * program workflow:
 *
 *  custom:plan-register   decomposition artifact -> work items, dependencies,
 *                         risks and decisions in the Plan (cross-request).
 *  custom:decision-matrix evaluate a `decision-matrix` artifact, decide, and
 *                         unblock the items waiting on that decision.
 *  custom:plan-schedule   compute the schedule, expose it as `vars.schedule`
 *                         and write a `schedule` artifact for the gate.
 *  custom:plan-dispatch   run the item workflow for whatever the scheduler says
 *                         is ready, re-scheduling after every completion.
 *  custom:plan-await      inside an item workflow: wait until the item's
 *                         dependencies for a phase (e.g. `build`) are satisfied.
 */
import { DecisionMatrixArtifactSchema, DecompositionSchema, decisionBlocks, evaluateDecisionMatrix, isOpenRisk, planToMermaid, renderDecisionMatrix, riskLevel, riskScore, serializeFrontMatter, succeeded, type CompactSchedule, type CustomNode, type Decision, type DecisionMatrixResult, type Dependency, type PlanOrigin, type RunState, type Schedule, type SchedulingPolicy, type WorkItem } from "@orca/core";
import { ownsClaim } from "@orca/store";
import type { PlanSnapshot } from "./service.js";
import { pausedByChildren } from "../executors/containers.js";
import { completed, failed, type NodeExecutor, type StepContext, type StepOutcome } from "../executors/types.js";

function originOf(ctx: StepContext, kind: PlanOrigin["kind"] = "system"): PlanOrigin {
  return { kind, runId: ctx.run.id };
}

const PLAN_CHANGE_EVENTS = new Set(["dependency.resolved", "dependency.bound", "dependency.added", "decision.resolved", "work-item.updated", "work-item.added", "risk.updated"]);

/** Resolves when the plan journal records something that may change the schedule, or after `ms`. */
function planChanged(ctx: StepContext, planId: string, ms: number): { promise: Promise<void>; dispose: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  const timer = setTimeout(() => resolve(), ms);
  const unsubscribe = ctx.stores.plan.journal.subscribe((e) => {
    if (PLAN_CHANGE_EVENTS.has(e.type)) resolve();
  }, planId);
  const onAbort = () => resolve();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const dispose = () => {
    clearTimeout(timer);
    unsubscribe();
    ctx.signal.removeEventListener("abort", onAbort);
  };
  return { promise: promise.finally(dispose), dispose };
}

// ------------------------------------------------------------- plan-register

export interface PlanRegisterNode extends CustomNode {
  type: "custom:plan-register";
  /** Name or kind of the decomposition artifact (default "decomposition"). */
  artifact?: string;
  /** Plan key (template). Defaults to `vars.plan`, then the configured default plan. */
  plan?: string;
  planName?: string;
}

export const planRegisterExecutor: NodeExecutor<PlanRegisterNode> = {
  type: "custom:plan-register",
  async execute(ctx): Promise<StepOutcome> {
    const name = ctx.node.artifact ?? "decomposition";
    const [byName] = await ctx.resolveInputs([{ name, required: false }]);
    const source = byName ?? (await ctx.resolveInputs([{ kind: name, required: true }]))[0]!;
    const parsed = DecompositionSchema.safeParse(source.data);
    if (!parsed.success) return failed("ARTIFACT_INVALID", `decomposition artifact is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, {}, false);

    const request = await ctx.run.request();
    const requestId = request?.id ?? ctx.run.id;
    const keyTemplate = ctx.node.plan ?? (typeof ctx.run.state.run.vars.plan === "string" ? (ctx.run.state.run.vars.plan as string) : undefined);
    const key = keyTemplate ? await ctx.render(keyTemplate) : undefined;
    const origin: PlanOrigin = { kind: "decomposition", runId: ctx.run.id, artifactId: source.id };
    const plan = await ctx.plan.ensurePlan({ ...(key ? { key } : {}), ...(ctx.node.planName ? { name: await ctx.render(ctx.node.planName) } : {}), requestId }, origin);
    const reg = await ctx.plan.registerWorkItems(plan.id, { requestId, items: parsed.data.items, risks: parsed.data.risks, decisions: parsed.data.decisions }, origin);
    for (const w of reg.warnings) ctx.logger.warn(`plan-register: ${w}`);
    if (request) await ctx.stores.requests.put({ ...request, status: "in-progress", updatedAt: ctx.clock.isoNow() });

    const snap = await ctx.plan.snapshot(plan.id);
    const slugOf = new Map(snap.items.map((w) => [w.id, w.slug]));
    const registeredKeys = new Set(reg.decisions.map((d) => d.key));
    const openDecisions = snap.decisions.filter((d) => registeredKeys.has(d.key) && (d.status === "open" || d.status === "deferred")).map((d) => decisionView(d, snap.dependencies, slugOf));
    await ctx.emit({
      type: "vars.set",
      payload: {
        vars: {
          planId: plan.id,
          plan: plan.key,
          workItems: reg.items,
          workItemIds: reg.items.map((w) => w.id),
          openDecisions,
          registration: { warnings: reg.warnings, dependencies: reg.dependencies.length, risks: reg.risks.map((r) => r.key), decisions: reg.decisions.map((d) => d.key) },
        },
      },
    });
    return completed({ data: { planId: plan.id, plan: plan.key, count: reg.items.length, slugs: reg.items.map((w) => w.slug), dependencies: reg.dependencies.length, risks: reg.risks.length, decisions: reg.decisions.length, openDecisions: openDecisions.length, warnings: reg.warnings } });
  },
};

/** What the decision loop / `program/decide` template sees as `vars.decision`. */
export function decisionView(d: Decision, dependencies: readonly Dependency[], slugOf: ReadonlyMap<string, string> = new Map()) {
  const blocks = decisionBlocks(d.id, dependencies);
  return { id: d.id, key: d.key, title: d.title, question: d.question, context: d.context, status: d.status, criteria: d.criteria, options: d.options.map((o) => ({ key: o.key, name: o.name, description: o.description })), blocks, blockedSlugs: blocks.map((id) => slugOf.get(id) ?? id), dueBy: d.dueBy };
}

// ----------------------------------------------------------- decision-matrix

export interface DecisionMatrixNode extends CustomNode {
  type: "custom:decision-matrix";
  /** Name (or kind) of the decision-matrix artifact. Default "decisionMatrix" / kind "decision-matrix". */
  artifact?: string;
  /** Decision key to record under (template; defaults to the artifact's `key`). */
  decision?: string;
}

export interface MatrixChoice {
  key: string;
  choice: string;
  decidedBy: Decision["decidedBy"];
  result?: DecisionMatrixResult;
  recorded: boolean;
}

/** Shared by the custom node and the `matrix` decision source. */
export async function resolveMatrixChoice(ctx: StepContext, artifactName: string, decisionKey?: string): Promise<MatrixChoice> {
  const [byName] = await ctx.resolveInputs([{ name: artifactName, required: false }]);
  const art = byName ?? (await ctx.resolveInputs([{ kind: artifactName === "decisionMatrix" ? "decision-matrix" : artifactName, required: true }]))[0]!;
  const parsed = DecisionMatrixArtifactSchema.safeParse({ ...art.data, ...(decisionKey ? { key: decisionKey } : {}) });
  if (!parsed.success) throw new Error(`decision-matrix artifact '${art.name}' is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const input = parsed.data;
  const origin: PlanOrigin = { kind: "agent", runId: ctx.run.id, artifactId: art.id };
  const plan = await ctx.plan.planForRun(ctx.run.state.run);
  if (plan) {
    // upsertDecision decides when the artifact carries a valid `chosen`; otherwise evaluate the matrix.
    const { chosen: _chosen, rationale: _rationale, ...definition } = input;
    const dec = await ctx.plan.upsertDecision(plan.id, definition, origin);
    const evaluated = await ctx.plan.evaluateDecision(plan.id, dec.id, { ...(input.chosen ? { chosen: input.chosen } : {}), decidedBy: "agent", ...(input.rationale ? { rationale: input.rationale } : {}) }, origin);
    return { key: dec.key, choice: evaluated.choice, decidedBy: evaluated.decision.decidedBy, recorded: true, ...(evaluated.result ? { result: evaluated.result } : {}) };
  }
  const result = input.criteria.length && input.options.length ? evaluateDecisionMatrix({ criteria: input.criteria, options: input.options, scale: input.scale }, ctx.clock.isoNow()) : undefined;
  const optionKeys = input.options.map((o) => o.key);
  const explicit = input.chosen && (optionKeys.length === 0 || optionKeys.includes(input.chosen)) ? input.chosen : undefined;
  const choice = explicit ?? result?.recommended;
  if (!choice) throw new Error(`decision-matrix artifact '${art.name}' has no options to choose from`);
  return { key: input.key, choice, decidedBy: explicit ? "agent" : "matrix", recorded: false, ...(result ? { result } : {}) };
}

export const decisionMatrixExecutor: NodeExecutor<DecisionMatrixNode> = {
  type: "custom:decision-matrix",
  async execute(ctx): Promise<StepOutcome> {
    let m: MatrixChoice;
    try {
      m = await resolveMatrixChoice(ctx, ctx.node.artifact ?? "decisionMatrix", ctx.node.decision ? await ctx.render(ctx.node.decision) : undefined);
    } catch (e) {
      return failed("ARTIFACT_INVALID", (e as Error).message, {}, false);
    }
    await ctx.emit({ type: "decision.resolved", payload: { stepRunId: ctx.step.id, choice: m.choice, source: `matrix:${m.key}:${m.decidedBy}`, raw: m.result } });
    return completed({ choice: m.choice, data: { decision: m.key, chosen: m.choice, decidedBy: m.decidedBy, recorded: m.recorded, ...(m.result ? { recommended: m.result.recommended, margin: m.result.margin, confidence: m.result.confidence, ranking: m.result.ranking.map((r) => ({ option: r.option, score: r.score })), pivotalCriteria: m.result.pivotalCriteria } : {}) } });
  },
};

// ------------------------------------------------------------- plan-schedule

export interface PlanScheduleNode extends CustomNode {
  type: "custom:plan-schedule";
  /** Plan key; defaults to `vars.plan` / the run's plan. */
  plan?: string;
  /** Workspace-relative path template for the schedule artifact. Empty string disables it. */
  artifactPath?: string;
  policy?: Partial<SchedulingPolicy>;
  /** Journal the computed schedule (default true). */
  record?: boolean;
}

async function planOf(ctx: StepContext, key?: string) {
  if (key) return ctx.plan.requirePlan(await ctx.render(key));
  const fromVars = ctx.run.state.run.vars.planId ?? ctx.run.state.run.vars.plan;
  if (typeof fromVars === "string") return ctx.plan.requirePlan(fromVars);
  const plan = await ctx.plan.planForRun(ctx.run.state.run);
  if (!plan) throw new Error("this run is not attached to a plan (run custom:plan-register first)");
  return plan;
}

export const planScheduleExecutor: NodeExecutor<PlanScheduleNode> = {
  type: "custom:plan-schedule",
  async execute(ctx): Promise<StepOutcome> {
    let plan;
    try {
      plan = await planOf(ctx, ctx.node.plan);
    } catch (e) {
      return failed("PLAN_NOT_FOUND", (e as Error).message, {}, false);
    }
    const schedule = await ctx.plan.schedule(plan.id, { ...(ctx.node.policy ? { policy: ctx.node.policy } : {}), record: ctx.node.record !== false, runId: ctx.run.id, origin: originOf(ctx) });
    const snap = await ctx.plan.snapshot(plan.id);
    const compact = await ctx.plan.compactSchedule(plan.id, ctx.node.policy ? { policy: ctx.node.policy } : {});
    await ctx.emit({ type: "vars.set", payload: { vars: { schedule: compact as unknown as Record<string, unknown> } } });

    const pathTemplate = ctx.node.artifactPath ?? ".orca/plans/{{ vars.plan }}/schedule.md";
    const artifactIds: string[] = [];
    if (pathTemplate) {
      const relative = await ctx.render(pathTemplate);
      const content = renderScheduleMarkdown(schedule, snap, compact);
      const a = await ctx.recordArtifact({ kind: "schedule", name: "schedule", path: relative, required: true }, content, { path: `${ctx.workspace.cwd}/${relative}`.replace(/\/+/g, "/") });
      artifactIds.push(a.id);
      // Materialise for humans too (best effort; the artifact store keeps the canonical copy).
      try {
        const host = ctx.agents.host(ctx.workspace.hostId);
        await host.fs.mkdirp(a.path!.slice(0, a.path!.lastIndexOf("/")));
        await host.fs.writeFile(a.path!, content);
      } catch (e) {
        ctx.logger.warn("could not write schedule.md to the workspace", { error: (e as Error).message });
      }
    }
    return completed({ artifactIds, data: { ready: schedule.ready.map((r) => r.slug), waiting: schedule.waiting.length, held: schedule.held.length, unschedulable: schedule.unschedulable.length, highestRisk: schedule.risk.highestLevel, openDecisions: schedule.openDecisions.length, criticalPath: compact.criticalPath } });
  },
};

export function renderScheduleMarkdown(schedule: Schedule, snap: PlanSnapshot, compact: CompactSchedule): string {
  const slug = (id: string) => snap.items.find((i) => i.id === id)?.slug ?? id;
  const lines: string[] = [`# Schedule for plan \`${snap.plan.key}\``, "", `Computed ${schedule.computedAt} with strategy **${schedule.strategy}** (risk appetite: ${schedule.policy.riskAppetite}).`, ""];
  lines.push("## Ready (dispatch order)", "");
  if (!schedule.ready.length) lines.push("_nothing is ready_");
  schedule.ready.forEach((r, i) => lines.push(`${i + 1}. \`${r.slug}\` (score ${r.priority.score})${r.priority.reasons.length ? ` - ${r.priority.reasons.join("; ")}` : ""}`));
  if (schedule.waiting.length) {
    lines.push("", "## Waiting", "");
    for (const w of schedule.waiting) lines.push(`- \`${w.slug}\`: ${w.waitingOn.map((x) => x.detail).join("; ")}`);
  }
  if (schedule.held.length) {
    lines.push("", "## Held for risk", "");
    for (const h of schedule.held) lines.push(`- \`${h.slug}\`: ${h.reason}`);
  }
  if (schedule.unschedulable.length) {
    lines.push("", "## Cannot run", "");
    for (const u of schedule.unschedulable) lines.push(`- \`${u.slug}\`: ${u.reason}`);
  }
  lines.push("", "## Waves", "");
  schedule.waves.forEach((w, i) => lines.push(`${i + 1}. ${w.map((id) => `\`${slug(id)}\``).join(", ")}`));
  if (schedule.criticalPath.workItemIds.length) lines.push("", `Critical path (${schedule.criticalPath.length}): ${schedule.criticalPath.workItemIds.map((id) => `\`${slug(id)}\``).join(" -> ")}`);
  lines.push("", "## Risks", "");
  if (!schedule.risk.open) lines.push("_no open risks_");
  else {
    lines.push("| risk | level | L x I | status | affects | mitigation |", "| --- | --- | --- | --- | --- | --- |");
    for (const r of snap.risks.filter(isOpenRisk)) lines.push(`| ${r.key} | ${riskLevel(riskScore(r), snap.plan.riskMatrix)} | ${r.likelihood} x ${r.impact} | ${r.status} | ${r.affects.map(slug).join(", ")} | ${r.mitigation ?? ""} |`);
  }
  if (snap.decisions.length) {
    lines.push("", "## Decisions", "");
    for (const d of snap.decisions) {
      lines.push(`### ${d.key}: ${d.title} (${d.status}${d.chosen ? ` = ${d.chosen}` : ""})`, "");
      if (d.question) lines.push(d.question, "");
      if (d.result && d.criteria.length && d.options.length) lines.push(renderDecisionMatrix({ criteria: d.criteria, options: d.options, scale: d.scale }, d.result), "");
      if (d.rationale) lines.push(`Rationale: ${d.rationale}`, "");
      const blocks = decisionBlocks(d.id, snap.dependencies);
      if (blocks.length) lines.push(`Blocks: ${blocks.map(slug).join(", ")}`, "");
    }
  }
  lines.push("", "## Dependency graph", "", "```mermaid", planToMermaid({ items: snap.items, dependencies: snap.dependencies, decisions: snap.decisions }), "```", "");
  return serializeFrontMatter({ data: { status: "done", ...(compact as unknown as Record<string, unknown>) }, body: lines.join("\n") });
}

// ------------------------------------------------------------- plan-dispatch

export interface PlanDispatchNode extends CustomNode {
  type: "custom:plan-dispatch";
  /** Workflow to run per item unless the item names its own. Defaults to `vars.itemWorkflow` (seeded from `program.itemWorkflow`). */
  workflow?: string;
  concurrency?: number;
  /** `request` (default): only this request's items. `plan`: anything ready anywhere in the plan. */
  scope?: "request" | "plan";
  /** Only dispatch leaf items (no children). Default true. */
  leavesOnly?: boolean;
  /** Stop launching new items after the first failure. Default false: unrelated items continue. */
  failFast?: boolean;
  /**
   * What to do when nothing is ready but items are still waiting (on another
   * request, an external, an open decision, or held for risk):
   * `defer` (default) leaves them pending and finishes; `wait` polls the plan.
   */
  onWaiting?: "defer" | "wait";
  pollMs?: number;
  waitTimeoutMs?: number;
  policy?: Partial<SchedulingPolicy>;
}

export const planDispatchExecutor: NodeExecutor<PlanDispatchNode> = {
  type: "custom:plan-dispatch",
  async execute(ctx): Promise<StepOutcome> {
    const n = ctx.node;
    let plan;
    try {
      plan = await planOf(ctx);
    } catch (e) {
      return failed("PLAN_NOT_FOUND", (e as Error).message, {}, false);
    }
    const requestId = ctx.run.state.run.requestId;
    const scope = n.scope ?? "request";
    const itemWorkflowVar = ctx.run.state.run.vars.itemWorkflow;
    const defaultWorkflow = n.workflow ?? (typeof itemWorkflowVar === "string" && itemWorkflowVar ? itemWorkflowVar : undefined);
    if (!defaultWorkflow) return failed("WORKFLOW_INVALID", `plan-dispatch '${ctx.nodeId}': no item workflow (set 'workflow' on the node or 'vars.itemWorkflow' / program.itemWorkflow)`, {}, false);
    const policy: Partial<SchedulingPolicy> = { ...(n.policy ?? {}), ...(n.concurrency ? { concurrency: n.concurrency } : {}) };
    const concurrency = Math.max(1, n.concurrency ?? plan.policy.concurrency);
    const pollMs = n.pollMs ?? 5_000;
    const deadline = n.waitTimeoutMs ? Date.now() + n.waitTimeoutMs : Number.POSITIVE_INFINITY;

    const allItems = await ctx.stores.workItems.list((w) => w.planId === plan.id);
    const parents = new Set(allItems.map((w) => w.parentId).filter(Boolean));
    const inScope = (w: WorkItem) => (scope === "plan" || w.requestId === requestId) && (n.leavesOnly === false || !parents.has(w.id));

    const inFlight = new Map<string, Promise<void>>();
    const outcomes = new Map<string, { status: "done" | "failed" | "paused"; runId: string }>();
    /** Children parked at a human gate: this step parks too and re-attaches to them on resume. */
    const parkedChildren = new Map<string, RunState>();
    const deferred = new Map<string, string>();
    /** Items another dispatcher owns: this step never launches them and never writes their status. */
    const claimed = new Map<string, string>();
    let stop = false;
    let failure: unknown;

    // Items an earlier, interrupted attempt of this step had already launched. They are still
    // `in-progress` (so the scheduler will not offer them as ready) but must be driven again:
    // `ctx.runChild` re-attaches to the child run spawned under the same branch (the slug).
    const resumable = new Set<string>();
    for (const stepId of ctx.run.state.stepOrder) {
      const s = ctx.run.state.steps[stepId];
      if (!s || s.id === ctx.step.id || s.nodeId !== ctx.nodeId || s.attempt >= ctx.step.attempt) continue;
      for (const c of s.children) if (c.workItemId) resumable.add(c.workItemId);
    }

    // The item's `status` / `runId` are not written here: `ctx.runChild` records `child.spawned`
    // and `child.finished` on this step, and the run-log projection turns those into
    // `in-progress` / `done` / `failed` / `cancelled` (engine/program/work-items.ts), journalling
    // each transition. One writer, so a crash between the child finishing and this step resuming
    // cannot leave the plan's view and the log's view disagreeing.
    const launch = (item: WorkItem, reasons: string[]) => {
      const p = (async () => {
        // The scheduler offered this item, but `in-progress` only lands once `child.spawned` is
        // projected - asynchronously, after the ready set was computed. Two dispatchers over one
        // plan therefore both see it ready; the claim is what makes exactly one of them launch it.
        const holder = await ctx.stores.claims.claim({ workItemId: item.id, runId: ctx.run.id, branch: item.slug, stepRunId: ctx.step.id, at: ctx.clock.isoNow() });
        if (!ownsClaim(holder, ctx.run.id, item.slug)) {
          claimed.set(item.id, holder.runId);
          ctx.logger.warn("work item already claimed", { workItem: item.slug, owner: holder.runId });
          await ctx.stores.plan.journal.append({ type: "dispatch.deferred", planId: plan.id, origin: originOf(ctx), payload: { workItemId: item.id, reason: `claimed by run ${holder.runId}` } });
          return;
        }
        const upstream = await ctx.plan.upstreamContext(item.id);
        const state = await ctx.runChild({ workflow: item.workflowId ?? defaultWorkflow }, { workItemId: item.id, branch: item.slug, vars: { workItem: item, upstream, planId: plan.id, plan: plan.key } });
        if (state.run.status === "paused") {
          // A human must answer inside the child. The item stays in-progress; nothing is decided yet.
          outcomes.set(item.id, { status: "paused", runId: state.run.id });
          parkedChildren.set(item.id, state);
          return;
        }
        const ok = succeeded(state);
        outcomes.set(item.id, { status: ok ? "done" : "failed", runId: state.run.id });
        await ctx.stores.plan.journal.append({ type: "dispatch.finished", planId: plan.id, origin: originOf(ctx), payload: { workItemId: item.id, runId: state.run.id, status: ok ? "done" : "failed" } });
        if (!ok && n.failFast) stop = true;
      })()
        .catch((e: unknown) => {
          // Surface the first error from the loop below instead of leaving an unhandled rejection.
          failure ??= e;
          stop = true;
        })
        .finally(() => inFlight.delete(item.id));
      inFlight.set(item.id, p);
    };

    for (;;) {
      if (ctx.signal.aborted) return failed("CANCELLED", "cancelled");
      const schedule = await ctx.plan.schedule(plan.id, { inScope, running: [...inFlight.keys()], policy, origin: originOf(ctx) });
      const byId = new Map((await ctx.stores.workItems.list((w) => w.planId === plan.id)).map((w) => [w.id, w]));
      // An item another dispatcher owns stays "ready" as far as *this* plan is concerned, so it
      // has to come out of the ready set: otherwise it takes a launch slot every pass and the
      // loop below never settles.
      const ready = schedule.ready.filter((r) => !claimed.has(r.workItemId));

      for (const u of schedule.unschedulable) {
        const item = byId.get(u.workItemId);
        if (!item || outcomes.has(item.id)) continue;
        await ctx.plan.deferWorkItem(item.id, u.reason, { blocked: true }, originOf(ctx));
      }
      if (!stop) {
        for (const item of byId.values()) {
          if (inFlight.size >= concurrency) break;
          if (!resumable.has(item.id) || item.status !== "in-progress" || !inScope(item) || inFlight.has(item.id) || outcomes.has(item.id) || claimed.has(item.id)) continue;
          await ctx.stores.plan.journal.append({ type: "dispatch.started", planId: plan.id, origin: originOf(ctx), payload: { workItemId: item.id, runId: ctx.run.id, reasons: ["re-attached after an interrupted attempt"] } });
          launch(item, []);
        }
        for (const r of ready.slice(0, Math.max(0, concurrency - inFlight.size))) {
          const item = byId.get(r.workItemId);
          if (!item || inFlight.has(item.id) || outcomes.has(item.id)) continue;
          await ctx.plan.clearDeferral(item.id, originOf(ctx));
          await ctx.stores.plan.journal.append({ type: "dispatch.started", planId: plan.id, origin: originOf(ctx), payload: { workItemId: item.id, runId: ctx.run.id, reasons: r.priority.reasons } });
          launch(item, r.priority.reasons);
        }
      }
      if (inFlight.size > 0) {
        // Wake when a child finishes *or* the plan changes (an upstream item produced the stage
        // a dependant waits for, a decision was made, ...), so pipelining does not wait for a slot to free.
        const change = planChanged(ctx, plan.id, pollMs);
        await Promise.race([...inFlight.values(), change.promise]);
        change.dispose();
        continue;
      }
      const pending = [...schedule.waiting.map((w) => ({ id: w.workItemId, reason: w.waitingOn.map((x) => x.detail).join("; ") })), ...schedule.held.map((h) => ({ id: h.workItemId, reason: h.reason }))];
      if (stop || pending.length === 0 || ready.length > 0) break;
      if (n.onWaiting === "wait" && Date.now() < deadline) {
        await ctx.emit({ type: "step.waiting", payload: { stepRunId: ctx.step.id, on: "plan", detail: pending.map((p) => `${byId.get(p.id)?.slug ?? p.id}: ${p.reason}`).join(" | ") } });
        await planChanged(ctx, plan.id, pollMs).promise;
        continue;
      }
      for (const p of pending) {
        deferred.set(p.id, p.reason);
        await ctx.plan.deferWorkItem(p.id, p.reason, {}, originOf(ctx));
      }
      break;
    }

    if (failure) throw failure;
    const parked = await pausedByChildren(ctx, [...parkedChildren.values()]);
    if (parked) return parked;

    const finalItems = (await ctx.stores.workItems.list((w) => w.planId === plan.id)).filter(inScope);
    const summary = finalItems.map((w) => ({
      id: w.id,
      slug: w.slug,
      status: claimed.has(w.id) ? "claimed" : (outcomes.get(w.id)?.status ?? (w.status === "done" ? "done" : w.status === "blocked" ? "blocked" : deferred.has(w.id) ? "deferred" : w.status === "failed" ? "failed" : "skipped")),
      runId: outcomes.get(w.id)?.runId ?? w.runId,
      reason: claimed.has(w.id) ? `claimed by run ${claimed.get(w.id)}` : (deferred.get(w.id) ?? w.deferredReason),
    }));
    const counts = { done: 0, failed: 0, blocked: 0, deferred: 0, skipped: 0, paused: 0, claimed: 0 };
    for (const s of summary) counts[s.status as keyof typeof counts]++;
    // An item another dispatcher owns is not this step's failure - it is simply not its work.
    const outcome = counts.failed || counts.blocked ? "failed" : counts.deferred || counts.skipped || counts.claimed ? "partial" : "complete";
    await ctx.emit({ type: "vars.set", payload: { vars: { dispatched: summary, dispatchOutcome: outcome } } });
    if (outcome === "failed") return failed("RUN_STATE", `${counts.failed + counts.blocked} of ${summary.length} work items did not complete (${counts.failed} failed, ${counts.blocked} blocked)`, { summary, counts });
    return completed({ data: { summary, counts, outcome } });
  },
};

// ---------------------------------------------------------------- plan-await

export interface PlanAwaitNode extends CustomNode {
  type: "custom:plan-await";
  /** Dependencies whose `requiredBy` equals this phase are awaited. Default "build". */
  phase?: string;
  pollMs?: number;
  timeoutMs?: number;
}

export const planAwaitExecutor: NodeExecutor<PlanAwaitNode> = {
  type: "custom:plan-await",
  async execute(ctx): Promise<StepOutcome> {
    const workItemId = ctx.run.state.run.workItemId;
    if (!workItemId) return completed({ data: { skipped: "no work item" } });
    const wi = await ctx.stores.workItems.get(workItemId);
    if (!wi?.planId) return completed({ data: { skipped: "work item is not in a plan" } });
    const phase = ctx.node.phase ?? "build";
    const pollMs = ctx.node.pollMs ?? 2_000;
    const deadline = Date.now() + (ctx.node.timeoutMs ?? 30 * 60_000);
    const started = Date.now();
    let announced = false;
    for (;;) {
      if (ctx.signal.aborted) return failed("CANCELLED", "cancelled");
      const evals = (await ctx.plan.evaluateDependenciesOf(workItemId, phase)).filter((e) => e.dependency.type === "blocks");
      const failedDeps = evals.filter((e) => e.state === "failed");
      if (failedDeps.length) return failed("RUN_STATE", `dependencies required by '${phase}' failed: ${failedDeps.map((e) => e.detail).join("; ")}`, { dependencyIds: failedDeps.map((e) => e.dependency.id) }, false);
      const waiting = evals.filter((e) => e.state === "waiting");
      if (waiting.length === 0) {
        const upstream = await ctx.plan.upstreamContext(workItemId);
        await ctx.emit({ type: "vars.set", payload: { vars: { upstream } } });
        return completed({ data: { phase, waitedMs: Date.now() - started, satisfied: evals.map((e) => e.detail) } });
      }
      if (Date.now() >= deadline) return failed("STEP_TIMEOUT", `timed out waiting for dependencies required by '${phase}': ${waiting.map((e) => e.detail).join("; ")}`, {}, false);
      if (!announced) {
        await ctx.emit({ type: "step.waiting", payload: { stepRunId: ctx.step.id, on: "dependencies", detail: waiting.map((e) => e.detail).join("; ") } });
        announced = true;
      }
      await planChanged(ctx, wi.planId, pollMs).promise;
    }
  },
};

export const PLAN_EXECUTOR_TYPES = ["custom:plan-register", "custom:decision-matrix", "custom:plan-schedule", "custom:plan-dispatch", "custom:plan-await"] as const;

