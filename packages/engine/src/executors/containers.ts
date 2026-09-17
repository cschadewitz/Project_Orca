/**
 * Container executors: loop, parallel, subworkflow. Each iteration/branch is a
 * child run with its own event log; the parent step records child.spawned /
 * child.finished so the whole tree is traversable.
 *
 * Every child is spawned under a stable `branch` key (iteration index, branch
 * name) so that when an interrupted container step is re-attempted on resume,
 * `ctx.runChild` re-attaches to the children the interrupted attempt already
 * spawned instead of starting them again (see Orchestrator.runChild).
 */
import { INLINE_SEP } from "../orchestrator.js";
import { evaluateVars, type LoopNode, type ParallelNode, type RunState, type SubworkflowNode, type SubworkflowRef } from "@orca/core";
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

/**
 * Run `tasks` with at most `limit` in flight, in order. When `decided` reports that a
 * finished task already settled the caller's outcome, the remaining tasks are never
 * started and the ones still running are asked to stop through the signal they were
 * handed. Slots for tasks that never started stay `undefined`.
 */
async function runBounded<R>(tasks: ((signal: AbortSignal) => Promise<R>)[], limit: number, decided?: (result: R, i: number) => string | undefined): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(tasks.length);
  const stop = new AbortController();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length || stop.signal.aborted) return;
      const result = await tasks[i]!(stop.signal);
      out[i] = result;
      const reason = decided?.(result, i);
      if (reason !== undefined && !stop.signal.aborted) stop.abort(reason);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return out;
}

const succeeded = (s: RunState) => s.run.status === "completed" && s.run.outcome === "success";

export const parallelExecutor: NodeExecutor<ParallelNode> = {
  type: "parallel",
  async execute(ctx): Promise<StepOutcome> {
    const n = ctx.node;
    let branches: { branch: string; run: (signal: AbortSignal) => Promise<RunState> }[];
    if (n.branches) {
      branches = Object.entries(n.branches).map(([name, ref]) => ({ branch: name, run: (signal: AbortSignal) => ctx.runChild(target(ctx, ref, [name]), { branch: name, vars: { branch: name }, signal }) }));
    } else {
      const fe = n.forEach!;
      const items = await ctx.evaluate(fe.items);
      const list = Array.isArray(items) ? items : items && typeof items === "object" ? Object.values(items) : [];
      branches = list.map((item, i) => ({ branch: String(i), run: (signal: AbortSignal) => ctx.runChild(target(ctx, fe.body, []), { branch: String(i), vars: { [fe.itemVar]: item, [fe.indexVar]: i }, signal }) }));
    }

    /**
     * With `failFast` (the default) a branch that already settles the join stops the node:
     * `join: all` is lost the moment one branch does not succeed, `join: any` is won the
     * moment one does. A *parked* branch settles nothing - a human may still steer it to
     * success - so it never triggers the stop.
     */
    const decided = (s: RunState, i: number): string | undefined => {
      if (s.run.status === "paused") return undefined;
      const stop = n.join === "any" ? succeeded(s) : !succeeded(s);
      return stop ? `parallel '${ctx.nodeId}': branch '${branches[i]!.branch}' decided join '${n.join}' (failFast)` : undefined;
    };
    const results = await runBounded(
      branches.map((b) => b.run),
      n.concurrency,
      n.failFast ? decided : undefined,
    );
    const states = results.filter((s): s is RunState => s !== undefined);
    const skipped = results.length - states.length;

    const parked = await pausedByChildren(ctx, states);
    if (parked) return parked;
    const { ok, data } = childOutcome(states);
    if (skipped > 0) data.skipped = skipped;
    const anyOk = states.some(succeeded);
    if ((n.join === "all" && !ok) || (n.join === "any" && !anyOk)) {
      const bad = states.filter((s) => !succeeded(s)).length;
      return failed("RUN_STATE", `parallel '${ctx.nodeId}': ${bad} of ${branches.length} branches did not succeed${skipped > 0 ? ` (${skipped} not started: failFast)` : ""}`, data);
    }
    return completed({ data: { ...data, ok } });
  },
};

export const subworkflowExecutor: NodeExecutor<SubworkflowNode> = {
  type: "subworkflow",
  async execute(ctx): Promise<StepOutcome> {
    const vars = await evaluateVars(ctx.node.vars, (expr) => ctx.evaluate(expr));
    const state = await ctx.runChild({ workflow: ctx.node.workflow }, { vars });
    const parked = await pausedByChildren(ctx, [state]);
    if (parked) return parked;
    const { ok, data } = childOutcome([state]);
    if (!ok) return failed("RUN_STATE", `subworkflow '${ctx.node.workflow}' ${state.run.status}: ${state.run.error?.message ?? state.run.outcome ?? ""}`, { childRunId: state.run.id });
    return completed({ data: { ...data, ok, childRunId: state.run.id, childVars: state.run.vars } });
  },
};
