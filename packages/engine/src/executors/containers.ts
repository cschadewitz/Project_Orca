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
import { ownsClaim } from "@orca/store";
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
 * The mechanics every fan-out shares: at most `limit` children in flight, one AbortController
 * all of them are handed, and a latch that both stops new launches and cancels what is still
 * running once the outcome is decided.
 *
 * `parallel` drives it over a branch list known up front (`runBranches` below);
 * `custom:plan-dispatch` drives it over a ready set recomputed from the live plan on every wake
 * (`plan/executors.ts`). Cancellation and fail-fast therefore mean the same thing in both, and
 * are written once.
 */
export class FanOut {
  /** Handed to every child; aborted by `halt`, so a decided fan-out stops burning agent time. */
  readonly stop = new AbortController();
  private readonly running = new Map<string, Promise<void>>();
  private firstFailure: unknown;
  private halted = false;

  constructor(private readonly limit: number) {}

  get inFlight(): number {
    return this.running.size;
  }
  /** How many children may start right now - none once the fan-out is halted. */
  get slots(): number {
    return this.halted ? 0 : Math.max(0, this.limit - this.running.size);
  }
  get stopped(): boolean {
    return this.halted;
  }
  isRunning(key: string): boolean {
    return this.running.has(key);
  }
  keys(): string[] {
    return [...this.running.keys()];
  }

  /** Launch nothing more, and ask everything still running to stop through `stop.signal`. */
  halt(reason: string): void {
    this.halted = true;
    if (!this.stop.signal.aborted) this.stop.abort(reason);
  }

  /**
   * Start `body` under `key`. Everything `body` decides - `halt` included - is settled before
   * the promise `settled()` races resolves, so a caller woken by a child never acts on a
   * decision that child has not finished making.
   */
  launch(key: string, body: (signal: AbortSignal) => Promise<void>): void {
    const p = (async () => body(this.stop.signal))()
      .catch((e: unknown) => {
        this.firstFailure ??= e;
        this.halt("a branch threw");
      })
      .finally(() => void this.running.delete(key));
    this.running.set(key, p);
  }

  /** Resolve as soon as one child settles, or as soon as `wake` does (a poll, a plan change). */
  async settled(wake?: Promise<unknown>): Promise<void> {
    const waits: Promise<unknown>[] = [...this.running.values(), ...(wake ? [wake] : [])];
    if (waits.length) await Promise.race(waits);
  }

  /** Re-throw the first error a child threw, once the fan-out has drained. */
  throwIfFailed(): void {
    if (this.firstFailure !== undefined) throw this.firstFailure;
  }
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
  /** Last gate before a branch starts: `false` means another owner has it, so it is skipped (`claimed`). */
  claim: (branch: Branch) => Promise<boolean>,
): Promise<Map<string, BranchResult>> {
  const out = new Map<string, BranchResult>();
  const keys = new Set(branches.map((b) => b.key));
  const fan = new FanOut(limit);

  const settled = (key: string) => out.get(key)?.state;
  /** A dependency that can still be met: not yet resolved, or parked and waiting for a human. */
  const pending = (key: string) => keys.has(key) && !out.has(key);
  const met = (b: Branch) => b.dependsOn.every((d) => { const s = settled(d); return s !== undefined && succeeded(s); });
  const unmeetable = (b: Branch) => b.dependsOn.some((d) => { const r = out.get(d); return !keys.has(d) || (r !== undefined && !(r.state && (succeeded(r.state) || r.state.run.status === "paused"))); });
  const held = (b: Branch) => b.dependsOn.some((d) => pending(d) || settled(d)?.run.status === "paused");

  const launch = (b: Branch) =>
    fan.launch(b.key, async (signal) => {
      // Claimed here rather than up front: a branch that never becomes ready must not take
      // ownership of its work item, or it would block the dispatcher that can run it.
      if (!(await claim(b))) {
        out.set(b.key, { skipped: "claimed" });
        await onSkip(b, "claimed");
        return;
      }
      const state = await b.run(signal);
      out.set(b.key, { state });
      const reason = decided?.(state, b);
      if (reason !== undefined) fan.halt(reason);
    });

  for (;;) {
    // Cascade: skipping one branch can make its own dependants unmeetable, so iterate to a fixed point.
    for (let changed = true; changed; ) {
      changed = false;
      for (const b of branches) {
        if (out.has(b.key) || fan.isRunning(b.key) || !unmeetable(b)) continue;
        out.set(b.key, { skipped: "dependency" });
        await onSkip(b, "dependency");
        changed = true;
      }
    }
    for (const b of branches) {
      if (fan.slots === 0) break;
      if (out.has(b.key) || fan.isRunning(b.key) || !met(b)) continue;
      launch(b);
    }
    if (fan.inFlight === 0) break;
    await fan.settled();
  }
  fan.throwIfFailed();
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

/**
 * Take ownership of the work item a branch stands for, so that two fan-outs over the same items
 * cannot both launch it (two workspaces, two agent sessions, one WorkItem). A branch without a
 * work item needs no claim; a re-attempted or resumed step re-claims what it already owns, which
 * is what keeps `runChild`'s re-attach path working after a crash.
 */
async function claimWorkItem(ctx: StepContext, b: Branch): Promise<boolean> {
  if (!b.workItemId) return true;
  const held = await ctx.stores.claims.claim({ workItemId: b.workItemId, runId: ctx.run.id, branch: b.key, stepRunId: ctx.step.id, at: ctx.clock.isoNow() });
  if (ownsClaim(held, ctx.run.id, b.key)) return true;
  ctx.logger.warn("work item already claimed", { branch: b.key, workItemId: b.workItemId, owner: held.runId, ownerBranch: held.branch });
  return false;
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
      const built = await forEachBranches(ctx, n.forEach!);
      if (built.error) return failed("WORKFLOW_INVALID", `parallel '${ctx.nodeId}': ${built.error}`, {}, false);
      branches = built.branches;
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
    const results = await runBranches(
      branches,
      n.concurrency,
      n.failFast ? decided : undefined,
      (b, reason) => ctx.emit({ type: "branch.skipped", payload: { stepRunId: ctx.step.id, branch: b.key, reason, ...(b.workItemId ? { workItemId: b.workItemId } : {}) } }),
      (b) => claimWorkItem(ctx, b),
    );

    const states = branches.map((b) => results.get(b.key)?.state).filter((s): s is RunState => s !== undefined);
    const notStarted = branches.length - states.length;
    /** Per branch, so a summary step (or a UI) can say what happened to each without reading the log. */
    const summary = branches.map((b) => {
      const r = results.get(b.key);
      return {
        branch: b.key,
        ...(b.workItemId ? { workItemId: b.workItemId } : {}),
        ...(r?.state ? { runId: r.state.run.id, status: r.state.run.status, ...(r.state.run.outcome ? { outcome: r.state.run.outcome } : {}), ok: succeeded(r.state) } : { status: r?.skipped === "dependency" ? "blocked" : r?.skipped === "claimed" ? "claimed" : "skipped", ok: false }),
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
      const claimed = summary.filter((s) => s.status === "claimed").length;
      const why = [blocked > 0 ? `${blocked} blocked by a dependency` : "", claimed > 0 ? `${claimed} claimed by another run` : "", notStarted - blocked - claimed > 0 ? `${notStarted - blocked - claimed} not started: failFast` : ""].filter(Boolean).join(", ");
      return failed("RUN_STATE", `parallel '${ctx.nodeId}': ${bad} of ${branches.length} branches did not succeed${why ? ` (${why})` : ""}`, data);
    }
    return completed({ data: { ...data, ok } });
  },
};

/** Build the branches of a `forEach` fan-out, evaluating each per-item expression in the item's scope. */
async function forEachBranches(ctx: StepContext, fe: ParallelForEach): Promise<{ branches: Branch[]; error?: string }> {
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
    // `body` may be omitted when `workflow` names the target for every item (see program.yaml).
    if (!workflow && !fe.body) return { branches: [], error: `forEach.workflow resolved to nothing for item ${key} and there is no 'body' to fall back on` };
    const ref = workflow ? { workflow } : target(ctx, fe.body!, []);
    branches.push({
      key,
      dependsOn: (Array.isArray(deps) ? deps : deps === undefined || deps === null || deps === "" ? [] : [deps]).map(String),
      ...(workItemId ? { workItemId } : {}),
      run: (signal: AbortSignal) => ctx.runChild(ref, { branch: key, vars: scope, ...(workItemId ? { workItemId } : {}), signal }),
    });
  }
  return { branches };
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
