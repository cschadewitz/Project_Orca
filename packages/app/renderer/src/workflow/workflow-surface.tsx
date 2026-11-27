/**
 * The workflow viewer (#177): a read-only graph of a workflow, and the same graph with a run
 * overlaid so the path it took is visible.
 *
 * The shape is `renderer/src/runs/`'s — the arithmetic in a plain module with a plain test
 * (`layout.ts`), the data in one hook (`use-workflow.ts`), the markup composed from `ui/`.
 * What is particular to this one:
 *
 * - **Nothing here writes; the editor does.** The viewer offers no control that changes a
 *   file. **Edit** (or **Continue editing**, when a draft exists) swaps the body for the
 *   visual editor (#181, `editor/workflow-editor.tsx`), which edits a draft and publishes
 *   only on an explicit, reviewed confirmation. The button is absent - not disabled - when
 *   this daemon has no draft methods, which is the file-mode rule (docs/design/40).
 * - **The version is said twice when it has to be.** A run is pinned to the workflow version
 *   it started with, and ORCA keeps no copy of that definition — so when the overlaid run's
 *   version is not the one on disk the header carries the `◷ pinned` chip *and* a caption
 *   saying the graph drawn is the current definition rather than the run's. Drawing an older
 *   graph is not an option the runtime offers (docs/design/70-workflow-editing.md:93-99), and
 *   a chip on its own would leave a person believing they were looking at what ran.
 * - **The overlay picker lists runs of this workflow, filtered here.** `runs.list` has no
 *   `workflowId` parameter (`RunsListParams` — status, request, work item, parent, roots),
 *   so this is a filter over the page the daemon answered and the count says so. It is not a
 *   parameter this surface invented.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { ConnectionState } from "@orca/design";
import type { RunSummaryView, WorkflowNodeView } from "@orca/protocol";
import { PaneSplitter } from "../chrome/pane-splitter.js";
import { useMethodPresent } from "../chrome/use-connection.js";
import {
  Button,
  Chip,
  KeyValueList,
  Menu,
  StateView,
  StatusChip,
  Text,
  textClass,
  type Crumb,
  type MenuItem,
} from "../ui/index.js";
import { WorkflowEditor } from "./editor/workflow-editor.js";
import { findNode } from "./layout.js";
import { WorkflowCanvas } from "./workflow-canvas.js";
import { counted } from "../ui/count.js";
import { indexTraversal, useWorkflow } from "./use-workflow.js";
import { NoDaemonView } from "../first-run/no-daemon-view.js";
import "./workflow.css";

export interface WorkflowSurfaceProps {
  workflowId: string;
  /** The run to overlay, from `orca://workflow/<name>?run=<id>` or from the picker. */
  runId?: string | undefined;
  /** `orca://workflow/<name>?edit`: open on the editor rather than the viewer (#181). */
  edit?: boolean;
  connection: ConnectionState;
  /** The crumbs and the header controls, handed up for the chrome to draw (as Runs does). */
  onHeader?: (header: { crumbs: readonly Crumb[]; actions: ReactNode }) => void;
  /** Open an `orca://` URL: the editor's "Open in Runs" for a dry run (#183). */
  onOpen?: ((url: string) => void) | undefined;
}

export function WorkflowSurface({
  workflowId,
  runId,
  edit = false,
  connection,
  onHeader,
  onOpen,
}: WorkflowSurfaceProps): JSX.Element {
  /* The run being overlaid: the URL's until a person picks another, and then theirs. A URL
     that arrives afterwards wins again, which is what the effect's dependency says. */
  const [picked, setPicked] = useState<string | undefined>(runId);
  useEffect(() => setPicked(runId), [runId]);

  const { state, overlay, overlayError, reload } = useWorkflow(workflowId, picked);
  const [editing, setEditing] = useState(edit);
  useEffect(() => {
    if (edit) setEditing(true);
  }, [edit]);
  const { editable, hasDraft, refresh: refreshDraft } = useDraftPresence(workflowId, editing);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const runs = useWorkflowRuns(workflowId);

  const toggleExpanded = useCallback((nodeId: string) => {
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(nodeId)) next.add(nodeId);
      return next;
    });
  }, []);

  const workflow = state.phase === "ready" ? state.workflow : undefined;
  const index = useMemo(() => (overlay ? indexTraversal(overlay.traversal) : undefined), [overlay]);

  /* Pinned is a comparison of two facts the daemon sent: the version the run recorded, and
     the version of the definition on disk. Neither is derived and neither is guessed. */
  const pinned = overlay !== undefined && workflow !== undefined && overlay.run.workflowVersion !== workflow.version;

  const crumbs = useMemo<readonly Crumb[]>(
    () => (workflow ? [{ type: "workflow" as const, id: workflow.id, label: workflow.name, current: true }] : []),
    [workflow],
  );

  /* Memoised, because it is handed up into the chrome's state: a fresh element on every
     render would be a fresh `onHeader` call on every render, which is a loop. */
  const actions = useMemo(
    () =>
      workflow ? (
        <div className="orca-wf__actions">
          {/* `ai-sdlc v11` — the version shown wherever a run's workflow is named. */}
          <span className={`orca-id ${textClass("mono-id")}`}>{`${workflow.id} v${workflow.version}`}</span>
          {pinned && !editing && (
            <span className={`orca-pinned ${textClass("caption")}`}>
              <span aria-hidden="true">◷</span> pinned
            </span>
          )}
          {editing ? (
            <Text style="caption">Editing a draft</Text>
          ) : (
            editable && (
              <Button size="sm" tone={hasDraft ? "primary" : "default"} onClick={() => setEditing(true)}>
                {hasDraft ? "Continue editing" : "Edit"}
              </Button>
            )
          )}
          {!editing && (
            <Menu
              label="Overlay a run"
              items={runOptions(runs, picked)}
              onChoose={(item) => setPicked(item.id === NO_RUN ? undefined : item.id)}
              triggerClassName={`orca-button orca-button--ghost orca-button--sm ${textClass("label")}`}
            >
              {picked === undefined ? "No run overlaid" : "Change the run"}
            </Menu>
          )}
        </div>
      ) : null,
    [workflow, pinned, runs, picked, editing, editable, hasDraft],
  );

  /* Handed up rather than drawn here: the object header is the chrome's, on every screen
     that has an object, and there is one breadcrumb in the app. Through a ref, so a chrome
     that rebuilds its callback does not re-report on every frame. */
  const report = useRef(onHeader);
  report.current = onHeader;
  useEffect(() => report.current?.({ crumbs, actions }), [crumbs, actions]);

  if (state.phase === "loading") return <StateView kind="loading" title="Loading the workflow" />;
  if (state.phase === "error" || workflow === undefined) {
    const error = state.phase === "error" ? state.error : undefined;
    return connection === "live" ? (
      <StateView
        kind="error"
        title="Could not load the workflow"
        body={error ? `${error.code}: ${error.message}` : workflowId}
        action={{ label: "Try again", onClick: reload }}
      />
    ) : (
      <NoDaemonView title="No daemon to read this workflow from" onRetry={reload} />
    );
  }

  /* Definition reads do not own the draft or its uncommitted inspector text. Keep the
     editor in the same position through refresh success/refusal, and say that the file
     changed without treating the new viewer snapshot as a new draft base. */
  const definitionNotice = state.phase === "ready" && (
    <>
      {(state.refreshing || state.refreshError || (editing && state.changed)) && (
        <div className={`orca-banner ${textClass("caption")} orca-banner--stale`} role="status">
          <Text style="caption">
            {state.refreshing
              ? "Refreshing the workflow definition…"
              : state.refreshError
                ? `Could not refresh the workflow definition: ${state.refreshError.code}: ${state.refreshError.message}`
                : "The workflow definition changed."}
            {editing && state.changed && " This draft keeps its original base; review and publish will check it."}
          </Text>
          {state.refreshError && (
            <Button size="sm" onClick={reload}>
              Try again
            </Button>
          )}
        </div>
      )}
    </>
  );

  if (editing)
    return (
      <div className="orca-wf">
        {definitionNotice}
        <WorkflowEditor
          workflowId={workflowId}
          onClose={() => {
            setEditing(false);
            refreshDraft();
          }}
          onPublished={() => {
            setEditing(false);
            refreshDraft();
            reload();
          }}
          onOpen={onOpen}
        />
      </div>
    );

  /* Across the nested graphs too (#177): clicking a node inside an expanded `parallel` branch
     selects it, and a lookup over `workflow.nodes` alone would leave the inspector saying
     "select a node" about the node just selected. One selection, wherever the node lives. */
  const node = findNode(workflow, selected);

  return (
    <div className="orca-wf">
      {definitionNotice}
      {connection !== "live" && (
        <div className={`orca-banner ${textClass("caption")} orca-banner--stale`} role="status">
          <Text style="caption">Not connected — this is the last the daemon said about this workflow.</Text>
        </div>
      )}

      {/* The control rail: what is overlaid, and the legend for the strokes below it. */}
      <div className={`orca-graphctl ${textClass("caption")}`}>
        <span className="orca-graphctl__set">
          <Text style="caption">
            {overlay ? `Run ${overlay.run.name} overlaid` : "No run overlaid — this is the definition"}
          </Text>
          {overlay && <StatusChip status={overlay.run.status} />}
        </span>
        {pinned && overlay && (
          /* Both facts, in words. The chip says the run is on an older version; this says
             what is on screen instead, because ORCA cannot execute or produce an older
             definition and a viewer that implied otherwise would be inventing one. */
          <Text style="caption">
            {`This run is pinned to v${overlay.run.workflowVersion}. The graph drawn is v${workflow.version}, the definition on disk — ORCA keeps no copy of the one that ran.`}
          </Text>
        )}
        {overlay?.unavailable === true && (
          <Text style="caption">This daemon does not send a run&rsquo;s path, so nothing is overlaid.</Text>
        )}
        {overlayError && <Text style="caption">{`That run could not be read: ${overlayError.code}.`}</Text>}
        <span className="orca-legend">
          <span className="orca-legend__swatch orca-legend__swatch--active" aria-hidden="true" />
          <Text style="caption">taken</Text>
        </span>
        <span className="orca-legend">
          <span className="orca-legend__swatch orca-legend__swatch--soft" aria-hidden="true" />
          <Text style="caption">not taken</Text>
        </span>
        {/* The third stroke on the canvas, and it was the one with no word beside it: a back
            edge is dotted where an untaken edge is dashed, and two dashed strokes meaning
            two different things is what rule 4 forbids. */}
        <span className="orca-legend">
          <span className="orca-legend__swatch orca-legend__swatch--back" aria-hidden="true" />
          <Text style="caption">loops back</Text>
        </span>
      </div>

      <div className="orca-wf__body">
        <WorkflowCanvas
          workflow={workflow}
          overlay={index}
          selected={selected}
          onSelect={setSelected}
          expanded={expanded}
          onToggleExpanded={toggleExpanded}
          label={`${workflow.name} graph`}
        />
        {/* The inspector's boundary (#276). It shares the docked panel's id, and so its
            remembered width: they are the same kind of column, which is the decision the
            `panel-width` token had already made for their defaults. The canvas beside it pans on
            a drag of its own, and the splitter keeps the gesture from reaching it. */}
        <PaneSplitter boundary="panel" label="Resize the node inspector" />
        <Inspector node={node} />
      </div>
    </div>
  );
}

/**
 * Whether this workflow can be edited here, and whether a draft of it is waiting. Asked of
 * the daemon (`workflowDrafts.get`) rather than assumed: a workflow from a managed release or
 * outside the configuration directory is viewable and not editable, and says so.
 */
function useDraftPresence(
  workflowId: string,
  editing: boolean,
): { editable: boolean; hasDraft: boolean; refresh: () => void } {
  const present = useMethodPresent("workflowDrafts.open");
  const [state, setState] = useState({ editable: false, hasDraft: false });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const bridge = window.orca.workflowDrafts;
    if (!bridge || !present || editing) return;
    let live = true;
    void bridge.call("workflowDrafts.get", { workflowId }).then((result) => {
      if (!live) return;
      setState(
        result.ok
          ? { editable: result.result.editable, hasDraft: result.result.draft !== null }
          : { editable: false, hasDraft: false },
      );
    });
    return () => {
      live = false;
    };
  }, [workflowId, present, editing, generation]);
  return {
    editable: present && state.editable,
    hasDraft: state.hasDraft,
    refresh: () => setGeneration((n) => n + 1),
  };
}

/** The menu row for "no run at all", which is a choice and not an empty list. */
const NO_RUN = " none";

function runOptions(runs: readonly RunSummaryView[], picked: string | undefined): readonly MenuItem[] {
  const rows: MenuItem[] = [
    { id: NO_RUN, label: "No run — the definition only", ...(picked === undefined ? { hint: "shown" } : {}) },
  ];
  for (const run of runs) {
    rows.push({
      id: run.id,
      label: run.name,
      // Runs of one workflow are usually called the same thing, so the name is followed by
      // the run's id token — the one thing that tells two of them apart.
      labelId: run.id,
      // The status word and the version the run is pinned to: the two facts that decide
      // which of a dozen runs a person meant. In mono, never re-cased: `v3` is ORCA's.
      hintMachine: `${run.status} · v${run.workflowVersion}`,
    });
  }
  return rows;
}

/**
 * The runs of this workflow, for the overlay picker.
 *
 * One `runs.list` and a local filter, because the wire has no `workflowId` parameter. No
 * subscription: a run appearing while the menu is shut is not something this surface has to
 * notice, and the overlaid run's own changes are `use-workflow.ts`'s.
 */
function useWorkflowRuns(workflowId: string): readonly RunSummaryView[] {
  const [runs, setRuns] = useState<readonly RunSummaryView[]>([]);
  useEffect(() => {
    let live = true;
    void window.orca.runs.list().then((result) => {
      if (!live) return;
      setRuns(result.ok ? result.result.runs.filter((run) => run.workflowId === workflowId) : []);
    });
    return () => {
      live = false;
    };
  }, [workflowId]);
  return runs;
}

/**
 * The selected node's configuration, as the daemon flattened it for display.
 *
 * `fields` is `unknown`-valued on purpose — "a `custom:<name>` node is a plugin's, and the
 * protocol has nothing true to say about its shape" — so a value that is not a string is
 * printed as JSON rather than coerced into a sentence the node never said. It is a
 * `KeyValueList`, the display a run's variables use: a key in mono, a scalar on the line, and
 * an object or an array — a gate's `options`, an agent's `completion` — as its indented JSON
 * in a well, clamped, rather than one compact line nobody could read. Keyed by the node, so a
 * block opened on one node is not still open on the next.
 */
function Inspector({ node }: { node: WorkflowNodeView | undefined }): JSX.Element {
  if (!node) {
    return (
      <aside className="orca-wf__inspector" aria-label="Node detail">
        <Text style="caption">Select a node to see what it is configured with.</Text>
      </aside>
    );
  }
  return (
    <aside className="orca-wf__inspector" aria-label={`Node detail: ${node.name ?? node.id}`}>
      <h2 className={`orca-wf__inspector-name ${textClass("mono-strong")}`}>{node.name ?? node.id}</h2>
      {/* A run of chips, so it wraps: a plugin's `custom:<name>` kind beside the attempts
          is wider than the inspector at its narrowest. */}
      <div className="orca-wf__inspector-meta orca-chips">
        <Chip>{node.type}</Chip>
        {node.maxAttempts !== undefined && <Chip>{`up to ${counted(node.maxAttempts, "attempt")}`}</Chip>}
      </div>
      {node.description !== undefined && <Text style="caption">{node.description}</Text>}
      {Object.keys(node.fields).length === 0 ? (
        <Text style="caption">This node type carries no configuration.</Text>
      ) : (
        <KeyValueList key={node.id} values={node.fields} className="orca-wf__fields" />
      )}
    </aside>
  );
}
