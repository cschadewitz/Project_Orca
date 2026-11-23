/**
 * The visual workflow editor (#181, #182) over a workflow draft (#180).
 *
 * ```
 * ┌ draft bar: draft of ai-sdlc v3 · 4 changes   Undo Redo Tidy  Review and publish  Discard  Close ┐
 * ├ palette ─┬─────────────── canvas ───────────────┬─ inspector ─┤
 * │ outline  │                                       │             │
 * │          ├──────────── validation ──────────────┤             │
 * └──────────┴───────────────────────────────────────┴─────────────┘
 * ```
 *
 * One selection, shared by the outline, the canvas and the inspector (docs/design/70). Every
 * change is a draft operation the daemon applies and validates, so the editor never holds an
 * edit the daemon has not seen: closing the window, or the editor, loses nothing, and the
 * workflow itself changes only when a person reviews the diff and publishes it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import type {
  DraftGraphPath,
  DraftIssue,
  DraftOperation,
  WorkflowDraftReview,
  WorkflowDraftView,
} from "@orca/protocol";
import { useAnnounce } from "../../a11y/announce-context.js";
import { useNotifications } from "../../notifications-context.js";
import { diffText, gutterFor } from "../../artifacts/diff.js";
import { PaneSplitter } from "../../chrome/pane-splitter.js";
import { useWritability } from "../../chrome/use-connection.js";
import { Button, StateView, Text, counted, focusAfterLeaving, textClass, unit } from "../../ui/index.js";
import { changeCount, editorGraph, freshId, issuesAt, nestedSteps, newNode, type EditorGraph } from "./draft-model.js";
import { EditorCanvas, type CanvasHandle, type EditorSelection } from "./editor-canvas.js";
import { EditorInspector, type InspectorHandle } from "./editor-inspector.js";
import { EditorSidebar, ValidationPanel, type PaletteHandle } from "./editor-panels.js";
import { useWorkflowDraft } from "./use-workflow-draft.js";
import "./editor.css";

export interface WorkflowEditorProps {
  workflowId: string;
  /** Back to the viewer. The draft stays, and opening the editor again resumes it. */
  onClose: () => void;
  /** A publish landed: the viewer re-reads the workflow at its new version. */
  onPublished: (version: string) => void;
}

export function WorkflowEditor({ workflowId, onClose, onPublished }: WorkflowEditorProps): JSX.Element {
  const controller = useWorkflowDraft(workflowId);
  const { state } = controller;
  if (state.phase === "loading") return <StateView kind="loading" title="Opening the draft" />;
  if (state.phase === "unavailable")
    return (
      <StateView
        kind="empty"
        title="Editing is not available"
        body={state.reason}
        action={{ label: "Back to the viewer", onClick: onClose }}
      />
    );
  if (state.phase === "missing")
    return (
      <StateView
        kind="empty"
        title="No draft here"
        body={`The daemon this window is connected to now has no draft of ${workflowId}. Start one from the viewer.`}
        action={{ label: "Back to the viewer", onClick: onClose }}
      />
    );
  if (state.phase === "error")
    return (
      <StateView
        kind="error"
        title="Could not open a draft"
        body={state.error}
        action={{ label: "Back to the viewer", onClick: onClose }}
      />
    );
  return <Editor draft={state.draft} controller={controller} onClose={onClose} onPublished={onPublished} />;
}

function Editor({
  draft,
  controller,
  onClose,
  onPublished,
}: {
  draft: WorkflowDraftView;
  controller: ReturnType<typeof useWorkflowDraft>;
  onClose: () => void;
  onPublished: (version: string) => void;
}): JSX.Element {
  const writable = useWritability();
  const announce = useAnnounce();
  const root = useRef<HTMLDivElement>(null);
  const returnReviewFocus = useCallback(() => {
    // The draft bar survives review invalidation, including a switch to read-only.
    root.current?.querySelector<HTMLButtonElement>(".orca-draftbar button:last-child")?.focus();
  }, []);
  const readOnly = !draft.owner.you || !writable.can;
  const [path, setPath] = useState<DraftGraphPath>([]);
  const [selection, setSelection] = useState<EditorSelection | undefined>(undefined);
  const [heldReview, setReview] = useState<
    { value: WorkflowDraftReview; request: number; targetEpoch: number | undefined } | undefined
  >(undefined);
  const reviewRequest = useRef(0);
  const latest = useRef({ draft, readOnly, busy: controller.busy, checking: controller.checking });
  latest.current = { draft, readOnly, busy: controller.busy, checking: controller.checking };
  const invalidateReview = useCallback(() => {
    reviewRequest.current += 1;
    setReview(undefined);
  }, []);
  // A review is evidence for one revision. Drop it on observed revision/base or access
  // changes, and retire outstanding review responses too, even if access later returns.
  useEffect(invalidateReview, [
    draft.revision,
    draft.base.revision,
    draft.base.current,
    draft.owner.principalId,
    readOnly,
    controller.conflict,
    // A review stands on validated findings; findings being checked again retire it.
    controller.checking,
    invalidateReview,
  ]);
  useEffect(
    () => () => {
      reviewRequest.current += 1;
    },
    [],
  );
  /* The findings were checked against the configuration that was active then: when it
     changes (a template added, an agent removed), validate the draft again (#182). */
  const stream = useNotifications();
  const { revalidate } = controller;
  useEffect(() => stream.on("config.changed", () => void revalidate()), [stream, revalidate]);

  /* The live region hears about validation only when the draft crosses between clean and not
     (#182): every edit re-validates, and a count read out after each one is noise. */
  const errorCount = draft.issues.filter((issue) => issue.severity === "error").length;
  const heardErrors = useRef(errorCount);
  useEffect(() => {
    if (controller.checking) return;
    const before = heardErrors.current;
    heardErrors.current = errorCount;
    if (before === 0 && errorCount > 0) announce(`The draft has ${counted(errorCount, "validation error")}.`);
    else if (before > 0 && errorCount === 0) announce("The draft has no validation errors.");
  }, [errorCount, controller.checking, announce]);

  const review =
    heldReview?.request === reviewRequest.current &&
    heldReview.value.revision === draft.revision &&
    !readOnly &&
    draft.base.current
      ? heldReview.value
      : undefined;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const workflows = useWorkflowIds();
  const inspector = useRef<InspectorHandle>(null);
  const palette = useRef<PaletteHandle>(null);
  const canvas = useRef<CanvasHandle>(null);

  /* A path into a graph the draft no longer has - its container was deleted or undone away -
     falls back to the nearest graph that still exists. */
  const graph = useMemo<EditorGraph | undefined>(() => {
    for (let depth = path.length; depth >= 0; depth -= 1) {
      const found = editorGraph(draft.document, draft.base.document, path.slice(0, depth));
      if (found) return found;
    }
    return undefined;
  }, [draft, path]);
  useEffect(() => {
    if (graph && path.length > 0 && !editorGraph(draft.document, draft.base.document, path)) setPath([]);
  }, [graph, draft, path]);

  const issues = useMemo(() => issuesAt(draft.issues, path), [draft.issues, path]);
  const changes = useMemo(() => changeCount(draft.document, draft.base.document), [draft]);
  const scoped = useCallback(
    (ops: DraftOperation[]): DraftOperation[] =>
      path.length === 0 ? ops : ops.map((op) => (op.op === "setWorkflow" ? op : { ...op, graph: path })),
    [path],
  );
  const apply = useCallback(
    (ops: DraftOperation[]) => {
      invalidateReview();
      return controller.apply(scoped(ops));
    },
    [controller, scoped, invalidateReview],
  );
  const undo = () => {
    invalidateReview();
    return controller.undo();
  };
  const redo = () => {
    invalidateReview();
    return controller.redo();
  };

  if (!graph)
    return (
      <StateView
        kind="error"
        title="The draft does not parse"
        body="Its YAML cannot be read. Undo the last change, or discard the draft."
        action={{ label: "Undo", onClick: () => void undo() }}
      />
    );

  const ids = graph.nodes.map((node) => node.id);
  const selectedNode = selection?.kind === "node" ? graph.nodes.find((node) => node.id === selection.id) : undefined;

  /* ---------- operations the gestures turn into ---------- */

  const addAfterSelection = (type: string) => {
    const id = freshId(type, ids);
    const node = newNode(type, { workflows });
    const from =
      selectedNode && selectedNode.state !== "removed" && selectedNode.type !== "end" ? selectedNode : undefined;
    let ops: DraftOperation[];
    if (!from) ops = [{ op: "addNode", id, node }];
    else {
      const out = graph.edges.filter((edge) => edge.from === from.id);
      const only = out.length === 1 && out[0]!.when === undefined ? out[0] : undefined;
      ops = only
        ? [{ op: "insertNode", id, node, edge: only.index }]
        : [
            { op: "addNode", id, node },
            { op: "addEdge", from: from.id, to: id },
          ];
    }
    void apply(ops).then((ok) => ok && setSelection({ kind: "node", id }));
  };

  const addAt = (type: string, at?: { x: number; y: number }) => {
    const id = freshId(type, ids);
    const ops: DraftOperation[] = [{ op: "addNode", id, node: newNode(type, { workflows }) }];
    if (at) ops.push({ op: "place", id, x: at.x, y: at.y });
    void apply(ops).then((ok) => ok && setSelection({ kind: "node", id }));
  };

  const insertOn = (type: string, edgeIndex: number) => {
    const id = freshId(type, ids);
    void apply([{ op: "insertNode", id, node: newNode(type, { workflows }), edge: edgeIndex }]).then(
      (ok) => ok && setSelection({ kind: "node", id }),
    );
  };

  /*
   * Delete — the canvas's Delete key and the inspector's Delete, Delete with its connections
   * and Delete edge alike. Each is one draft operation, which ⌘Z takes back, so none of them
   * asks (docs/design/70-workflow-editing.md).
   *
   * **Where the selection and focus go.** The node or edge goes, and so does the inspector
   * control that deleted it, which would drop keyboard focus to the page body. So the
   * selection moves to a neighbour — after a node, the node after it in file order, or the one
   * before when it was the last (`focusAfterLeaving`, the claims list's and the policy
   * panel's rule, over the outline's order); after an edge, the node it left from — and focus
   * goes to the canvas, the one tab stop where Delete, the arrows and ⌘Z are, whose active
   * descendant then names that neighbour. Focus moves only when the delete took it with it
   * (it was in the inspector, or has already fallen to the body): from the canvas's own
   * Delete key it is already there, and focus a person moved elsewhere while the operation
   * was out stays where they put it.
   */
  const remove = (detach: boolean) => {
    const live = graph.nodes.filter((node) => node.state !== "removed").map((node) => node.id);
    if (selection?.kind === "edge") {
      const edge = graph.edges.find((e) => e.index === selection.index);
      const from = edge !== undefined && live.includes(edge.from) ? edge.from : undefined;
      void apply([{ op: "removeEdge", index: selection.index }]).then((ok) => ok && landAfterDelete(from));
      return;
    }
    if (!selectedNode || selectedNode.state === "removed") return;
    if (selectedNode.id === graph.start) {
      announce("The start node stays. Connect it to something else instead.");
      return;
    }
    const gone = selectedNode.id;
    const rest = live.filter((id) => id !== gone);
    const at = focusAfterLeaving(live, rest, gone);
    void apply([{ op: "removeNode", id: gone, ...(detach ? { detach: true } : {}) }]).then(
      (ok) => ok && landAfterDelete(at === undefined ? undefined : rest[at]),
    );
  };

  const landAfterDelete = (next: string | undefined) => {
    const active = document.activeElement;
    if (active === null || active === document.body || inspector.current?.holdsFocus()) canvas.current?.focus();
    setSelection(next === undefined ? undefined : { kind: "node", id: next });
  };

  const reorder = (delta: -1 | 1) => {
    if (!selectedNode || selectedNode.state === "removed") return;
    const order = graph.nodes.filter((node) => node.state !== "removed").map((node) => node.id);
    const at = order.indexOf(selectedNode.id);
    const target = at + delta;
    if (target < 0 || target >= order.length) return;
    const without = order.filter((id) => id !== selectedNode.id);
    void apply([
      { op: "moveNode", id: selectedNode.id, ...(without[target] !== undefined ? { before: without[target] } : {}) },
    ]);
  };

  const openNested = (step: { node: string; branch?: string; forEach?: true }) => {
    setPath((current) => [
      ...current,
      {
        node: step.node,
        ...(step.branch !== undefined ? { branch: step.branch } : {}),
        ...(step.forEach ? { forEach: true as const } : {}),
      },
    ]);
    setSelection(undefined);
  };

  const goTo = (issue: DraftIssue) => {
    setPath(issue.graph);
    setSelection(
      issue.node !== undefined
        ? { kind: "node", id: issue.node }
        : issue.edge !== undefined
          ? { kind: "edge", index: issue.edge }
          : undefined,
    );
  };

  const startReview = async () => {
    if (readOnly || controller.busy || controller.checking) return;
    const request = ++reviewRequest.current;
    const revision = draft.revision;
    const targetEpoch = window.orca.daemonConnection?.read().epoch;
    const result = await controller.review();
    if (
      result &&
      request === reviewRequest.current &&
      !latest.current.readOnly &&
      !latest.current.checking &&
      latest.current.draft.base.current &&
      latest.current.draft.revision === revision &&
      result.revision === revision &&
      targetEpoch === window.orca.daemonConnection?.read().epoch
    )
      setReview({ value: result, request, targetEpoch });
  };

  const publish = async () => {
    if (
      !review ||
      heldReview?.request !== reviewRequest.current ||
      latest.current.readOnly ||
      latest.current.busy ||
      latest.current.checking ||
      latest.current.draft.revision !== review.revision ||
      heldReview.targetEpoch !== window.orca.daemonConnection?.read().epoch
    )
      return;
    const result = await controller.publish(review.reviewToken);
    if (!result) return;
    announce(`Published ${draft.workflowId} version ${result.version}.`);
    onPublished(result.version);
  };

  const discard = async () => {
    if (!confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    invalidateReview();
    if (await controller.discard()) {
      announce("Draft discarded.");
      onClose();
    }
  };

  /* ---------- drawing ---------- */

  const yamlPrefix = path
    .map(
      (step) =>
        `nodes.${step.node}.${step.branch !== undefined ? `branches.${step.branch}.` : step.forEach ? "forEach.body." : "body."}graph.`,
    )
    .join("");
  const errors = draft.issues.filter((issue) => issue.severity === "error").length;
  const owner = draft.owner.you ? "your draft" : `${draft.owner.principalId}'s draft, read-only`;
  const blocked = controller.conflict !== undefined;
  const summary = `${owner} · ${counted(changes, "change")}${draft.dirty && changes === 0 ? " to the layout" : ""}`;
  const status =
    controller.conflict !== undefined
      ? `Reloaded: ${controller.conflict}`
      : controller.message !== undefined
        ? controller.message
        : !draft.base.current
          ? "The workflow file changed since this draft was taken; it cannot be published."
          : !writable.can
            ? writable.reason
            : controller.busy
              ? "Saving…"
              : "Saved in the draft";

  return (
    <div ref={root} className="orca-wfedit">
      <div
        className={`orca-draftbar ${textClass("caption")}${blocked || !draft.base.current ? " orca-draftbar--blocked" : ""}`}
        role="group"
        aria-label="Workflow draft"
      >
        {/* One line (RULES.md rule 15): the name and the buttons keep their width, and the two
            captions give way, the status first, cut at their end and whole in their title. */}
        <Text style="label-strong">{`Draft of ${draft.workflowId} v${draft.base.version}`}</Text>
        <Text style="caption" className="orca-truncate" title={summary}>
          {summary}
        </Text>
        <span role="status" className={`orca-truncate ${textClass("caption")}`} title={status}>
          {status}
        </span>
        <span className="orca-spacer" />
        {!readOnly && (
          <>
            <Button
              size="sm"
              tone="ghost"
              onClick={() => void undo()}
              disabled={!draft.canUndo}
              disabledReason="Nothing to undo"
            >
              Undo
            </Button>
            <Button
              size="sm"
              tone="ghost"
              onClick={() => void redo()}
              disabled={!draft.canRedo}
              disabledReason="Nothing to redo"
            >
              Redo
            </Button>
            <Button size="sm" tone="ghost" onClick={() => void apply([{ op: "tidy" }])}>
              Tidy layout
            </Button>
            <Button
              size="sm"
              tone={confirmDiscard ? "danger" : "ghost"}
              onClick={() => void discard()}
              onBlur={() => setConfirmDiscard(false)}
            >
              {confirmDiscard ? "Discard every change" : "Discard draft"}
            </Button>
            <Button
              size="sm"
              tone="primary"
              onClick={() => void startReview()}
              disabled={draft.publishBlocked !== undefined || controller.checking || controller.busy}
              {...(draft.publishBlocked !== undefined
                ? { disabledReason: draft.publishBlocked }
                : controller.checking
                  ? { disabledReason: "The draft is being checked against the running configuration again." }
                  : {})}
            >
              Review and publish
            </Button>
          </>
        )}
        <Button size="sm" onClick={onClose}>
          Close the editor
        </Button>
      </div>

      {path.length > 0 && (
        <nav className={`orca-wfedit__trail ${textClass("caption")}`} aria-label="Graph">
          <button
            type="button"
            className={`orca-bare orca-wfedit__crumb ${textClass("mono-id")}`}
            onClick={() => {
              setPath([]);
              setSelection(undefined);
            }}
          >
            {draft.workflowId}
          </button>
          {path.map((step, index) => (
            <span key={index}>
              <span aria-hidden="true"> ▸ </span>
              <button
                type="button"
                className={`orca-bare orca-wfedit__crumb ${textClass("mono-id")}`}
                aria-current={index === path.length - 1 ? "location" : undefined}
                onClick={() => {
                  setPath(path.slice(0, index + 1));
                  setSelection(undefined);
                }}
              >
                {`${step.node}${step.branch !== undefined ? ` [${step.branch}]` : step.forEach ? " [each]" : ""}`}
              </button>
            </span>
          ))}
        </nav>
      )}

      {review ? (
        <ReviewPanel
          review={review}
          busy={controller.busy}
          errors={errors}
          message={controller.message}
          returnFocus={returnReviewFocus}
          onBack={invalidateReview}
          onPublish={() => void publish()}
        />
      ) : (
        <div className="orca-wfedit__body">
          <EditorSidebar
            ref={palette}
            graph={graph}
            selection={selection}
            readOnly={readOnly}
            issues={issues}
            onAdd={addAfterSelection}
            onSelect={setSelection}
            onMove={(id, before) => void apply([{ op: "moveNode", id, ...(before !== undefined ? { before } : {}) }])}
          />
          <div className="orca-wfedit__main">
            <EditorCanvas
              ref={canvas}
              graph={graph}
              layout={draft.layout}
              path={path}
              issues={issues}
              selection={selection}
              onSelect={setSelection}
              readOnly={readOnly}
              label={`${draft.workflowId} draft graph`}
              onPlace={(id, x, y) => void apply([{ op: "place", id, x, y }])}
              onConnect={(from, to) => void apply([{ op: "addEdge", from, to }])}
              onAdd={addAt}
              onInsert={insertOn}
              onDelete={remove}
              onOpenNested={(id) => {
                const node = graph.nodes.find((n) => n.id === id);
                const first = node ? nestedSteps(node)[0] : undefined;
                if (first) openNested(first);
              }}
              onRename={() => inspector.current?.focusName()}
              onConnectMenu={() => inspector.current?.openConnect()}
              onAddMenu={() => palette.current?.focus()}
              onReorder={reorder}
              onUndo={() => void undo()}
              onRedo={() => void redo()}
            />
            <ValidationPanel issues={draft.issues} path={path} checking={controller.checking} onGo={goTo} />
          </div>
          <PaneSplitter boundary="panel" label="Resize the inspector" />
          <EditorInspector
            ref={inspector}
            graph={graph}
            path={path}
            yamlPrefix={yamlPrefix}
            selection={selection}
            issues={issues}
            readOnly={readOnly}
            workflow={workflowFields(draft.document)}
            workflows={workflows}
            onApply={apply}
            onSelect={setSelection}
            onDelete={remove}
            onOpenNested={openNested}
          />
        </div>
      )}
    </div>
  );
}

/** The exact bytes publish will write, as a diff against the live file, and the one button that writes them. */
function ReviewPanel({
  review,
  busy,
  errors,
  message,
  returnFocus,
  onBack,
  onPublish,
}: {
  review: WorkflowDraftReview;
  busy: boolean;
  errors: number;
  message: string | undefined;
  returnFocus: () => void;
  onBack: () => void;
  onPublish: () => void;
}): JSX.Element {
  const diff = useMemo(() => diffText(review.baseText, review.text), [review]);
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(
    () => () => {
      if (panel.current?.contains(document.activeElement)) returnFocus();
    },
    [returnFocus],
  );
  return (
    <section ref={panel} className="orca-wfedit__review" aria-labelledby="orca-wfedit-review">
      <header className="orca-wfedit__review-head">
        <h2 id="orca-wfedit-review" className={textClass("heading")}>
          {`Publish v${review.nextVersion}`}
        </h2>
        <Text style="caption">
          {`${unit(diff.added, "added")}, ${unit(diff.removed, "removed")}. Runs already started stay on v${review.baseVersion}; runs started after publishing use v${review.nextVersion}.`}
        </Text>
        {message !== undefined && (
          <Text style="caption" role="status">
            {message}
          </Text>
        )}
        <span className="orca-spacer" />
        <Button size="sm" tone="ghost" onClick={onBack}>
          Back to editing
        </Button>
        <Button
          size="sm"
          tone="primary"
          onClick={onPublish}
          disabled={busy || errors > 0}
          {...(errors > 0 ? { disabledReason: "Fix the validation errors first" } : {})}
        >
          {`Publish v${review.nextVersion}`}
        </Button>
      </header>
      <pre className={`orca-wfedit__diff ${textClass("mono-log")}`} aria-label="Changes to the workflow file">
        {diff.coarse && (
          <span className="orca-wfedit__diff-note">
            {"The files are too far apart to line up; this is the whole new file.\n"}
          </span>
        )}
        {diff.lines.map((line, index) => (
          <span
            key={index}
            className={`orca-diff__line${line.op === "add" ? " orca-diff__line--add" : line.op === "del" ? " orca-diff__line--del" : ""}`}
          >
            {`${gutterFor(line.op)} ${line.text}\n`}
          </span>
        ))}
      </pre>
    </section>
  );
}

function workflowFields(document: unknown): { name?: string; description?: string } | undefined {
  if (!document || typeof document !== "object") return undefined;
  const record = document as Record<string, unknown>;
  return {
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
  };
}

/** Registered workflow ids, for a subworkflow's target. One read; the list rarely changes mid-edit. */
function useWorkflowIds(): readonly string[] {
  const [ids, setIds] = useState<readonly string[]>([]);
  useEffect(() => {
    let live = true;
    void window.orca.workflows.list().then((result) => {
      if (live && result.ok) setIds(result.result.workflows.map((workflow) => workflow.id));
    });
    return () => {
      live = false;
    };
  }, []);
  return ids;
}
