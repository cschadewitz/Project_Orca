/**
 * Program-level custom nodes: the "level above" the SDLC loop.
 *
 *  custom:materialize-work-items  - turn a `decomposition` artifact into
 *                                   WorkItem records (vars.workItems).
 *  custom:dispatch-work-items     - run the item workflow for each work item,
 *                                   honouring dependsOn, with bounded
 *                                   concurrency; each item gets its own
 *                                   workspace from the WorkspaceProvider.
 *
 * They are implemented as `custom:*` nodes on purpose: they show how a plugin
 * extends the node vocabulary without touching the core schema.
 */
import { DecompositionSchema, newId, OrcaError, type CustomNode, type RunState, type WorkItem } from "@orca/core";
import { pausedByChildren } from "../executors/containers.js";
import { completed, failed, type NodeExecutor, type StepOutcome } from "../executors/types.js";

export interface MaterializeWorkItemsNode extends CustomNode {
  type: "custom:materialize-work-items";
  /** Name/kind of the decomposition artifact (default "decomposition"). */
  artifact?: string;
}

export const materializeWorkItemsExecutor: NodeExecutor<MaterializeWorkItemsNode> = {
  type: "custom:materialize-work-items",
  async execute(ctx): Promise<StepOutcome> {
    const name = ctx.node.artifact ?? "decomposition";
    const [art] = await ctx.resolveInputs([{ name, required: false }]);
    const source = art ?? (await ctx.resolveInputs([{ kind: name, required: true }]))[0]!;
    const parsed = DecompositionSchema.safeParse(source.data);
    if (!parsed.success) return failed("ARTIFACT_INVALID", `decomposition artifact is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, {}, false);
    const request = await ctx.run.request();
    const requestId = request?.id ?? ctx.run.id;
    const now = ctx.clock.isoNow();
    const bySlug = new Map<string, WorkItem>();
    for (const item of parsed.data.items) {
      const wi: WorkItem = {
        id: newId("wi", ctx.clock.now()),
        requestId,
        slug: item.slug,
        title: item.title,
        description: item.description,
        kind: item.kind,
        acceptanceCriteria: item.acceptanceCriteria,
        dependsOn: item.dependsOn,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        ...(item.workflow ? { workflowId: item.workflow } : {}),
        ...(item.repo ? { repo: item.repo } : {}),
        ...(item.estimate ? { estimate: item.estimate } : {}),
      };
      bySlug.set(item.slug, wi);
    }
    for (const item of parsed.data.items) {
      if (item.parent) {
        const parent = bySlug.get(item.parent);
        if (parent) bySlug.get(item.slug)!.parentId = parent.id;
      }
      for (const dep of item.dependsOn) if (!bySlug.has(dep)) return failed("ARTIFACT_INVALID", `work item '${item.slug}' depends on unknown '${dep}'`, {}, false);
    }
    for (const wi of bySlug.values()) await ctx.stores.workItems.put(wi);
    if (request) await ctx.stores.requests.put({ ...request, status: "in-progress", updatedAt: now });
    const workItems = [...bySlug.values()];
    await ctx.emit({ type: "vars.set", payload: { vars: { workItems, workItemIds: workItems.map((w) => w.id) } } });
    return completed({ data: { count: workItems.length, slugs: workItems.map((w) => w.slug) } });
  },
};

export interface DispatchWorkItemsNode extends CustomNode {
  type: "custom:dispatch-work-items";
  /** Workflow to run per item unless the item names its own. */
  workflow: string;
  concurrency?: number;
  /** Only dispatch leaf items (no children). Default true. */
  leavesOnly?: boolean;
  /** Stop scheduling new items after the first failure. Default true. */
  failFast?: boolean;
}

export const dispatchWorkItemsExecutor: NodeExecutor<DispatchWorkItemsNode> = {
  type: "custom:dispatch-work-items",
  async execute(ctx): Promise<StepOutcome> {
    const n = ctx.node;
    const ids = (ctx.run.state.run.vars.workItemIds as string[] | undefined) ?? [];
    let items = (await Promise.all(ids.map((id) => ctx.stores.workItems.get(id)))).filter((w): w is WorkItem => !!w);
    if (items.length === 0) return failed("RUN_STATE", "no work items to dispatch (run custom:materialize-work-items first)", {}, false);
    const parents = new Set(items.map((w) => w.parentId).filter(Boolean));
    if (n.leavesOnly !== false) items = items.filter((w) => !parents.has(w.id));
    const bySlug = new Map(items.map((w) => [w.slug, w]));
    const byId = new Map(items.map((w) => [w.id, w]));
    const depKey = (d: string) => bySlug.get(d)?.id ?? d;

    const done = new Map<string, RunState>();
    /** Items whose run parked at a human gate: neither done nor failed, and their dependants stay unscheduled. */
    const parked = new Map<string, RunState>();
    const failedIds = new Set<string>();
    const inFlight = new Map<string, Promise<void>>();
    const concurrency = Math.max(1, n.concurrency ?? 2);
    let stop = false;

    const touch = async (w: WorkItem, patch: Partial<WorkItem>) => {
      const cur = (await ctx.stores.workItems.get(w.id)) ?? w;
      await ctx.stores.workItems.put({ ...cur, ...patch, updatedAt: ctx.clock.isoNow() });
    };

    const launch = (w: WorkItem) => {
      const p = (async () => {
        await touch(w, { status: "in-progress" });
        const state = await ctx.runChild({ workflow: w.workflowId ?? n.workflow }, { workItemId: w.id, branch: w.slug, vars: { workItem: w } });
        if (state.run.status === "paused") {
          parked.set(w.id, state);
          await touch(w, { runId: state.run.id });
          return;
        }
        done.set(w.id, state);
        const ok = state.run.status === "completed" && state.run.outcome === "success";
        await touch(w, { status: ok ? "done" : "failed", runId: state.run.id });
        if (!ok) {
          failedIds.add(w.id);
          if (n.failFast !== false) stop = true;
        }
      })().finally(() => inFlight.delete(w.id));
      inFlight.set(w.id, p);
    };

    const settled = (w: WorkItem) => done.has(w.id) || failedIds.has(w.id) || parked.has(w.id);
    for (;;) {
      if (ctx.signal.aborted) return failed("CANCELLED", "cancelled");
      // Items whose prerequisites failed (or are unknown) can never run.
      const blocked = items.filter((w) => !settled(w) && !inFlight.has(w.id) && w.dependsOn.some((d) => failedIds.has(depKey(d)) || !byId.has(depKey(d))));
      for (const w of blocked) {
        failedIds.add(w.id);
        await touch(w, { status: "blocked" });
      }
      const ready = items.filter((w) => !settled(w) && !inFlight.has(w.id) && w.dependsOn.every((d) => done.has(depKey(d)) && !failedIds.has(depKey(d))));
      if (!stop) for (const w of ready.slice(0, Math.max(0, concurrency - inFlight.size))) launch(w);
      if (inFlight.size === 0) {
        if (stop || items.every(settled) || ready.length === 0) break;
        continue;
      }
      await Promise.race(inFlight.values());
    }

    const paused = await pausedByChildren(ctx, [...parked.values()]);
    if (paused) return paused;
    const summary = items.map((w) => ({ id: w.id, slug: w.slug, status: done.has(w.id) && !failedIds.has(w.id) ? "done" : failedIds.has(w.id) ? "failed" : "skipped", runId: done.get(w.id)?.run.id }));
    await ctx.emit({ type: "vars.set", payload: { vars: { dispatched: summary } } });
    const failedCount = summary.filter((s) => s.status !== "done").length;
    if (failedCount > 0) return failed("RUN_STATE", `${failedCount} of ${items.length} work items did not complete`, { summary });
    return completed({ data: { summary } });
  },
};

export function assertWorkItemsExecutorsRegistered(types: string[]): void {
  for (const t of ["custom:materialize-work-items", "custom:dispatch-work-items"]) if (!types.includes(t)) throw new OrcaError("NOT_SUPPORTED", `${t} executor missing`);
}
