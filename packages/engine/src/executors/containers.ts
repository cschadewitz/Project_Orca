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
import { evaluateVars, succeeded, type BranchSkipReason, type LoopNode, type ParallelForEach, type ParallelNode, type RunState, type SubworkflowNode, type SubworkflowRef } from "@orca/core";
import { completed, failed, paused, type NodeExecutor, type StepContext, type StepOutcome } from "./types.js";

function target(ctx: StepContext, ref: SubworkflowRef, suffix: string[]): { workflow: string } | { graph: import("@orca/core").WorkflowGraph; inlineId: string } {
  if ("workflow" in ref) return { workflow: ref.workflow };
  return { graph: ref.graph, inlineId: [ctx.definition.id, ctx.nodeId, ...suffix].join(INLINE_SEP) };
}

function childOutcome(states: RunState[]): { ok: boolean; data: Record<string, unknown> } {
  const ok = states.every(succeeded);
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

/** One branch of a fan-out: a stable key, what it waits for, and how to start it. */
interface Branch {
  key: string;
  dependsOn: string[];
  workItemId?: string;
  run: (signal: AbortSignal) => Promise<RunState>;
}

/** What became of a branch: a child run, or a reason it never started. */
interface BranchResult {
  state?: RunState;
  skipped?: BranchSkipReason;
}

/**
 * Run `branches` with at most `limit` in flight, honouring `dependsOn`: a branch starts only
 * once every key it depends on has succeeded, and is skipped (`dependency`) as soon as one of
 * them cannot - it failed, was itself skipped, or names a key this fan-out does not have. A
 * *parked* prerequisite decides nothing, so its dependants simply stay unstarted until the
 * step is re-attempted on resume.
 *
 * When `decided` reports that a finished branch already settled the caller's outcome, the
 * remaining branches are never started (`failFast`) and the ones still running are asked to
 * stop through the signal they were handed.
 */
async function runBranches(
  branches: Branch[],
  limit: number,
  decided: ((state: RunState, branch: Branch) => string | undefined) | undefined,
  onSkip: (branch: Branch, reason: BranchSkipReason) => Promise<void>,
): Promise<Map<string, BranchResult>> {
  const out = new Map<string, BranchResult>();
  const keys = new Set(branches.map((b) => b.key));
  const stop = new AbortController();
  const inFlight = new Map<string, Promise<void>>();
  let stopped = false;
  let failure: unknown;

  const settled = (key: string) => out.get(key)?.state;
  /** A dependency that can still be met: not yet resolved, or parked and waiting for a human. */
  const pending = (key: string) => keys.has(key) && !out.has(key);
  const met = (b: Branch) => b.dependsOn.every((d) => { const s = settled(d); return s !== undefined && succeeded(s); });
  const unmeetable = (b: Branch) => b.dependsOn.some((d) => { const r = out.get(d); return !keys.has(d) || (r !== undefined && !(r.state && (succeeded(r.state) || r.state.run.status === "paused"))); });
  const held = (b: Branch) => b.dependsOn.some((d) => pending(d) || settled(d)?.run.status === "paused");

  const launch = (b: Branch) => {
    const p = (async () => {
      const state = await b.run(stop.signal);
      out.set(b.key, { state });
      const reason = decided?.(state, b);
      if (reason !== undefined) {
        stopped = true;
        if (!stop.signal.aborted) stop.abort(reason);
      }
    })()
      .catch((e: unknown) => {
        failure ??= e;
        stopped = true;
        if (!stop.signal.aborted) stop.abort("a branch threw");
      })
      .finally(() => void inFlight.delete(b.key));
    inFlight.set(b.key, p);
  };

  for (;;) {
    // Cascade: skipping one branch can make its own dependants unmeetable, so iterate to a fixed point.
    for (let changed = true; changed; ) {
      changed = false;
      for (const b of branches) {
        if (out.has(b.key) || inFlight.has(b.key) || !unmeetable(b)) continue;
        out.set(b.key, { skipped: "dependency" });
        await onSkip(b, "dependency");
        changed = true;
      }
    }
    if (!stopped) {
      for (const b of branches) {
        if (inFlight.size >= limit) break;
        if (out.has(b.key) || inFlight.has(b.key) || !met(b)) continue;
        launch(b);
      }
    }
    if (inFlight.size === 0) break;
    await Promise.race(inFlight.values());
  }
  if (failure) throw failure;
  // Whatever is left never started: because failFast cut the fan-out short, or because a parked
  // prerequisite has not answered yet (those stay unrecorded - resume may still run them).
  // Recording one branch can release the next in a chain, so iterate to a fixed point here too.
  for (let changed = true; changed; ) {
    changed = false;
    for (const b of branches) {
      if (out.has(b.key) || held(b)) continue;
      const reason: BranchSkipReason = unmeetable(b) ? "dependency" : "failFast";
      out.set(b.key, { skipped: reason });
      await onSkip(b, reason);
      changed = true;
    }
  }
  return out;
}

export const parallelExecutor: NodeExecutor<ParallelNode> = {
  type: "parallel",
  async execute(ctx): Promise<StepOutcome> {
    const n = ctx.node;
    let branches: Branch[];
    if (n.branches) {
      branches = Object.entries(n.branches).map(([name, ref]) => ({
        key: name,
        dependsOn: [],
        run: (signal: AbortSignal) => ctx.runChild(target(ctx, ref, [name]), { branch: name, vars: { branch: name }, signal }),
      }));
    } else {
      branches = await forEachBranches(ctx, n.forEach!);
      const dup = branches.map((b) => b.key).find((k, i, all) => all.indexOf(k) !== i);
      if (dup !== undefined) return failed("WORKFLOW_INVALID", `parallel '${ctx.nodeId}': forEach.key is not unique ('${dup}' appears twice)`, {}, false);
    }

    /**
     * With `failFast` (the default) a branch that already settles the join stops the node:
     * `join: all` is lost the moment one branch does not succeed, `join: any` is won the
     * moment one does. A *parked* branch settles nothing - a human may still steer it to
     * success - so it never triggers the stop.
     */
    const decided = (s: RunState, b: Branch): string | undefined => {
      if (s.run.status === "paused") return undefined;
      const stop = n.join === "any" ? succeeded(s) : !succeeded(s);
      return stop ? `parallel '${ctx.nodeId}': branch '${b.key}' decided join '${n.join}' (failFast)` : undefined;
    };
    const results = await runBranches(branches, n.concurrency, n.failFast ? decided : undefined, (b, reason) =>
      ctx.emit({ type: "branch.skipped", payload: { stepRunId: ctx.step.id, branch: b.key, reason, ...(b.workItemId ? { workItemId: b.workItemId } : {}) } }),
    );

    const states = branches.map((b) => results.get(b.key)?.state).filter((s): s is RunState => s !== undefined);
    const notStarted = branches.length - states.length;
    /** Per branch, so a summary step (or a UI) can say what happened to each without reading the log. */
    const summary = branches.map((b) => {
      const r = results.get(b.key);
      return {
        branch: b.key,
        ...(b.workItemId ? { workItemId: b.workItemId } : {}),
        ...(r?.state ? { runId: r.state.run.id, status: r.state.run.status, ...(r.state.run.outcome ? { outcome: r.state.run.outcome } : {}), ok: succeeded(r.state) } : { status: r?.skipped === "dependency" ? "blocked" : "skipped", ok: false }),
      };
    });

    const parked = await pausedByChildren(ctx, states);
    if (parked) return parked;
    const { ok, data } = childOutcome(states);
    data.branches = summary;
    if (notStarted > 0) data.skipped = notStarted;
    const anyOk = states.some(succeeded);
    if ((n.join === "all" && (!ok || notStarted > 0)) || (n.join === "any" && !anyOk)) {
      const bad = states.filter((s) => !succeeded(s)).length;
      const blocked = summary.filter((s) => s.status === "blocked").length;
      const why = [blocked > 0 ? `${blocked} blocked by a dependency` : "", notStarted - blocked > 0 ? `${notStarted - blocked} not started: failFast` : ""].filter(Boolean).join(", ");
      return failed("RUN_STATE", `parallel '${ctx.nodeId}': ${bad} of ${branches.length} branches did not succeed${why ? ` (${why})` : ""}`, data);
    }
    return completed({ data: { ...data, ok } });
  },
};

/** Build the branches of a `forEach` fan-out, evaluating each per-item expression in the item's scope. */
async function forEachBranches(ctx: StepContext, fe: ParallelForEach): Promise<Branch[]> {
  const items = await ctx.evaluate(fe.items);
  const list = Array.isArray(items) ? items : items && typeof items === "object" ? Object.values(items) : [];
  const branches: Branch[] = [];
  for (const [i, item] of list.entries()) {
    const scope = { [fe.itemVar]: item, [fe.indexVar]: i };
    const str = async (expr: string | undefined): Promise<string | undefined> => {
      if (!expr) return undefined;
      const v = await ctx.evaluate(expr, scope);
      return v === undefined || v === null || v === "" ? undefined : String(v);
    };
    const key = (await str(fe.key)) ?? String(i);
    const deps = fe.dependsOn ? await ctx.evaluate(fe.dependsOn, scope) : [];
    const workItemId = await str(fe.workItemId);
    const workflow = await str(fe.workflow);
    const ref = workflow ? { workflow } : target(ctx, fe.body, []);
    branches.push({
      key,
      dependsOn: (Array.isArray(deps) ? deps : deps === undefined || deps === null || deps === "" ? [] : [deps]).map(String),
      ...(workItemId ? { workItemId } : {}),
      run: (signal: AbortSignal) => ctx.runChild(ref, { branch: key, vars: scope, ...(workItemId ? { workItemId } : {}), signal }),
    });
  }
  return branches;
}

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
