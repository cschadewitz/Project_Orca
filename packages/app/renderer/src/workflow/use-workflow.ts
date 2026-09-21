/**
 * The workflow viewer's data: one `workflows.get` for the graph, one `runs.get` for the run
 * overlaid on it, and pushes for everything after that.
 *
 * Three decisions worth knowing:
 *
 * - **The graph is read once, and again only when the daemon says the file changed.** A
 *   workflow is a file on disk, so a run moving is not news about it: re-reading sixteen
 *   nodes on every `step.changed` would be a poll with extra steps. `workflows.changed` is
 *   the one frame that *is* news about it, and it carries the id — so a viewer re-reads when
 *   the workflow it is showing is the one that changed, and not otherwise.
 * - **The overlay is pushed, never polled** (AGENTS.md). `run.changed` and `step.changed`,
 *   both filtered to the overlaid run, are what move it — and what arrives is a signal
 *   rather than a traversal, because the traversal is a projection `runs.get` computes and
 *   no notification carries. So a push means "ask once more", which is the one place this
 *   surface re-reads and is bounded by the pushes for one run.
 * - **The version a run is pinned to is a fact, and the definition drawn is a different
 *   fact.** ORCA records `workflowVersion` on the run but keeps no copy of that definition
 *   (`WorkflowView.versions`), so when they differ the viewer says both: the `◷ pinned` chip
 *   and a caption saying the graph on screen is the current definition rather than the one
 *   that ran. Asking `workflows.get` for the run's version would answer
 *   `WORKFLOW_NOT_FOUND`, and drawing an older graph would be inventing one (rule 12).
 */
import { useCallback, useEffect, useState } from "react";
import type { ProtocolError, RunSummaryView, RunTraversalView, WorkflowView } from "@orca/protocol";
import { useNotifications } from "../notifications-context.js";

export type WorkflowState =
  | { phase: "loading" }
  | { phase: "error"; error: ProtocolError }
  | { phase: "ready"; workflow: WorkflowView; asOf: string };

/** What a run did, once it has been read. The graph is usable long before this arrives. */
export interface WorkflowOverlay {
  run: RunSummaryView;
  /** One entry per *visit*, so a node retried twice is here twice. Empty is a legal answer. */
  traversal: readonly RunTraversalView[];
  /**
   * True when the daemon is older than protocol 1.7 and sent no traversal at all. The
   * difference matters: no traversal is "this daemon cannot say", an empty one is "the run
   * has not entered a node yet", and only the first is worth a sentence on screen.
   */
  unavailable: boolean;
}

export interface WorkflowFeed {
  state: WorkflowState;
  /** The overlaid run, once it has answered. Undefined while loading and when none is asked for. */
  overlay: WorkflowOverlay | undefined;
  /** Why the overlay could not be read — a run the daemon no longer has, most likely. */
  overlayError: ProtocolError | undefined;
  /** Re-read both. The error state's retry, and what a person reaches for after a blip. */
  reload: () => void;
}

export function useWorkflow(workflowId: string, runId?: string): WorkflowFeed {
  const stream = useNotifications();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<WorkflowState>({ phase: "loading" });
  /** Counts the `workflows.changed` frames for this workflow; the read depends on it. */
  const [definitionRevision, setDefinitionRevision] = useState(0);
  const [overlay, setOverlay] = useState<WorkflowOverlay | undefined>(undefined);
  const [overlayError, setOverlayError] = useState<ProtocolError | undefined>(undefined);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setState({ phase: "loading" });
    // No `version`: only the version on disk can be returned, so asking for another is the
    // one call guaranteed to fail (`WorkflowsGetParams`).
    void window.orca.workflows.get({ id: workflowId }).then((result) => {
      if (!live) return;
      setState(
        result.ok
          ? { phase: "ready", workflow: result.result.workflow, asOf: result.result.asOf }
          : { phase: "error", error: result.error },
      );
    });
    return () => {
      live = false;
    };
  }, [workflowId, attempt, definitionRevision]);

  /* The definition's own push. No `runId` filter — `workflows.changed` is about a file and
     carries none — and the id check is here rather than in the filter for the same reason:
     the stream filters by run, and a workflow is not a run. */
  useEffect(() => {
    return stream.on("workflows.changed", (params) => {
      if (params.id === workflowId) setDefinitionRevision((n) => n + 1);
    });
  }, [stream, workflowId]);

  /* The overlay, and the one re-read this surface does. `revision` counts the pushes for
     this run; the effect below depends on it, so a push is "read the projection again" and
     never a second subscription or a timer. */
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setRevision(0);
    setOverlay(undefined);
    setOverlayError(undefined);
  }, [runId]);

  useEffect(() => {
    if (runId === undefined) return;
    const bump = (): void => setRevision((n) => n + 1);
    // Filtered to this run: a push about any other run is not this overlay's business, and
    // the filter is what keeps a canvas from re-reading on every run in the store.
    const offRun = stream.on("run.changed", bump, { runId });
    const offStep = stream.on("step.changed", bump, { runId });
    return () => {
      offRun();
      offStep();
    };
  }, [stream, runId]);

  useEffect(() => {
    if (runId === undefined) return;
    let live = true;
    void window.orca.runs.get({ runId }).then((result) => {
      if (!live) return;
      if (result.ok) {
        setOverlayError(undefined);
        setOverlay({
          run: result.result.run,
          traversal: result.result.traversal ?? [],
          unavailable: result.result.traversal === undefined,
        });
      } else {
        setOverlay(undefined);
        setOverlayError(result.error);
      }
    });
    return () => {
      live = false;
    };
  }, [runId, revision, attempt]);

  return { state, overlay, overlayError, reload };
}

/**
 * What the overlay says about one node, folded from the visits to it.
 *
 * The rule for a node visited more than once is "the last visit wins, except that a failure
 * on the way is still a failure the person has to see" — which is why `attempts` is here
 * beside `status` rather than instead of it: `build` that failed once and then succeeded is
 * a succeeded node with two attempts, and the attempt count is the whole of what says the
 * first one happened. The run tree is where the failed attempt is a row of its own.
 */
export interface NodeOverlay {
  status: RunTraversalView["status"];
  attempts: number;
  /** The last visit's step run, which is the one a click would open. */
  stepRunId: string;
  /** Child runs this node spawned, across every visit: a `parallel`'s branches, a subworkflow. */
  childRunIds: readonly string[];
}

/** The traversal folded to one entry per node, and the set of edges the run actually took. */
export interface OverlayIndex {
  nodes: ReadonlyMap<string, NodeOverlay>;
  /** `from→to` for every edge a visit arrived on — `edgeKey` in `layout.ts` spells it. */
  edges: ReadonlySet<string>;
  /** The node the run is at now: the last visit that has not ended. Undefined for a finished run. */
  current: string | undefined;
}

export function indexTraversal(traversal: readonly RunTraversalView[]): OverlayIndex {
  const nodes = new Map<string, NodeOverlay>();
  const edges = new Set<string>();
  let current: string | undefined;

  for (const visit of traversal) {
    const seen = nodes.get(visit.nodeId);
    nodes.set(visit.nodeId, {
      status: visit.status,
      // The attempt number the daemon stamped, not a count of entries: a traversal may be a
      // page of a longer one, and `attempt` is the run's own number for the visit.
      attempts: Math.max(visit.attempt, seen?.attempts ?? 0),
      stepRunId: visit.stepRunId,
      childRunIds: [...(seen?.childRunIds ?? []), ...(visit.childRunIds ?? [])],
    });
    if (visit.viaEdge) edges.add(`${visit.viaEdge.from}→${visit.viaEdge.to}`);
    /* The current node is the last visit still open. `endedAt` is what says a visit closed —
       a status of `running` on a visit that has ended is a projection of a moment that has
       passed, and the last unclosed visit is the one a person means by "where is it". */
    if (visit.endedAt === undefined) current = visit.nodeId;
  }

  return { nodes, edges, current };
}
