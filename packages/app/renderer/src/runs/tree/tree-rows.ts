/**
 * The run tree's arithmetic, with no React and no bridge in it: turn a run and the
 * `runs.get` projections under it into the flat list of rows a virtualiser draws, and fold
 * a `run.changed` or a `step.changed` into one of those projections.
 *
 * It is a plain module for the same reason `run-rows.ts` is: the parts most likely to be
 * wrong here are the grouping, the levels and the fold, and a DOM test reads all three
 * badly. What a tree *looks* like is `run-tree.tsx`'s; what a tree *is* is this.
 *
 * Three shapes worth knowing before changing anything:
 *
 * - **A row is a path, not an object.** `key` is the chain of ids from the root
 *   (`run-parent/s-fan/run-child-ok`), because the same run can appear twice in one tree —
 *   `runs.list` returns children as roots as well, and a loop can re-enter a node — and an
 *   expansion set keyed by id alone would open both at once.
 * - **The tree is flattened, not nested.** The list substrate windows over an array, so the
 *   hierarchy lives in `level` and in the order of the rows, exactly as `role="tree"`'s own
 *   flattened DOM does.
 * - **Attempts hang off the newest attempt.** A re-attempted node is one row — the highest
 *   attempt — with the earlier ones as `attempt` children, so a retried step does not
 *   double the height of the tree (#156).
 */
import type { RunStatus } from "@orca/design";
import type {
  ChildRunView,
  RunChangedParams,
  RunSummaryView,
  RunsGetResult,
  StepChangedParams,
  StepView,
} from "@orca/protocol";
import { applyRunChanged } from "../run-rows.js";

/**
 * What a row is. `note` is the fifth kind and is not in the run tree's original four: a
 * skipped fan-out branch never became a run, so it has no status and no duration, and
 * dressing it as a `child-run` with an invented status is what rule 12 forbids.
 */
export type TreeRowKind = "run" | "step" | "attempt" | "child-run" | "note";

export interface TreeRow {
  /** The chain of ids from the root, `/`-joined. Unique in one flattened tree. */
  key: string;
  kind: TreeRowKind;
  /** Depth from the root, 0-based. What `aria-level` would be, less one. */
  level: number;
  /**
   * How far the row is actually indented. Equal to `level` until `MAX_INDENT`, then fixed:
   * past six levels a step would otherwise start 200px from the edge, and the ancestor
   * chain moves to the sticky header instead (docs/design/30-long-running-content.md).
   */
  indent: number;
  /** Mono: a machine name — a run's name, a node id, a branch. */
  name: string;
  /**
   * Absent only on a `note` row. Every other row is a real object with one of the eight.
   */
  status?: RunStatus;
  /**
   * The row belongs to a dry run's tree (#183): every row of it, the root's steps and child
   * runs too, so each status chip in the tree reads "… · dry".
   */
  dry?: boolean;
  /** The run this row belongs to; for a `child-run` row, the child's own id. */
  runId: string;
  /** The step run this row is about, for the rows that are about one. */
  stepRunId?: string;
  /** "attempt 2 of 3" — set only when the node was attempted more than once. */
  attempt?: { n: number; of: number };
  agent?: string;
  /** Total for a finished object, elapsed-so-far for a live one (the daemon's `asOf`). */
  durationMs?: number;
  /** Set while the object is still going, so the row can tick rather than freeze. */
  startedAt?: string;
  /** Whether the object has stopped: a row with this does not tick. */
  finished?: boolean;
  /** The second half of a `note` row: why the branch never ran. */
  note?: string;
  /** The fan-out key a child run or a skipped branch came from. */
  branch?: string;
  hasChildren: boolean;
  expanded: boolean;
  /** Expanded, but its `runs.get` has not answered yet. */
  loading: boolean;
  /** The names above this row, root first — what the sticky header shows. */
  ancestors: readonly string[];
  /**
   * A running *run*: draws an indeterminate `.orca-meter`. There is no percentage and
   * there will not be one — a workflow graph with loops and conditional branches has no
   * completion fraction (docs/design/RULES.md rule 12, docs/design/60-implementation.md).
   */
  meter: boolean;
}

/** Past this many levels the tree stops indenting (docs/design/30-long-running-content.md). */
export const MAX_INDENT = 6;

/**
 * A stable DOM id per row; `aria-activedescendant` names it. The whitespace squeeze is for
 * the one part of a key that is not an id — a fan-out branch takes its name from the
 * workflow, and a branch called `auth perf` would otherwise make an id nothing can address.
 */
export const treeRowId = (key: string): string => `tree-row-${key.replace(/\s+/g, "_")}`;

/** What `buildTree` needs: the roots, whatever `runs.get` has answered, and what is open. */
export interface TreeInput {
  roots: readonly RunSummaryView[];
  /** `runs.get` results by run id. A run with no entry here has not been read yet. */
  details: ReadonlyMap<string, RunsGetResult>;
  /** Row keys that are open. */
  expanded: ReadonlySet<string>;
}

/** The statuses `F` keeps, and the two a person scrolling a long tree is looking for. */
const ATTENTION: readonly RunStatus[] = ["failed", "waiting"];

/**
 * One group of step runs: every attempt at one node, in one iteration of it. `runs.get`
 * returns the steps in scheduling order, so the first attempt seen fixes the group's
 * position and the highest attempt is the row that stands for it.
 */
interface StepGroup {
  nodeId: string;
  iteration: number | undefined;
  /** Ascending by attempt; the last is the one the tree shows. */
  attempts: readonly StepView[];
}

/**
 * Group a run's steps by node and iteration, keeping the order they were scheduled in.
 *
 * A loop's second iteration of `build` is a different group from its first — same
 * `nodeId`, different `iteration` — because they are different work and collapsing them
 * would hide a retry inside an iteration behind an iteration boundary.
 */
export function groupSteps(steps: readonly StepView[]): StepGroup[] {
  const groups = new Map<string, { nodeId: string; iteration: number | undefined; attempts: StepView[] }>();
  for (const step of steps) {
    const key = `${step.nodeId}#${step.iteration ?? ""}`;
    const group = groups.get(key) ?? { nodeId: step.nodeId, iteration: step.iteration, attempts: [] };
    group.attempts.push(step);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    attempts: [...group.attempts].sort((a, b) => a.attempt - b.attempt),
  }));
}

/** The flattened tree: roots, then whatever each open row reveals, in document order. */
export function buildTree(input: TreeInput): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const run of input.roots) {
    const from = rows.length;
    pushRun(rows, input, {
      key: run.id,
      level: 0,
      ancestors: [],
      runId: run.id,
      name: run.name,
      status: run.status,
      durationMs: run.durationMs,
      startedAt: run.startedAt,
      finished: run.finishedAt !== undefined,
      agent: run.agentId,
      kind: "run",
    });
    // A dry run's whole tree is simulated: children of a dry run are dry runs too.
    if (run.dryRun) for (let at = from; at < rows.length; at += 1) rows[at] = { ...rows[at]!, dry: true };
  }
  return rows;
}

/** The fields a run-ish row (a root or a child run) is drawn from. */
interface RunRowSeed {
  key: string;
  level: number;
  ancestors: readonly string[];
  runId: string;
  name: string;
  status: RunStatus;
  durationMs?: number | undefined;
  startedAt?: string | undefined;
  finished?: boolean | undefined;
  agent?: string | undefined;
  branch?: string | undefined;
  kind: "run" | "child-run";
}

function pushRun(rows: TreeRow[], input: TreeInput, seed: RunRowSeed): void {
  const expanded = input.expanded.has(seed.key);
  const detail = input.details.get(seed.runId);
  /* Unread is "may have children", not "has none": a run whose steps nobody has asked for
     still has to offer the twisty that asks for them. */
  const hasChildren = detail ? detail.steps.length > 0 : true;

  rows.push({
    key: seed.key,
    kind: seed.kind,
    level: seed.level,
    indent: Math.min(seed.level, MAX_INDENT),
    name: seed.name,
    status: seed.status,
    runId: seed.runId,
    ...(seed.durationMs === undefined ? {} : { durationMs: seed.durationMs }),
    ...(seed.startedAt === undefined ? {} : { startedAt: seed.startedAt }),
    ...(seed.finished === undefined ? {} : { finished: seed.finished }),
    ...(seed.agent === undefined ? {} : { agent: seed.agent }),
    ...(seed.branch === undefined ? {} : { branch: seed.branch }),
    hasChildren,
    expanded: expanded && hasChildren,
    loading: expanded && detail === undefined,
    ancestors: seed.ancestors,
    meter: seed.status === "running",
  });

  if (!expanded || !detail) return;
  pushSteps(rows, input, detail, seed.key, seed.level + 1, [...seed.ancestors, seed.name]);
}

/** A run's step groups, and under each open one its earlier attempts, children and skips. */
function pushSteps(
  rows: TreeRow[],
  input: TreeInput,
  detail: RunsGetResult,
  parentKey: string,
  level: number,
  ancestors: readonly string[],
): void {
  for (const group of groupSteps(detail.steps)) {
    const head = group.attempts[group.attempts.length - 1];
    if (!head) continue;
    const earlier = group.attempts.slice(0, -1);
    const key = `${parentKey}/${head.id}`;
    const expanded = input.expanded.has(key);
    const hasChildren = earlier.length > 0 || head.children.length > 0 || head.skippedBranches.length > 0;

    rows.push({
      key,
      kind: "step",
      level,
      indent: Math.min(level, MAX_INDENT),
      name: group.iteration === undefined ? head.nodeId : `${head.nodeId}[${group.iteration}]`,
      status: head.status,
      runId: detail.run.id,
      stepRunId: head.id,
      ...(group.attempts.length > 1 ? { attempt: { n: head.attempt, of: group.attempts.length } } : {}),
      ...(head.agentId === undefined ? {} : { agent: head.agentId }),
      ...(head.durationMs === undefined ? {} : { durationMs: head.durationMs }),
      ...(head.startedAt === undefined ? {} : { startedAt: head.startedAt }),
      finished: head.finishedAt !== undefined,
      hasChildren,
      expanded: expanded && hasChildren,
      loading: false,
      ancestors,
      // A step never carries the meter: the indeterminate bar says "this run is going",
      // and one per step would be a screen of animation saying nothing (#156).
      meter: false,
    });

    if (!expanded || !hasChildren) continue;
    const under = [...ancestors, head.nodeId];
    pushAttempts(rows, key, level + 1, under, group.attempts, earlier, detail.run.id);
    for (const child of head.children) pushChild(rows, input, child, key, level + 1, under);
    for (const skipped of head.skippedBranches) {
      rows.push({
        key: `${key}/!${skipped.branch}`,
        kind: "note",
        level: level + 1,
        indent: Math.min(level + 1, MAX_INDENT),
        name: skipped.branch,
        runId: detail.run.id,
        stepRunId: head.id,
        note: SKIP_REASONS[skipped.reason] ?? skipped.reason,
        branch: skipped.branch,
        hasChildren: false,
        expanded: false,
        loading: false,
        ancestors: under,
        meter: false,
      });
    }
  }
}

/**
 * Why a fan-out branch never became a run, in the words the design uses (rule 13).
 *
 * A word, not a colour and not a ninth status: the row says "skipped" and then says why,
 * so a greyscale screenshot reads and the eight statuses stay eight (rules 3 and 4).
 */
export const SKIP_REASONS: Record<string, string> = {
  dependency: "a dependency was not met",
  failFast: "a sibling failed first",
  claimed: "another run claimed it",
};

/** The word a `note` row shows where every other row shows its status glyph and word. */
export const SKIPPED_WORD = "skipped";

function pushAttempts(
  rows: TreeRow[],
  parentKey: string,
  level: number,
  ancestors: readonly string[],
  all: readonly StepView[],
  earlier: readonly StepView[],
  runId: string,
): void {
  // Newest earlier attempt first: attempt 2 of 3 is what a person reads after 3 of 3.
  for (const step of [...earlier].reverse()) {
    rows.push({
      key: `${parentKey}/${step.id}`,
      kind: "attempt",
      level,
      indent: Math.min(level, MAX_INDENT),
      name: step.nodeId,
      status: step.status,
      runId,
      stepRunId: step.id,
      attempt: { n: step.attempt, of: all.length },
      ...(step.agentId === undefined ? {} : { agent: step.agentId }),
      ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
      ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
      finished: step.finishedAt !== undefined,
      hasChildren: false,
      expanded: false,
      loading: false,
      ancestors,
      meter: false,
    });
  }
}

function pushChild(
  rows: TreeRow[],
  input: TreeInput,
  child: ChildRunView,
  parentKey: string,
  level: number,
  ancestors: readonly string[],
): void {
  pushRun(rows, input, {
    key: `${parentKey}/${child.runId}`,
    level,
    ancestors,
    runId: child.runId,
    name: child.name,
    status: child.status,
    ...(child.branch === undefined ? {} : { branch: child.branch }),
    kind: "child-run",
  });
}

/* ---------- moving about the tree ---------- */

/** Every row under `index`, which in a flattened tree is the run of deeper rows after it. */
export function descendants(rows: readonly TreeRow[], index: number): TreeRow[] {
  const from = rows[index];
  if (!from) return [];
  const out: TreeRow[] = [];
  for (let i = index + 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.level <= from.level) break;
    out.push(row);
  }
  return out;
}

/** The row `←` moves to from a collapsed row: the nearest shallower one above it. */
export function parentIndex(rows: readonly TreeRow[], index: number): number | undefined {
  const from = rows[index];
  if (!from || from.level === 0) return undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (rows[i]!.level < from.level) return i;
  }
  return undefined;
}

/**
 * `F`: the failed and the waiting, and the rows that lead to them.
 *
 * It filters what is *built* rather than what is in the store, which is the honest reading
 * of "failed and waiting descendants": a subtree nobody has expanded has not been read, and
 * a filter that claimed to have looked inside it would be claiming a read it never made.
 */
export function filterAttention(rows: readonly TreeRow[]): TreeRow[] {
  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (row.status === undefined || !ATTENTION.includes(row.status)) return;
    keep.add(index);
    // Its ancestors, so the kept row still hangs off something that says where it is.
    for (let level = row.level, i = index - 1; i >= 0 && level > 0; i -= 1) {
      if (rows[i]!.level < level) {
        keep.add(i);
        level = rows[i]!.level;
      }
    }
  });
  return rows.filter((_row, index) => keep.has(index));
}

/* ---------- folding a notification into a projection ---------- */

/**
 * `step.changed` into the run's `runs.get` projection.
 *
 * `step.scheduled` is the first a client hears of a step and carries enough to draw a new
 * row (`nodeId`, `nodeType`, `attempt`), so it inserts; every later transition only carries
 * what changed and so patches. The result is the same object when nothing moved, which is
 * what lets React skip the re-render — the tree must not repaint on a step it does not hold.
 */
export function applyStepChanged(detail: RunsGetResult, params: StepChangedParams): RunsGetResult {
  const at = detail.steps.findIndex((step) => step.id === params.stepRunId);

  if (at === -1) {
    if (params.nodeId === undefined || params.nodeType === undefined || params.attempt === undefined) return detail;
    const step: StepView = {
      id: params.stepRunId,
      runId: params.runId,
      nodeId: params.nodeId,
      nodeType: params.nodeType,
      attempt: params.attempt,
      ...(params.iteration === undefined ? {} : { iteration: params.iteration }),
      status: params.status,
      scheduledAt: params.at,
      inputArtifactIds: [],
      outputArtifactIds: [],
      children: [],
      skippedBranches: [],
    };
    return { ...detail, steps: [...detail.steps, step], lastSeq: Math.max(detail.lastSeq, params.seq) };
  }

  const current = detail.steps[at]!;
  const next: StepView = { ...current, status: params.status };
  if (params.error !== undefined) next.error = params.error;
  if (params.waitingOn !== undefined) next.waitingOn = params.waitingOn;
  // `step.started` is the only transition that gives a step a start, and an elapsed
  // duration has to count from something.
  if (next.startedAt === undefined && params.event === "step.started") next.startedAt = params.at;
  if (TERMINAL_STEP_EVENTS.includes(params.event)) {
    next.finishedAt = params.at;
    if (next.startedAt !== undefined) {
      // Two timestamps we hold, subtracted — not an estimate (rule 12). Clamped at zero so
      // a clock that stepped backwards costs a duration rather than printing a negative.
      next.durationMs = Math.max(0, Date.parse(params.at) - Date.parse(next.startedAt));
    }
  }

  const steps = [...detail.steps];
  steps[at] = next;
  return { ...detail, steps, lastSeq: Math.max(detail.lastSeq, params.seq) };
}

/** The `step.*` events after which a step is not going to move again on its own. */
export const TERMINAL_STEP_EVENTS: readonly string[] = [
  "step.completed",
  "step.failed",
  "step.cancelled",
  "step.skipped",
];

/** `run.changed` into a projection: the run itself when it is this one, else a child row. */
export function applyRunChangedToDetail(detail: RunsGetResult, params: RunChangedParams): RunsGetResult {
  if (detail.run.id === params.runId) {
    return { ...detail, run: applyRunChanged(detail.run, params), lastSeq: Math.max(detail.lastSeq, params.seq) };
  }

  let touched = false;
  const steps = detail.steps.map((step) => {
    if (!step.children.some((child) => child.runId === params.runId)) return step;
    touched = true;
    return {
      ...step,
      children: step.children.map((child) =>
        child.runId === params.runId
          ? { ...child, status: params.status, ...(params.outcome === undefined ? {} : { outcome: params.outcome }) }
          : child,
      ),
    };
  });
  return touched ? { ...detail, steps } : detail;
}
