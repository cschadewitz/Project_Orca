/**
 * The Runs surface: what is happening and what happened
 * (docs/design/10-information-architecture.md).
 *
 * Two columns. On the left, the **run tree** above the **event timeline** — the tree is
 * every run in the store with its steps, attempts and child runs under it, and the timeline
 * is the selected run's log. On the right, the **step detail** for whatever is selected.
 * The flat run list this surface used to be is gone: it is the tree's roots now, with the
 * same two filters over it, because a list and a tree of the same objects on one screen is
 * two places to look for one thing.
 *
 * Five decisions worth knowing before changing anything here:
 *
 * - **Three lists, three scopes, one `J`.** The tree is `run-tree`, the timeline is `list`.
 *   The substrate registers the movement keys in whichever scope its `scope` prop names and
 *   scope resolution is innermost-from-focus, so `J` means "next" in whichever one the
 *   focus is in. `→`, `←`, `⇧→`, `Enter` and `F` are the tree's own and are the only keys
 *   this surface registers (`tree/use-tree-keys.ts`).
 * - **One selection.** The tree and the timeline are two views of one run, and selecting in
 *   either moves the other (`use-run-selection.ts`).
 * - **The filter is a filter, not a search.** The status half is a `runs.list` parameter,
 *   so the daemon applies it across the whole store; the text half narrows what is already
 *   held. The timeline's kind filter is local for the same reason.
 * - **It writes two things, and only from the palette (#178).** **Cancel run** and **Resume
 *   run** on the selected run, keyless, through the same `useControls` the Attention
 *   surface's cards use. Nothing is added to the chrome: "the palette is the only place a
 *   phase-2 write action needs to be discoverable, which keeps the chrome of the screens
 *   empty" (docs/design/10-information-architecture.md). Neither row exists where the
 *   daemon has no run control.
 * - **No progress bar, no ETA, no cost.** A running run draws an indeterminate meter and
 *   that is all ORCA can honestly say (rule 12).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { CHROME_GLYPHS, STATUS_PRESENTATION, type ConnectionState } from "@orca/design";
import { DISPLAY_STATUSES, type RunSummaryView, type StepView } from "@orca/protocol";
import type { VirtualListHandle } from "../list/index.js";
import { useAnnounce } from "../a11y/announce-context.js";
import { useControls } from "../attention/use-controls.js";
import { usePaletteWrites, type PaletteWrite } from "../palette/use-write-actions.js";
import { Menu, StateView, Text, countedOf, idText, textClass, type Crumb, type MenuItem } from "../ui/index.js";
import { PaneSplitter } from "../chrome/pane-splitter.js";
import { StepDetail } from "../step/index.js";
import { matchesText } from "./run-rows.js";
import { RunTree } from "./tree/run-tree.js";
import { useRunTree } from "./tree/use-run-tree.js";
import type { TreeRow } from "./tree/tree-rows.js";
import { ALL_KINDS, Timeline } from "./timeline/timeline.js";
import { useRunEvents } from "./timeline/use-run-events.js";
import type { TimelineEntry } from "./timeline/timeline-entries.js";
import { buildSelectionIndex, useRunSelection, EMPTY_INDEX, type SelectionIndex } from "./use-run-selection.js";
import { useRuns, type StatusFilter } from "./use-runs.js";
import "./runs.css";

export interface RunsSurfaceProps {
  /** Whether the daemon is answering. A list nobody is updating says so rather than lying. */
  connection: ConnectionState;
  /**
   * The crumbs for `PrimaryPane`'s header slot: request ▸ work item ▸ run ▸ step for the
   * current selection.
   *
   * They are handed up rather than rendered here because the slot is above the surface in
   * the chrome (`chrome/primary-pane.tsx`), and the breadcrumb for an object is the
   * chrome's job on *every* screen that has an object — a surface drawing its own would be
   * the second object header the information architecture rules out.
   */
  onCrumbs?: (crumbs: readonly Crumb[]) => void;
  /**
   * Where a link led: the run a URL named, and the step within it when it named one
   * (#165). It drives the selection rather than replacing it — a deep link and a keystroke
   * put the surface in the same state, which is what makes `orca://` an address for a thing
   * on screen rather than a second way of looking at it.
   *
   * The step is resolved against the run's projection, so it lands once `runs.get` has
   * answered; a node the run does not have leaves the run selected and says nothing, which
   * is the honest end of a link to a step that was never scheduled.
   */
  open?: { runId: string; nodeId?: string; attempt?: number } | undefined;
}

/** A stable empty page, so the memos do not recompute before the data lands. */
const EMPTY: readonly RunSummaryView[] = [];
const NO_ENTRIES: readonly TimelineEntry[] = [];

/** "All statuses" plus the eight, in the design system's order. */
const STATUS_ITEMS: readonly MenuItem[] = [
  { id: "all", label: "All statuses" },
  ...DISPLAY_STATUSES.map((status) => ({ id: status, label: STATUS_PRESENTATION[status].word })),
];

const statusLabel = (status: StatusFilter): string =>
  status === "all" ? "All statuses" : STATUS_PRESENTATION[status].word;

/** "7 runs", or "3 of 7 runs" once the text filter has narrowed what the daemon sent. */
function countLabel(shown: number, total: number): string {
  return countedOf(shown, total, "run");
}

export function RunsSurface({ connection, onCrumbs, open }: RunsSurfaceProps): JSX.Element {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<string>(ALL_KINDS);
  /* A run opens with its timeline following: the last thing that happened is what a person
     clicked the run for. Scrolling away holds it, and picking another run starts again. */
  const [follow, setFollow] = useState(true);
  const { state, reload } = useRuns(status);

  const runs = state.phase === "ready" ? state.runs : EMPTY;
  const visible = useMemo(() => runs.filter((run) => matchesText(run, text)), [runs, text]);
  const ids = useMemo(() => visible.map((run) => run.id), [visible]);

  const tree = useRunTree(visible);

  /* The index the selection resolves a step against is built from the events the timeline
     holds — and the timeline only holds events once a run is selected. A ref rather than a
     prop is what breaks that circle; it is assigned below, after both hooks have run. */
  const indexRef = useRef<SelectionIndex>(EMPTY_INDEX);
  const selection = useRunSelection(indexRef, ids);
  const { selectedRunId, selectedStepRunId, selectedSeq } = selection;

  /* The timeline's imperative half. A backward page lands in front of the list and moves
     every index down by its length; `shiftBy` is what keeps the reader where they were. */
  const listRef = useRef<VirtualListHandle>(null);
  const onPrepend = useCallback((rows: number) => listRef.current?.shiftBy(rows), []);

  /* The tree caches every `runs.get` it makes; the timeline needs the same projection to
     name the step behind a `stepRunId`, so the selected run is read once, by the tree. */
  const { ensure } = tree;
  useEffect(() => {
    if (selectedRunId !== undefined) ensure(selectedRunId);
  }, [selectedRunId, ensure]);

  /* A link arriving selects its run, and then its step once the projection that names the
     step is in hand. Two effects rather than one because the second cannot run until a read
     has answered, and the first must not wait for it: the tree shows the run immediately. */
  const { selectRun, selectStep } = selection;
  useEffect(() => {
    if (open) selectRun(open.runId);
  }, [open, selectRun]);
  useEffect(() => setFollow(true), [selectedRunId]);
  const onHold = useCallback(() => setFollow(false), []);

  const detail = selectedRunId === undefined ? undefined : tree.detailOf(selectedRunId);
  useEffect(() => {
    if (!open?.nodeId || detail?.run.id !== open.runId) return;
    const matching = detail.steps.filter((step) => step.nodeId === open.nodeId);
    // An attempt names one; without one the highest attempt is the step a person means,
    // which is the same rule the tree draws the row by.
    const step = open.attempt
      ? matching.find((candidate) => candidate.attempt === open.attempt)
      : matching.reduce<StepView | undefined>((best, c) => (best && best.attempt > c.attempt ? best : c), undefined);
    if (step) selectStep(open.runId, step.id);
  }, [open, detail, selectStep]);

  const events = useRunEvents(selectedRunId, detail, onPrepend);
  const entries = events.state.phase === "ready" ? events.state.entries : NO_ENTRIES;
  indexRef.current = useMemo(() => buildSelectionIndex(entries), [entries]);

  const selectedRun = useMemo(() => visible.find((run) => run.id === selectedRunId), [visible, selectedRunId]);
  const currentStep = useMemo(() => {
    if (selectedStepRunId === undefined) return undefined;
    return detail?.steps.find((step) => step.id === selectedStepRunId)?.nodeId ?? selectedStepRunId;
  }, [detail, selectedStepRunId]);

  /* request ▸ work item ▸ run ▸ step, from what the read models carry and nothing else: a
     run has a `requestId` and a `workItem`, a step has a `nodeId`. A crumb with nothing
     behind it is left out rather than filled in (rule 12). */
  const crumbs = useMemo<readonly Crumb[]>(() => {
    if (!selectedRun) return [];
    const trail: Crumb[] = [];
    /* A request has no title on any read model this surface holds (`runs.list` carries
       `requestId` alone), so its label is its id and the crumb draws the id's token in its
       place — never the raw id, in sans, that it used to print. */
    if (selectedRun.requestId !== undefined) {
      trail.push({ type: "request", id: selectedRun.requestId, label: selectedRun.requestId });
    }
    if (selectedRun.workItem) {
      trail.push({ type: "item", id: selectedRun.workItem.id, label: selectedRun.workItem.title });
    }
    /* The workflow this run executes is a counterpart rather than a crumb — the trail is
       request ▸ work item ▸ run ▸ step and a workflow is not on it — so the id travels on
       the crumb and `counterpartUrl` turns it into `orca://workflow/<id>?run=<run>`. That
       menu item is the run header's link to the viewer with this run overlaid (#177).

       The *version* is printed on the crumb, because a run records the version it started
       against and 70-workflow-editing.md asks for it wherever a run's workflow is named.
       The `◷ pinned` chip that goes beside it there is not drawn here: "pinned" is
       `run.workflowVersion !== the version on disk`, and this surface has never read the
       definition — it would take a `workflows.get` per run in the tree to know. The version
       alone is a fact; the chip would be a guess (rule 12). The viewer draws the chip, and
       the crumb's own menu is the way to it. */
    trail.push({
      type: "run",
      id: selectedRun.id,
      label: selectedRun.name,
      counterpartIds: { workflow: selectedRun.workflowId },
      version: `${selectedRun.workflowId} v${selectedRun.workflowVersion}`,
    });
    if (selectedStepRunId !== undefined && currentStep !== undefined) {
      trail.push({ type: "step", id: selectedStepRunId, label: currentStep });
    }
    const last = trail[trail.length - 1];
    if (last) last.current = true;
    return trail;
  }, [selectedRun, selectedStepRunId, currentStep]);

  const report = useRef(onCrumbs);
  report.current = onCrumbs;
  useEffect(() => report.current?.(crumbs), [crumbs]);

  const onSelectRow = useCallback(
    (row: TreeRow) => {
      if (row.stepRunId !== undefined) selection.selectStep(row.runId, row.stepRunId);
      else selection.selectRun(row.runId);
    },
    [selection],
  );

  const onSelectEntry = useCallback(
    (entry: TimelineEntry) => {
      if (selectedRunId !== undefined) selection.selectEvent(selectedRunId, entry.seq);
    },
    [selection, selectedRunId],
  );

  const live = connection === "live";
  const filtered = status !== "all" || text.trim() !== "";
  useRunWrites(selectedRunId, selectedRun?.name);

  return (
    <div className="orca-runs">
      {/* Last-known data, said out loud: the values stay, the banner says not to trust their
          freshness (docs/design/40-connection-states.md). */}
      {!live && state.phase === "ready" && (
        <div className={`orca-banner ${textClass("caption")} orca-banner--stale`} role="status">
          <Text style="caption">Not connected — these runs are the last the daemon sent.</Text>
        </div>
      )}

      <div className="orca-runs__filters">
        <input
          className={`orca-input ${textClass("mono-body")} orca-runs__text`}
          type="search"
          value={text}
          aria-label="Filter runs"
          /* Short enough to survive the field at its narrowest: the label carries the verb,
             so the placeholder only has to say which fields are matched. */
          placeholder="Name, id, workflow or agent"
          onChange={(event) => setText(event.target.value)}
        />
        {/* The current status is in the trigger's accessible name, not only in its text:
            `Menu` puts `label` on the button as `aria-label`, which replaces its content. */}
        <Menu
          label={`Filter by status, currently ${statusLabel(status)}`}
          items={STATUS_ITEMS}
          triggerClassName={`orca-btn ${textClass("caption")} orca-btn--ghost orca-btn--sm`}
          onChoose={(item) => setStatus(item.id as StatusFilter)}
        >
          {statusLabel(status)}
          {/* The bundled symbol face has no downward triangle, and a glyph that falls back
              to the OS is the one thing docs/design forbids — so this is the crumb
              separator turned a quarter, exactly as `ObjectHeader`'s disclosure does it. */}
          <span className="orca-runs__caret" aria-hidden="true">
            {CHROME_GLYPHS.crumbSeparator}
          </span>
        </Menu>
        {state.phase === "ready" && (
          <Text style="caption" className="orca-runs__count">
            {countLabel(visible.length, state.total)}
          </Text>
        )}
      </div>

      <div className="orca-runs__split">
        <div className="orca-runs__left">
          <TreeBody
            state={state}
            tree={tree}
            visible={visible}
            live={live}
            filtered={filtered}
            connection={connection}
            selectedRunId={selectedRunId}
            selectedStepRunId={selectedStepRunId}
            onSelect={onSelectRow}
            onRetry={reload}
            onClearFilter={() => {
              setText("");
              setStatus("all");
            }}
          />
          {/* The boundary between the two lists in this column (#276), and a grid item between
              them. A deep run tree was stuck at two fifths of the left column however much the
              timeline below it had to say; this is where that is traded. */}
          <PaneSplitter boundary="runs-tree" label="Resize the run tree" />
          <Timeline
            state={events.state}
            currentStep={currentStep}
            selectedSeq={selectedSeq}
            onSelect={onSelectEntry}
            loadEarlier={events.loadEarlier}
            onRetry={events.reload}
            listRef={listRef}
            kind={kind}
            onKind={setKind}
            follow={follow}
            onHold={onHold}
          />
        </div>

        {/* And the boundary between the two columns: wide output in the step detail wrapped at
            the panel width on a 34" display while two thirds of the window sat empty. */}
        <PaneSplitter boundary="runs-detail" label="Resize the step detail" />

        {/* The right column. `detail` is the one `runs.get` projection the tree already
            caches, so the pane reads nothing of its own; `stepRunId` absent renders the run
            summary in the same pane, which is what makes "a run selected but no step" a
            state rather than an empty screen. With no run at all there is no projection to
            hand over, so the empty state stays. */}
        <aside className="orca-runs__detail" aria-label="Step detail">
          {detail === undefined ? (
            <StateView kind="empty" title="Step detail" body="Select a run in the tree to see what it produced." />
          ) : (
            <StepDetail detail={detail} stepRunId={selectedStepRunId} connection={connection} />
          )}
        </aside>
      </div>
    </div>
  );
}

interface TreeBodyProps {
  state: ReturnType<typeof useRuns>["state"];
  tree: ReturnType<typeof useRunTree>;
  visible: readonly RunSummaryView[];
  live: boolean;
  filtered: boolean;
  connection: ConnectionState;
  selectedRunId: string | undefined;
  selectedStepRunId: string | undefined;
  onSelect: (row: TreeRow) => void;
  onRetry: () => void;
  onClearFilter: () => void;
}

/** The tree, or the one state view that stands in for it. */
function TreeBody(props: TreeBodyProps): JSX.Element {
  const { state, tree, visible, live, filtered, connection, onSelect, onRetry, onClearFilter } = props;

  if (state.phase === "loading") return <StateView kind="loading" title="Loading runs" />;

  if (state.phase === "error") {
    /* A daemon that never answered is `disconnected`, not an error: nothing is broken and
       there is nothing to report but the absence of a daemon. A daemon that answered with a
       protocol error is an error and the code is what a person needs to see. */
    return connection === "live" ? (
      <StateView
        kind="error"
        title="Could not load the runs"
        body={`${state.error.code}: ${state.error.message}`}
        action={{ label: "Try again", onClick: onRetry }}
      />
    ) : (
      <StateView
        kind="disconnected"
        title="No daemon to read runs from"
        /* No backticks: `StateView`'s body is one type style, so markup for mono would
           render as the characters themselves. */
        body="Start one with orca serve, then try again."
        action={{ label: "Try again", onClick: onRetry }}
      />
    );
  }

  if (visible.length === 0) {
    return filtered ? (
      <StateView
        kind="no-results"
        title="No runs match the filter"
        body="Clear it to see the rest of the store."
        action={{ label: "Clear the filter", onClick: onClearFilter }}
      />
    ) : (
      <StateView kind="empty" title="No runs yet" body="Start one with orca run, and it appears here as it happens." />
    );
  }

  return (
    <RunTree
      tree={tree}
      selectedRunId={props.selectedRunId}
      selectedStepRunId={props.selectedStepRunId}
      onSelect={onSelect}
      // `Enter` opens the step detail, which is the same selection the pane beside the
      // tree already reads — so opening is selecting until unit F gives it somewhere else
      // to go.
      onOpen={onSelect}
      live={live}
    />
  );
}

/** Nothing on this surface answers an input; the hook's callback is the Attention list's. */
const NOTHING_ANSWERED = (): void => {};

/**
 * **Cancel run** and **Resume run** on the selected run, in the palette and nowhere else
 * (#178). The same selection the tree, the timeline and the step detail are about, so the
 * rows are the actions on the object in focus whichever of the three the keyboard is in.
 *
 * `useControls` rather than a second pair of calls: it holds "one call in flight per run",
 * it phrases the outcome, and the Attention surface's cards already answer to it — two
 * copies of `runs.cancel` would be two answers to what a refused write says.
 *
 * Cancelling is destructive and irreversible, so its row is armed before it is run and
 * names the run in the confirmation — its name and its id token, never the raw id: the
 * palette is reached by typing, and the run a person meant is not always the run the palette
 * had selected. Runs of one workflow share a name, so the token is the part that says which.
 */
function useRunWrites(runId: string | undefined, runName: string | undefined): void {
  const announce = useAnnounce();
  const controls = useControls({ onAnswered: NOTHING_ANSWERED });
  const current = useRef(controls);
  current.current = controls;

  /* The result goes in the app's one live region: there is no card here to put it on, and
     a cancel that landed is the person's own act completing. */
  const report = controls.report;
  useEffect(() => {
    if (report) announce(report.message);
  }, [report, announce]);

  const rows = useMemo((): readonly PaletteWrite[] => {
    if (runId === undefined) return [];
    // The id is ORCA's, so its token is set in mono wherever it is drawn (rule 8), and the
    // full id is matched, so pasting it finds these rows.
    const token = idText(runId, { kind: "run" });
    const named = runName === undefined ? token : `${runName} ${token}`;
    return [
      {
        scope: "run-tree",
        method: "runs.cancel",
        label: `Cancel ${named}`,
        labelMachine: token,
        objectId: runId,
        detail: "Stops the run where it is; what has already happened stays in the log",
        tone: "danger",
        confirm: `Cancel ${named} — confirm`,
        action: () => current.current.cancel(runId),
      },
      {
        scope: "run-tree",
        method: "runs.resume",
        label: `Resume ${named}`,
        labelMachine: token,
        objectId: runId,
        detail: "Re-drives a parked run; it returns when the run parks again or finishes",
        action: () => current.current.resume(runId),
      },
    ];
  }, [runId, runName]);

  usePaletteWrites(rows);
}
