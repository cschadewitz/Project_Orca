/**
 * The Workflows surface: every registered workflow, and the way into its viewer and editor.
 *
 * Before it, a workflow was reachable only by link, by a run's "the workflow it executes", or
 * from the palette - so a workflow nothing had run yet could not be reached from the rail at
 * all. Each row says what the workflow is (name, id, version, size), whether somebody has a
 * draft of it open, and offers **Open** (the viewer) and **Edit** (the editor on its draft,
 * `orca://workflow/<id>?edit`). Both are links through the route table, so a row is the same
 * act as the palette row or a pasted URL (#165).
 *
 * **Edit is absent, not disabled, where it cannot work** - a daemon with no draft methods, or
 * a workflow the daemon says is not editable here (a managed release, a file outside the
 * configuration directory) - the file-mode rule (docs/design/40). Where it is absent for a
 * reason the daemon gave, the row says the reason.
 */
import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import type { ConnectionState } from "@orca/design";
import type { ProtocolError, WorkflowSummaryView } from "@orca/protocol";
import { useMethodPresent } from "../chrome/use-connection.js";
import { useNotifications } from "../notifications-context.js";
import { workflowEditUrl, workflowUrl } from "../route-table.js";
import { Button, StateView, Text, counted, textClass, type Crumb } from "../ui/index.js";
import "./workflow.css";

export interface WorkflowsSurfaceProps {
  connection: ConnectionState;
  /** The route table's opener. */
  onOpen: (url: string) => void;
  /** The chrome's header: this surface has no object, so it hands up none. */
  onHeader?: (header: { crumbs: readonly Crumb[]; actions: ReactNode }) => void;
}

type ListState =
  | { phase: "loading" }
  | { phase: "error"; error: ProtocolError }
  | { phase: "ready"; workflows: readonly WorkflowSummaryView[] };

/** What the daemon says about editing one workflow. */
interface DraftFacts {
  editable: boolean;
  reason?: string;
  draft?: { owner: string; you: boolean };
}

export function WorkflowsSurface({ connection, onOpen, onHeader }: WorkflowsSurfaceProps): JSX.Element {
  const stream = useNotifications();
  const editing = useMethodPresent("workflowDrafts.open") && window.orca.workflowDrafts !== undefined;
  const [state, setState] = useState<ListState>({ phase: "loading" });
  const [drafts, setDrafts] = useState<ReadonlyMap<string, DraftFacts>>(new Map());
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /* No object, so no crumbs: and saying so replaces whatever the viewer last reported. */
  const report = useRef(onHeader);
  report.current = onHeader;
  useEffect(() => report.current?.({ crumbs: [], actions: null }), []);

  useEffect(() => {
    let live = true;
    void window.orca.workflows.list().then((result) => {
      if (!live) return;
      setState(
        result.ok ? { phase: "ready", workflows: result.result.workflows } : { phase: "error", error: result.error },
      );
    });
    return () => {
      live = false;
    };
  }, [attempt]);

  /* A publish, or an Apply that changed the workflow set, re-reads the list. */
  useEffect(() => stream.on("workflows.changed", () => reload()), [stream, reload]);

  /* One `workflowDrafts.get` per workflow: whether it can be edited here, and whose draft is
     open. A handful of workflows is the expected case; the reads go out together. */
  const ids = state.phase === "ready" ? state.workflows.map((w) => w.id).join("\u0001") : "";
  useEffect(() => {
    const bridge = window.orca.workflowDrafts;
    if (!editing || !bridge || ids === "") {
      setDrafts(new Map());
      return;
    }
    let live = true;
    void Promise.all(
      ids.split("\u0001").map(async (id): Promise<[string, DraftFacts]> => {
        const result = await bridge.call("workflowDrafts.get", { workflowId: id });
        if (!result.ok) return [id, { editable: false }];
        const { editable, reason, draft } = result.result;
        return [
          id,
          {
            editable,
            ...(reason !== undefined ? { reason } : {}),
            ...(draft ? { draft: { owner: draft.owner.principalId, you: draft.owner.you } } : {}),
          },
        ];
      }),
    ).then((entries) => {
      if (live) setDrafts(new Map(entries));
    });
    return () => {
      live = false;
    };
  }, [editing, ids, attempt]);

  if (state.phase === "loading") return <StateView kind="loading" title="Loading the workflows" />;
  if (state.phase === "error")
    return connection === "live" ? (
      <StateView
        kind="error"
        title="Could not list the workflows"
        body={`${state.error.code}: ${state.error.message}`}
        action={{ label: "Try again", onClick: reload }}
      />
    ) : (
      <StateView
        kind="disconnected"
        title="No daemon to list workflows from"
        body="Start one with orca serve, then try again."
        action={{ label: "Try again", onClick: reload }}
      />
    );
  if (state.workflows.length === 0)
    return (
      <StateView
        kind="empty"
        title="No workflows are configured"
        body="Add workflow files to the paths the configuration's workflows setting names, then Apply."
      />
    );

  return (
    <div className="orca-wflist">
      <header className="orca-wflist__head">
        <h1 className={`orca-wflist__title ${textClass("heading")}`}>Workflows</h1>
        <Text style="caption">{counted(state.workflows.length, "workflow")}</Text>
      </header>
      <div className="orca-wflist__scroll">
        <table className="orca-table orca-wflist__table">
          <thead>
            <tr>
              <th scope="col">Workflow</th>
              <th scope="col">Version</th>
              <th scope="col" className="orca-table__num">
                Nodes
              </th>
              <th scope="col">Draft</th>
              <th scope="col">
                <span className="orca-visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {state.workflows.map((workflow) => {
              const facts = drafts.get(workflow.id);
              const canEdit = editing && facts?.editable === true;
              return (
                <tr key={workflow.id}>
                  <td>
                    <div className="orca-wflist__name">
                      <span className={textClass("body-strong")}>{workflow.name}</span>
                      <span className={`orca-id ${textClass("mono-id")}`}>{workflow.id}</span>
                    </div>
                    {workflow.description !== undefined && (
                      <Text style="caption" className="orca-wflist__description">
                        {workflow.description}
                      </Text>
                    )}
                  </td>
                  <td className={textClass("mono-id")}>{`v${workflow.version}`}</td>
                  <td className={`orca-table__num ${textClass("mono-id")}`}>{workflow.nodeCount}</td>
                  <td>
                    <Text style="caption">
                      {facts?.draft
                        ? facts.draft.you
                          ? "Your draft is open"
                          : `${facts.draft.owner} has a draft open`
                        : editing && facts !== undefined && !facts.editable && facts.reason !== undefined
                          ? facts.reason
                          : "—"}
                    </Text>
                  </td>
                  <td>
                    <div className="orca-wflist__actions">
                      <Button size="sm" tone="ghost" onClick={() => onOpen(workflowUrl(workflow.id))}>
                        Open
                      </Button>
                      {canEdit && (
                        <Button
                          size="sm"
                          tone={facts.draft?.you ? "primary" : "default"}
                          onClick={() => onOpen(workflowEditUrl(workflow.id))}
                        >
                          {facts.draft?.you ? "Continue editing" : facts.draft ? "View draft" : "Edit"}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
