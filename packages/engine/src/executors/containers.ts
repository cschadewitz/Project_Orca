/**
 * Container executors: loop, parallel, subworkflow. Each iteration/branch is a
 * child run with its own event log; the parent step records child.spawned /
 * child.finished so the whole tree is traversable.
 */
import { INLINE_SEP } from "../orchestrator.js";
import type { LoopNode, ParallelNode, RunState, SubworkflowNode, SubworkflowRef } from "@orca/core";
import { completed, failed, paused, type NodeExecutor, type StepContext, type StepOutcome } from "./types.js";

function target(ctx: StepContext, ref: SubworkflowRef, suffix: string[]): { workflow: string } | { graph: import("@orca/core").WorkflowGraph; inlineId: string } {
  if ("workflow" in ref) return { workflow: ref.workflow };
  return { graph: ref.graph, inlineId: [ctx.definition.id, ctx.nodeId, ...suffix].join(INLINE_SEP) };
}

function childOutcome(states: RunState[]): { ok: boolean; data: Record<string, unknown> } {
  const ok = states.every((s) => s.run.status === "completed" && s.run.outcome === "success");
  return { ok, data: { children: states.map((s) => ({ runId: s.run.id, status: s.run.status, outcome: s.run.outcome, vars: s.run.vars })) } };
}

/**
 * When any child run parked at a human gate, the parent step parks too: it
 * records the children it is waiting on and returns a paused outcome. On
 * resume the node is re-attempted and `runChild` re-attaches to the same
 * children (finished ones return immediately, parked ones resume).
 */
export async function pausedByChildren(ctx: StepContext, states: RunState[]): Promise<StepOutcome | undefined> {
  const ids = states.filter((s) => s.run.status === "paused").map((s) => s.run.id);
  if (ids.length === 0) return undefined;
  await ctx.emit({ type: "step.waiting", payload: { stepRunId: ctx.step.id, on: "child-run", detail: ids.join(",") } });
  return paused(`${ids.length} child run(s) paused: ${ids.join(", ")}`, { childRunIds: ids });
}

export const loopExecutor: NodeExecutor<LoopNode> = {
  type: "loop",
  async execute(ctx): Promise<StepOutcome> {
    const n = ctx.node;
    const results: RunState[] = [];
    const items = n.mode === "forEach" ? ((await ctx.evaluate(n.items!)) as unknown) : undefined;
    const list = n.mode === "forEach" ? (Array.isArray(items) ? items : items && typeof items === "object" ? Object.values(items) : []) : undefined;
    const limit = n.mode === "forEach" ? Math.min(list!.length, n.maxIterations) : n.maxIterations;

    for (let i = 0; i < limit; i++) {
      if (ctx.signal.aborted) return failed("CANCELLED", "cancelled");
      const scope: Record<string, unknown> = { iteration: i, [n.indexVar]: i };
      if (n.mode === "forEach") scope[n.itemVar] = list![i];
      if (n.mode === "while" && !(await ctx.evaluate(n.condition!, scope))) break;
      await ctx.emit({ type: "loop.iteration", payload: { stepRunId: ctx.step.id, iteration: i, ...(n.mode === "forEach" ? { item: list![i] } : {}) } });
      const state = await ctx.runChild(target(ctx, n.body, []), { branch: String(i), vars: scope });
      const parked = await pausedByChildren(ctx, [state]);
      if (parked) return parked;
      results.push(state);
      const failedChild = state.run.status !== "completed" || state.run.outcome !== "success";
      if (failedChild && n.breakOnFailure) return failed("RUN_STATE", `loop iteration ${i} ${state.run.status} (${state.run.outcome ?? state.run.error?.message ?? ""})`, { childRunId: state.run.id });
      if (n.mode === "until" && (await ctx.evaluate(n.condition!, { ...scope, child: state }))) break;
    }
    const { ok, data } = childOutcome(results);
    return completed({ data: { ...data, iterations: results.length, ok } });
  },
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export const parallelExecutor: NodeExecutor<ParallelNode> = {
  type: "parallel",
  async execute(ctx): Promise<StepOutcome> {
    const n = ctx.node;
    let states: RunState[];
    if (n.branches) {
      const entries = Object.entries(n.branches);
      states = await mapLimit(entries, n.concurrency, ([name, ref]) => ctx.runChild(target(ctx, ref, [name]), { branch: name, vars: { branch: name } }));
    } else {
      const fe = n.forEach!;
      const items = await ctx.evaluate(fe.items);
      const list = Array.isArray(items) ? items : items && typeof items === "object" ? Object.values(items) : [];
      states = await mapLimit(list, n.concurrency, (item, i) => ctx.runChild(target(ctx, fe.body, []), { branch: String(i), vars: { [fe.itemVar]: item, [fe.indexVar]: i } }));
    }
    const parked = await pausedByChildren(ctx, states);
    if (parked) return parked;
    const { ok, data } = childOutcome(states);
    const anyOk = states.some((s) => s.run.status === "completed" && s.run.outcome === "success");
    if ((n.join === "all" && !ok) || (n.join === "any" && !anyOk)) return failed("RUN_STATE", `parallel '${ctx.nodeId}': ${states.filter((s) => s.run.outcome !== "success").length} of ${states.length} branches did not succeed`, data);
    return completed({ data: { ...data, ok } });
  },
};

export const subworkflowExecutor: NodeExecutor<SubworkflowNode> = {
  type: "subworkflow",
  async execute(ctx): Promise<StepOutcome> {
    const vars: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx.node.vars)) vars[k] = typeof v === "string" && v.startsWith("=") ? await ctx.evaluate(v.slice(1)) : v;
    const state = await ctx.runChild({ workflow: ctx.node.workflow }, { vars });
    const parked = await pausedByChildren(ctx, [state]);
    if (parked) return parked;
    const { ok, data } = childOutcome([state]);
    if (!ok) return failed("RUN_STATE", `subworkflow '${ctx.node.workflow}' ${state.run.status}: ${state.run.error?.message ?? state.run.outcome ?? ""}`, { childRunId: state.run.id });
    return completed({ data: { ...data, ok, childRunId: state.run.id, childVars: state.run.vars } });
  },
};
