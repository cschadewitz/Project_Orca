/**
 * `orca plan ...` - inspect and steer the long-term plan from the terminal.
 *
 *   plan                          list plans
 *   plan show [key]               work items with status, dependencies, risks, decisions
 *   plan schedule [key]           what would run now, what waits (and why), waves, critical path
 *   plan explain <slug> [key]     one item's place in the schedule and every reason behind it
 *   plan graph [key]              dependency graph as Mermaid
 *   plan risks [key]              risk register with scores and levels
 *   plan decisions [key]          decisions with matrices and outcomes
 *   plan journal [key]            the audit trail
 *   plan depend <slug> <ref> [key]        add a dependency (grammar: docs/PLANNING.md)
 *   plan waive <dependencyId> [key]       waive a dependency (human override)
 *   plan satisfy <dependencyId> [key]     mark an external dependency satisfied
 *   plan decide <decisionKey> <option> [key] [--rationale text]
 *   plan risk <riskKey> --status <status> [key]   accept / mitigate / close a risk
 *   plan dispatch [key]           run the plan-resume workflow: schedule -> gate -> dispatch across the plan
 */
import { describeRiskMatrix, planToMermaid, renderDecisionMatrix, riskLevel, riskScore, OrcaError, type PlanOrigin, type RiskStatus } from "@orca/core";
import type { PlanService } from "@orca/engine";
import { bootstrap } from "../bootstrap.js";
import { attachEventPrinter, finish, type CommandContext } from "./index.js";

const HUMAN: PlanOrigin = { kind: "human", actor: "cli" };

async function open(ctx: CommandContext) {
  return bootstrap({ cwd: ctx.cwd, ...(ctx.configPath ? { configPath: ctx.configPath } : {}), logLevel: "warn" });
}

async function resolvePlan(plan: PlanService, ctx: CommandContext, positional: string | undefined, fallbackKey: string) {
  const key = (ctx.flags.plan as string | undefined) ?? positional ?? fallbackKey;
  const found = await plan.getPlan(key);
  if (!found) {
    const all = await plan.listPlans();
    throw new OrcaError("PLAN_NOT_FOUND", `plan '${key}' not found${all.length ? `; known plans: ${all.map((p) => p.key).join(", ")}` : " (no plans yet - submit a request first)"}`);
  }
  return found;
}

const pad = (s: string, n: number) => s.padEnd(n);

export async function planCommand(ctx: CommandContext): Promise<number> {
  const [sub = "list", ...args] = ctx.positionals;
  const app = await open(ctx);
  const plan = app.plan;
  const defaultKey = app.config.planning.plan;
  const json = Boolean(ctx.flags.json);

  switch (sub) {
    case "list": {
      const plans = await plan.listPlans();
      if (json) return (ctx.out(JSON.stringify(plans, null, 2)), 0);
      if (!plans.length) ctx.out("no plans yet (submit a request to create one)");
      for (const p of plans) {
        const items = await app.orchestrator.stores.workItems.list((w) => w.planId === p.id);
        ctx.out(`${pad(p.key, 16)} ${pad(p.status, 9)} ${items.length} item(s), ${p.requestIds.length} request(s), strategy=${p.policy.strategy}, appetite=${p.policy.riskAppetite}  ${p.id}`);
      }
      return 0;
    }

    case "show": {
      const p = await resolvePlan(plan, ctx, args[0], defaultKey);
      const snap = await plan.snapshot(p.id);
      if (json) return (ctx.out(JSON.stringify(snap, null, 2)), 0);
      const slug = (id: string) => snap.items.find((i) => i.id === id)?.slug ?? id;
      ctx.out(`plan ${p.key} (${p.id})  ${p.name}  status=${p.status}  strategy=${p.policy.strategy}  concurrency=${p.policy.concurrency}  appetite=${p.policy.riskAppetite}`);
      ctx.out(`requests: ${p.requestIds.join(", ") || "-"}`);
      ctx.out(`risk matrix: ${describeRiskMatrix(p.riskMatrix)}`);
      ctx.out("");
      ctx.out("work items:");
      for (const w of snap.items) {
        const deps = snap.dependencies.filter((d) => d.from === w.id);
        const depText = deps.map((d) => `${d.type === "blocks" ? "" : d.type + ":"}${d.target.kind === "work-item" ? slug(d.target.workItemId) + (d.target.stage ? "@" + d.target.stage : "") : d.target.kind === "decision" ? "decision:" + (snap.decisions.find((x) => x.id === (d.target as { decisionId: string }).decisionId)?.key ?? "?") : "external:" + d.target.key}${d.requiredBy !== "start" ? "#" + d.requiredBy : ""} [${d.status}]`);
        ctx.out(`  ${pad(w.status, 12)} ${pad(w.slug, 24)} ${pad(w.priority, 8)} ${w.title}${w.runId ? `  run=${w.runId}` : ""}${depText.length ? `\n${" ".repeat(15)}depends on: ${depText.join(", ")}` : ""}${w.deferredReason ? `\n${" ".repeat(15)}deferred: ${w.deferredReason}` : ""}`);
      }
      if (snap.risks.length) {
        ctx.out("");
        ctx.out("risks:");
        for (const r of snap.risks) ctx.out(`  ${pad(r.status, 11)} ${pad(riskLevel(riskScore(r), p.riskMatrix), 8)} ${pad(r.key, 24)} L${r.likelihood} x I${r.impact}  affects: ${r.affects.map(slug).join(", ") || "-"}`);
      }
      if (snap.decisions.length) {
        ctx.out("");
        ctx.out("decisions:");
        for (const d of snap.decisions) ctx.out(`  ${pad(d.status, 11)} ${pad(d.key, 24)} ${d.title}${d.chosen ? `  = ${d.chosen} (${d.decidedBy})` : ""}  blocks: ${d.blocks.map(slug).join(", ") || "-"}`);
      }
      return 0;
    }

    case "schedule": {
      const p = await resolvePlan(plan, ctx, args[0], defaultKey);
      const c = await plan.compactSchedule(p.id);
      if (json) return (ctx.out(JSON.stringify(c, null, 2)), 0);
      ctx.out(`schedule for ${p.key} (strategy ${c.strategy}; open risks ${c.risk.open}, highest ${c.risk.highestLevel})`);
      ctx.out("");
      ctx.out("ready (in order):");
      if (!c.ready.length) ctx.out("  -");
      c.ready.forEach((r, i) => ctx.out(`  ${i + 1}. ${pad(r.slug, 24)} score=${r.score}${r.reasons.length ? "  " + r.reasons.join("; ") : ""}`));
      if (c.running.length) ctx.out(`running: ${c.running.join(", ")}`);
      if (c.waiting.length) {
        ctx.out("");
        ctx.out("waiting:");
        for (const w of c.waiting) ctx.out(`  ${pad(w.slug, 24)} ${w.on.join("; ")}`);
      }
      if (c.held.length) {
        ctx.out("");
        ctx.out("held for risk:");
        for (const h of c.held) ctx.out(`  ${pad(h.slug, 24)} ${h.reason}`);
      }
      if (c.unschedulable.length) {
        ctx.out("");
        ctx.out("cannot run:");
        for (const u of c.unschedulable) ctx.out(`  ${pad(u.slug, 24)} ${u.reason}`);
      }
      if (c.openDecisions.length) {
        ctx.out("");
        ctx.out("open decisions:");
        for (const d of c.openDecisions) ctx.out(`  ${pad(d.key, 24)} blocks: ${d.blocks.join(", ") || "-"}`);
      }
      ctx.out("");
      ctx.out("waves:");
      c.waves.forEach((w, i) => ctx.out(`  ${i + 1}. ${w.join(", ")}`));
      if (c.criticalPath.length) ctx.out(`critical path (${c.criticalPathLength}): ${c.criticalPath.join(" -> ")}`);
      if (c.done.length) ctx.out(`done: ${c.done.join(", ")}`);
      if (c.failed.length) ctx.out(`failed: ${c.failed.join(", ")}`);
      return 0;
    }

    case "explain": {
      const slug = args[0];
      if (!slug) throw new OrcaError("CONFIG_INVALID", "plan explain needs a work item slug");
      const p = await resolvePlan(plan, ctx, args[1], defaultKey);
      for (const line of await plan.explain(p.id, slug)) ctx.out(line);
      return 0;
    }

    case "graph": {
      const p = await resolvePlan(plan, ctx, args[0], defaultKey);
      const snap = await plan.snapshot(p.id);
      ctx.out(planToMermaid({ items: snap.items, dependencies: snap.dependencies, decisions: snap.decisions, title: `plan ${p.key}` }));
      return 0;
    }

    case "risks": {
      const p = await resolvePlan(plan, ctx, args[0], defaultKey);
      const snap = await plan.snapshot(p.id);
      if (json) return (ctx.out(JSON.stringify(snap.risks, null, 2)), 0);
      const slug = (id: string) => snap.items.find((i) => i.id === id)?.slug ?? id;
      const sorted = [...snap.risks].sort((a, b) => riskScore(b) - riskScore(a));
      ctx.out(`risk matrix: ${describeRiskMatrix(p.riskMatrix)}`);
      for (const r of sorted) {
        ctx.out(`${pad(r.status, 11)} ${pad(riskLevel(riskScore(r), p.riskMatrix), 8)} ${pad(r.key, 24)} L${r.likelihood} x I${r.impact} = ${riskScore(r)}  ${r.title}`);
        ctx.out(`${" ".repeat(12)}category=${r.category}  affects: ${r.affects.map(slug).join(", ") || "-"}  mitigated by: ${r.mitigatedBy.map(slug).join(", ") || "-"}${r.mitigation ? `\n${" ".repeat(12)}mitigation: ${r.mitigation}` : ""}`);
      }
      if (!sorted.length) ctx.out("no risks recorded");
      return 0;
    }

    case "decisions": {
      const p = await resolvePlan(plan, ctx, args[0], defaultKey);
      const snap = await plan.snapshot(p.id);
      if (json) return (ctx.out(JSON.stringify(snap.decisions, null, 2)), 0);
      const slug = (id: string) => snap.items.find((i) => i.id === id)?.slug ?? id;
      for (const d of snap.decisions) {
        ctx.out(`${pad(d.status, 11)} ${pad(d.key, 24)} ${d.title}${d.chosen ? `  = ${d.chosen} (${d.decidedBy})` : ""}`);
        if (d.question) ctx.out(`${" ".repeat(12)}${d.question}`);
        if (d.blocks.length) ctx.out(`${" ".repeat(12)}blocks: ${d.blocks.map(slug).join(", ")}`);
        if (d.result && d.criteria.length && d.options.length) ctx.out(renderDecisionMatrix({ criteria: d.criteria, options: d.options, scale: d.scale }, d.result).split("\n").map((l) => " ".repeat(12) + l).join("\n"));
        if (d.rationale) ctx.out(`${" ".repeat(12)}rationale: ${d.rationale}`);
      }
      if (!snap.decisions.length) ctx.out("no decisions recorded");
      return 0;
    }

    case "journal": {
      const p = await resolvePlan(plan, ctx, args[0], defaultKey);
      const snap = await plan.snapshot(p.id);
      const slug = (id: string) => snap.items.find((i) => i.id === id)?.slug ?? id;
      for (const e of await plan.journalOf(p.id)) {
        if (json) {
          ctx.out(JSON.stringify(e));
          continue;
        }
        const pl = e.payload as Record<string, unknown>;
        const what =
          e.type === "work-item.added" ? (pl.workItem as { slug: string }).slug
          : e.type === "work-item.updated" ? `${slug(pl.workItemId as string)} ${JSON.stringify(pl.changes)}`
          : e.type === "dependency.added" ? `${slug((pl.dependency as { from: string }).from)} -> ${JSON.stringify((pl.dependency as { target: unknown }).target)}`
          : e.type === "dependency.resolved" ? `${pl.dependencyId} ${pl.status}${pl.resolution ? `: ${pl.resolution}` : ""}`
          : e.type === "risk.raised" ? (pl.risk as { key: string }).key
          : e.type === "risk.updated" ? `${pl.riskId} ${JSON.stringify(pl.changes)}`
          : e.type === "decision.opened" ? (pl.decision as { key: string }).key
          : e.type === "decision.resolved" ? `${pl.decisionId} = ${pl.chosen} (${pl.decidedBy})`
          : e.type === "schedule.computed" ? `ready: ${(pl.ready as string[]).map(slug).join(", ") || "-"}; waiting: ${(pl.waiting as string[]).length}; held: ${(pl.held as string[]).length}`
          : e.type === "dispatch.started" || e.type === "dispatch.finished" || e.type === "dispatch.deferred" ? `${slug(pl.workItemId as string)}${pl.status ? ` ${pl.status}` : ""}${pl.reason ? ` ${pl.reason}` : ""}`
          : JSON.stringify(pl);
        ctx.out(`${e.at.slice(0, 19)} ${String(e.seq).padStart(4)} ${pad(e.type, 20)} ${pad(e.origin.kind, 13)} ${what}`);
      }
      return 0;
    }

    case "depend": {
      const [from, ref] = args;
      if (!from || !ref) throw new OrcaError("CONFIG_INVALID", "plan depend needs <slug> <dependency-ref>");
      const p = await resolvePlan(plan, ctx, args[2], defaultKey);
      const dep = await plan.addDependency(p.id, from, ref, HUMAN);
      ctx.out(`added ${dep.id}: ${from} -> ${JSON.stringify(dep.target)} (${dep.type}, by ${dep.requiredBy}) status=${dep.status}`);
      return 0;
    }

    case "waive":
    case "satisfy": {
      const id = args[0];
      if (!id) throw new OrcaError("CONFIG_INVALID", `plan ${sub} needs a dependency id`);
      await resolvePlan(plan, ctx, args[1], defaultKey);
      const dep = await plan.resolveDependency(id, sub === "waive" ? "waived" : "satisfied", (ctx.flags.rationale as string | undefined) ?? `${sub} via CLI`, HUMAN);
      ctx.out(`${dep.id} is now ${dep.status}`);
      return 0;
    }

    case "decide": {
      const [key, option] = args;
      if (!key || !option) throw new OrcaError("CONFIG_INVALID", "plan decide needs <decisionKey> <optionKey>");
      const p = await resolvePlan(plan, ctx, args[2], defaultKey);
      const r = await plan.evaluateDecision(p.id, key, { chosen: option, decidedBy: "human", ...(ctx.flags.rationale ? { rationale: String(ctx.flags.rationale) } : {}) }, HUMAN);
      ctx.out(`decision ${r.decision.key} = ${r.choice}${r.result ? ` (matrix recommended ${r.result.recommended}, ${r.result.confidence})` : ""}`);
      return 0;
    }

    case "risk": {
      const key = args[0];
      const status = ctx.flags.status as RiskStatus | undefined;
      if (!key || !status) throw new OrcaError("CONFIG_INVALID", "plan risk needs <riskKey> --status <open|mitigating|mitigated|accepted|realized|closed>");
      const p = await resolvePlan(plan, ctx, args[1], defaultKey);
      const r = await plan.updateRisk(p.id, key, { status }, HUMAN);
      ctx.out(`risk ${r.key} is now ${r.status}`);
      return 0;
    }

    case "dispatch": {
      const p = await resolvePlan(plan, ctx, args[0], defaultKey);
      const detach = attachEventPrinter(app, ctx, Boolean(ctx.flags.quiet));
      try {
        // Same exit-code contract as `orca run` / `orca submit`: 3 + the pending question when a gate parks the run.
        const itemWorkflow = app.config.program.itemWorkflow;
        const state = await app.orchestrator.startAndRun({ workflowId: (ctx.flags.workflow as string | undefined) ?? "plan-resume", vars: { plan: p.key, planId: p.id, ...(itemWorkflow ? { itemWorkflow } : {}) } });
        return await finish(app, ctx, state);
      } finally {
        detach();
      }
    }

    default:
      throw new OrcaError("CONFIG_INVALID", `unknown plan subcommand '${sub}' (list, show, schedule, explain, graph, risks, decisions, journal, depend, waive, satisfy, decide, risk, dispatch)`);
  }
}
