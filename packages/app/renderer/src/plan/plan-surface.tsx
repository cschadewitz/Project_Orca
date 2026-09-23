/**
 * The Plan surface (#170): what is coming, why it is not moving, and what it depends on.
 *
 * The shape is `runs/`'s — the arithmetic in a plain module with a plain test
 * (`plan-model.ts`), the data in one hook (`use-plan.ts`), the markup composed from
 * `ui/`. What is particular to this one:
 *
 * - **Option B, as designed.** The sidebar is requests and filters rather than a list of
 *   sub-screens, and the modes are a segmented control on the object header — a new
 *   `ObjectHeader` variant (`docs/design/80-dependency-graph-options.md`). Each position
 *   arrived with the mode behind it (`PLAN_MODES`): a position that never does anything is
 *   a dead end rather than a promise. The risk mode (#172) is the plan's matrix over its
 *   register, and its selection is a risk whose detail goes in the dock.
 * - **Two lists, two scopes.** The schedule table is `list`, the journal is
 *   `plan-journal`. One `VirtualList` per scope, so `J` means "next" in whichever of them
 *   the focus is in.
 * - **The filter is a filter, not a search.** Classification, status and request are
 *   `items.list` parameters and are applied across the whole plan; the text half narrows
 *   what is held, and the count says which ("3 of 9 items").
 * - **A daemon with no plan is a state, not an error.** `plan.read` absent from
 *   `hello.capabilities` means this daemon serves no plan, and so does a store with no
 *   plan in it. Neither is a failure and neither is retried.
 * - **What writes is the palette, not this pane (#178).** Waive, decide, reopen, update a
 *   risk and release the claim are keyless commands on the selected item
 *   (`use-plan-writes.ts`); the schedule and the work-item inspector draw none of them. Two
 *   modes are the exception because the write *is* what they are for: the decision matrix
 *   decides and reopens from the table (#173), and the relationship inspector waives
 *   (#171). Each of those is in the palette as well.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { ConnectionState } from "@orca/design";
import type { DecisionView, ItemClassification, PlanItemView, RiskView } from "@orca/protocol";
import { useKeyboard } from "../keyboard-context.js";
import { PaneSplitter } from "../chrome/pane-splitter.js";
import { StateView, Text, textClass, type Crumb, type HeaderMode } from "../ui/index.js";
import { DecisionMode } from "./decision-mode.js";
import { DepsMode } from "./deps-mode.js";
import {
  ALL_EDGES,
  buildGraph,
  cycleDependencies,
  relationships,
  type DepEdge,
  type DepNode,
  type GraphFilters,
} from "./graph-model.js";
import { RelationshipInspector } from "./relationship-inspector.js";
import { usePlanDependencies } from "./use-dependencies.js";
import { decisionsForRail } from "./decision-model.js";
import { Journal } from "./journal.js";
import { Inspector } from "./inspector.js";
import { PlanSidebar } from "./plan-sidebar.js";
import { RiskDetail } from "./risk-detail.js";
import { RiskMode } from "./risk-mode.js";
import { risksForRail } from "./risk-model.js";
import { ScheduleTable } from "./schedule-table.js";
import { countLabel, isFiltered, matchesText, NO_FILTERS, type ItemStatus, type PlanFilters } from "./plan-model.js";
import { useItemDetail, usePlan } from "./use-plan.js";
import { usePlanDecisions } from "./use-decisions.js";
import { usePlanRisks, useRiskJournal } from "./use-risks.js";
import { usePlanWrites } from "./use-plan-writes.js";
import "./plan.css";

/**
 * The modes, in the order the header draws them. Each position arrived with the mode behind
 * it — a segment that did nothing would be a dead end rather than a promise.
 */
export const PLAN_MODES: readonly HeaderMode[] = [
  { id: "schedule", label: "Schedule" },
  { id: "risk", label: "Risks" },
  { id: "decision", label: "Decisions" },
  { id: "deps", label: "Dependencies" },
  { id: "journal", label: "Journal" },
];

export type PlanMode = "schedule" | "risk" | "decision" | "deps" | "journal";

const isPlanMode = (id: string): id is PlanMode => PLAN_MODES.some((mode) => mode.id === id);

/** What the docked panel is showing for Plan: its body, and the word its head says. */
export interface PlanPanel {
  label: string;
  body: ReactNode;
}

/** What the surface hands up to the chrome: one breadcrumb, one mode control, one panel. */
export interface PlanHeader {
  crumbs: readonly Crumb[];
  mode: { options: readonly HeaderMode[]; active: string; onChange: (id: string) => void; label?: string };
  actions: ReactNode;
}

export interface PlanSurfaceProps {
  connection: ConnectionState;
  /** What the daemon says it can do. Absent `plan.read` means it serves no plan. */
  capabilities: readonly string[];
  /** `orca://item/<slug-or-id>` — select that item and open its explanation. */
  open?: string | undefined;
  /** `orca://plan?mode=<mode>&focus=<id>` — land on a mode, with that item or node selected. */
  focus?: { mode?: string | undefined; id?: string | undefined } | undefined;
  onHeader?: (header: PlanHeader) => void;
  /**
   * The inspector, handed up for the docked panel to draw (the dock is the chrome's).
   *
   * `open` says whether this report is a person asking to *see* it — a new row selected —
   * rather than the same inspector re-rendered with the detail that has since landed. Only
   * the first may open the dock: a content update that opened it would undo the `⌘\` a
   * person pressed a moment after clicking a row.
   */
  onInspector?: (panel: PlanPanel | null, options: { open: boolean }) => void;
  /** A claim's run, opened through the route table. */
  onOpenRun: (runId: string) => void;
}

const EMPTY: readonly PlanItemView[] = [];

export function PlanSurface(props: PlanSurfaceProps): JSX.Element {
  const { capabilities } = props;
  /* The capability gate is above the hook rather than inside it: a daemon that serves no
     plan is not a plan that failed to load, and there is nothing to read, retry or say
     about a connection here. `hello.methods` would say the same thing one call later —
     the capability is the class of functionality and the methods are its members — and
     the connection snapshot carries the capabilities already. */
  if (!capabilities.includes("plan.read")) {
    return (
      <StateView
        kind="empty"
        title="This daemon serves no plan"
        body="It answers about runs only. A daemon over a store with a plan in it shows the schedule here."
      />
    );
  }
  return <PlanBody {...props} />;
}

function PlanBody({ connection, open, focus, onHeader, onInspector, onOpenRun }: PlanSurfaceProps): JSX.Element {
  const [filters, setFilters] = useState<PlanFilters>(NO_FILTERS);
  const [mode, setMode] = useState<PlanMode>("schedule");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  /** The risk selected in the risk mode. Held apart from the item: they are two lists. */
  const [selectedRiskId, setSelectedRiskId] = useState<string | undefined>(undefined);
  /** The decision selected in the decision mode. */
  const [selectedDecisionId, setSelectedDecisionId] = useState<string | undefined>(undefined);
  /** The item whose explanation is open, and the lines once `schedule.explain` has answered. */
  const [explainFor, setExplainFor] = useState<string | undefined>(undefined);
  const [lines, setLines] = useState<readonly string[] | undefined>(undefined);
  /** What the daemon said when it could not explain. Held apart from the lines on purpose. */
  const [explainError, setExplainError] = useState<string | undefined>(undefined);

  const feed = usePlan(filters);
  const plan = feed.state.phase === "ready" ? feed.state.plan : undefined;
  const planId = plan?.id;

  const held = feed.items.phase === "ready" ? feed.items.items : EMPTY;
  const total = feed.items.phase === "ready" ? feed.items.total : 0;
  /* Whether the plan continues past what is held. `items.list` answers a page, so a count
     that said "260 items" over 200 rows would be a claim about rows that are not here. */
  const hasMore = feed.items.phase === "ready" && feed.items.hasMore;
  const loadingMore = feed.items.phase === "ready" && feed.items.loadingMore;
  /* The local half of the filter. The daemon applied the other three across the whole
     plan; this one narrows what came back, and the count below says so. */
  const visible = useMemo(() => held.filter((item) => matchesText(item, filters.text)), [held, filters.text]);

  const selected = useMemo(() => visible.find((item) => item.id === selectedId), [visible, selectedId]);
  /* The revision is a dependency of the detail read, not only the selection: a
     `dependencies`, `risks` or `decisions` frame changes an `evaluation.detail` without
     changing which item is selected (`use-plan.ts`). */
  const detail = useItemDetail(planId, selected?.id, feed.itemsRevision);
  /* The selected item's writes, in the palette and nowhere else (#178). The inspector
     draws the same dependencies, risks and claim and offers none of them. */
  usePlanWrites({ planId, item: selected, dependencies: detail.dependencies, risks: detail.risks });

  /* The risk mode's reads, made only while it is on screen. The rail is shared with the
     schedule, so what it shows is narrowed by the same items the table would show. */
  const { state: risksState, reload: reloadRisks } = usePlanRisks(
    mode === "risk" ? planId : undefined,
    feed.itemsRevision,
  );
  const railRisks = useMemo(
    () => (risksState.phase === "ready" ? risksForRail(risksState.risks, isFiltered(filters), visible) : []),
    [risksState, filters, visible],
  );
  const selectedRisk = useMemo(
    () => (mode === "risk" ? railRisks.find((risk) => risk.id === selectedRiskId) : undefined),
    [mode, railRisks, selectedRiskId],
  );
  const riskJournal = useRiskJournal(planId, selectedRisk, feed.journal.lastSeq);
  const selectRisk = useCallback((risk: RiskView) => setSelectedRiskId(risk.id), []);
  /* The decision mode's read, on the same terms: only while it is on screen, and narrowed by
     the same rail. */
  const { state: decisionsState, reload: reloadDecisions } = usePlanDecisions(
    mode === "decision" ? planId : undefined,
    feed.itemsRevision,
  );
  const railDecisions = useMemo(
    () =>
      decisionsState.phase === "ready" ? decisionsForRail(decisionsState.decisions, isFiltered(filters), visible) : [],
    [decisionsState, filters, visible],
  );
  const selectDecision = useCallback((decision: DecisionView) => setSelectedDecisionId(decision.id), []);

  /* The graph (#171). Its selection *is* the item selection when the node is a work item —
     the selected row is the focused node and the reverse — and is held apart only for the
     two kinds of node that are not rows: a decision and an external target. */
  const [graphFilters, setGraphFilters] = useState<GraphFilters>(ALL_EDGES);
  const [targetNode, setTargetNode] = useState<string | undefined>(undefined);
  const {
    state: depsState,
    reload: reloadDeps,
    patch: patchDeps,
  } = usePlanDependencies(mode === "deps" ? planId : undefined, feed.itemsRevision);
  const graph = useMemo(
    () =>
      depsState.phase === "ready"
        ? buildGraph(visible, depsState.dependencies, graphFilters)
        : { nodes: [] as DepNode[], edges: [] as DepEdge[] },
    [depsState, visible, graphFilters],
  );
  const cycle = useMemo(
    () =>
      depsState.phase === "ready" ? cycleDependencies(depsState.cycles, depsState.dependencies) : new Set<string>(),
    [depsState],
  );
  const focusedNode = targetNode ?? selectedId;
  const selectNode = useCallback((nodeId: string) => {
    if (nodeId.startsWith("decision:") || nodeId.startsWith("external:")) setTargetNode(nodeId);
    else {
      setTargetNode(undefined);
      setSelectedId(nodeId);
    }
  }, []);
  /* `Enter` on a node is a person asking to see its relationships, which may re-open a dock
     they closed. Counted so the same node asked for twice is two asks. */
  const [asked, setAsked] = useState(0);
  const openNode = useCallback(
    (nodeId: string) => {
      selectNode(nodeId);
      setAsked((n) => n + 1);
    },
    [selectNode],
  );

  /* A held item named in the risk's detail is opened on the schedule, which is where a work
     item is read. */
  const openItem = useCallback((itemId: string) => {
    setMode("schedule");
    setSelectedId(itemId);
  }, []);

  /* A link that arrived. `orca://item/<slug-or-id>` selects the item and opens the
     explanation, which is the information architecture's promise for that URL — so it
     lands once the table has the row, and says nothing when the plan does not have it.

     Acted on **once per link**, tracked in a ref. `held` is a new array on every re-read,
     so an effect that only depended on it re-fired on every `plan.changed` frame — which
     forced the mode back to Schedule and re-opened the explanation under somebody who had
     since switched to the Journal or closed it. A link is a thing that arrives, not a
     thing that keeps arriving. */
  const landed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (open === undefined) {
      landed.current = undefined;
      return;
    }
    if (landed.current === open) return;
    const match = held.find((item) => item.id === open || item.slug === open);
    if (!match) return;
    landed.current = open;
    setMode("schedule");
    setSelectedId(match.id);
    setExplainFor(match.id);
  }, [open, held]);

  /* `orca://plan?mode=deps&focus=<id>`: the mode, and the item (id or slug) or the node it
     names. Once per link, for the same reason as above. */
  const focusKey = focus === undefined ? undefined : `${focus.mode ?? ""}|${focus.id ?? ""}`;
  const focused = useRef<string | undefined>(undefined);
  /* The mode is applied before the item is looked up, and once: a link to an item this plan
     does not have (deleted, a slug typo) still lands on the mode it named. */
  const moded = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (focus === undefined || focusKey === undefined) {
      focused.current = undefined;
      moded.current = undefined;
      return;
    }
    if (moded.current !== focusKey) {
      moded.current = focusKey;
      if (focus.mode !== undefined && isPlanMode(focus.mode)) setMode(focus.mode);
    }
    if (focused.current === focusKey) return;
    if (focus.id !== undefined) {
      if (focus.id.startsWith("decision:") || focus.id.startsWith("external:")) setTargetNode(focus.id);
      else {
        const match = held.find((item) => item.id === focus.id || item.slug === focus.id);
        if (!match) return;
        setTargetNode(undefined);
        setSelectedId(match.id);
      }
    }
    focused.current = focusKey;
  }, [focus, focusKey, held]);

  /* The explanation is read when it is opened and not before: one `schedule.explain` per
     item a person actually asks about, rather than one per row in the table. */
  useEffect(() => {
    if (planId === undefined || explainFor === undefined) {
      setLines(undefined);
      setExplainError(undefined);
      return;
    }
    let live = true;
    setLines(undefined);
    setExplainError(undefined);
    void window.orca.plan.explain({ planId, workItemId: explainFor }).then((result) => {
      if (!live) return;
      /* A daemon that cannot explain an item says so as a protocol error, and the popover
         says the code rather than inventing a reason the scheduler never gave (rule 12) —
         but it says it *as an error*, not as a line. The lines are the scheduler's own
         account and each one is a row a person can copy; a failure folded in among them
         would be a sentence ORCA never wrote, carried off on the clipboard as though it
         had. So the two are held apart here and drawn apart in `Explanation`. */
      if (result.ok) setLines(result.result.lines);
      else setExplainError(`${result.error.code}: ${result.error.message}`);
    });
    return () => {
      live = false;
    };
  }, [planId, explainFor]);

  const explain = useCallback((item: PlanItemView) => {
    setSelectedId(item.id);
    setExplainFor(item.id);
  }, []);

  /* `Enter` opens the explanation for the selected row. Registered rather than listened
     for, because the palette is a view of the registry (AGENTS.md); in the `list` scope,
     because that is the table's and the journal's keys are its own. */
  const keyboard = useKeyboard();
  const selectedRef = useRef<PlanItemView | undefined>(undefined);
  selectedRef.current = selected;
  useEffect(() => {
    return keyboard.register({
      scope: "list",
      key: "Enter",
      label: "Explain the selected work item",
      detail: "The scheduler's own account of why the item is where it is",
      action: () => {
        const item = selectedRef.current;
        if (item) explain(item);
      },
    });
  }, [keyboard, explain]);

  /* The modes, handed up with the crumbs: the object header is the chrome's on every
     screen that has an object, and there is one breadcrumb in the app. */
  const crumbs = useMemo<readonly Crumb[]>(
    () =>
      plan === undefined
        ? []
        : selected === undefined
          ? [{ type: "plan" as const, id: plan.id, label: plan.title, current: true }]
          : [
              { type: "plan" as const, id: plan.id, label: plan.title },
              { type: "item" as const, id: selected.id, label: selected.title, current: true },
            ],
    [plan, selected],
  );

  const actions = useMemo(
    () =>
      plan === undefined ? null : (
        // The plan's key, in mono: it is what `orca plan --plan <key>` takes, so it is
        // ORCA's own name for this object rather than prose about it (rule 8).
        <span className={`orca-id ${textClass("mono-id")}`}>{plan.key}</span>
      ),
    [plan],
  );

  const modeControl = useMemo(
    () => ({
      options: PLAN_MODES,
      active: mode,
      onChange: (id: string) => setMode(id as PlanMode),
      label: "Plan view",
    }),
    [mode],
  );

  const report = useRef(onHeader);
  report.current = onHeader;
  useEffect(() => {
    report.current?.({ crumbs, mode: modeControl, actions });
  }, [crumbs, modeControl, actions]);

  /* The inspector goes in the docked panel, which is above every surface — so it is handed
     up the same way the crumbs are rather than drawn in this pane. */
  const live = connection === "live";
  /* Which panel, and what it is about. The risk mode's selection is a risk and its panel
     names itself "Risk"; every other mode's is the work item. `about` is the identity a new
     selection is judged by below. */
  const panel = useMemo((): (PlanPanel & { about: string }) | undefined => {
    if (mode === "risk") {
      return selectedRisk === undefined
        ? undefined
        : {
            about: `risk:${selectedRisk.id}`,
            label: "Risk",
            body: <RiskDetail risk={selectedRisk} journal={riskJournal} onOpenItem={openItem} live={live} />,
          };
    }
    if (mode === "deps") {
      /* The relationship inspector: the edge-shaped panel, about the focused node. */
      const node = graph.nodes.find((n) => n.id === focusedNode);
      if (node === undefined || depsState.phase !== "ready" || planId === undefined) return undefined;
      const { blockedBy, blocks } = relationships(node.id, depsState.dependencies);
      return {
        about: `node:${node.id}:${asked}`,
        label: "Relationships",
        body: (
          <RelationshipInspector
            planId={planId}
            node={node}
            blockedBy={blockedBy}
            blocks={blocks}
            onWaived={patchDeps}
          />
        ),
      };
    }
    return selected === undefined
      ? undefined
      : {
          about: `item:${selected.id}`,
          label: "Work item",
          body: (
            <Inspector item={selected} dependencies={detail.dependencies} risks={detail.risks} onOpenRun={onOpenRun} />
          ),
        };
  }, [
    mode,
    selectedRisk,
    riskJournal,
    openItem,
    live,
    selected,
    detail,
    onOpenRun,
    graph,
    focusedNode,
    depsState,
    planId,
    asked,
    patchDeps,
  ]);
  const reportInspector = useRef(onInspector);
  reportInspector.current = onInspector;
  /* Whether *this* report is a new selection, which is the only thing that may open the
     dock. The content is memoised over `detail`, and the detail lands a tick after the
     selection does — so a report is made twice per click, and a dock that opened on
     "content changed" re-opened itself on the second one. `⌘\` right after a click closed
     a panel that then came straight back. A person closing the dock is closing it. */
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    const about = panel?.about;
    const selectionChanged = shown.current !== about;
    shown.current = about;
    reportInspector.current?.(panel === undefined ? null : { label: panel.label, body: panel.body }, {
      open: selectionChanged && panel !== undefined,
    });
  }, [panel]);

  const filtered = isFiltered(filters);

  if (feed.state.phase === "loading") return <StateView kind="loading" title="Loading the plan" />;
  if (feed.state.phase === "none") {
    return (
      <StateView
        kind="empty"
        title="No plan in this store"
        body="Decompose a request with orca plan, and what is coming appears here."
      />
    );
  }
  if (feed.state.phase === "error" || plan === undefined) {
    const error = feed.state.phase === "error" ? feed.state.error : undefined;
    return live ? (
      <StateView
        kind="error"
        title="Could not load the plan"
        body={error ? `${error.code}: ${error.message}` : ""}
        action={{ label: "Try again", onClick: feed.reload }}
      />
    ) : (
      <StateView
        kind="disconnected"
        title="No daemon to read the plan from"
        body="Start one with orca serve, then try again."
        action={{ label: "Try again", onClick: feed.reload }}
      />
    );
  }

  return (
    <div className="orca-plan">
      {/* Last-known data, said out loud: the values stay and drop to `opacity-stale`, the
          banner says not to trust their freshness. */}
      {!live && (
        <div className={`orca-banner ${textClass("caption")} orca-banner--stale`} role="status">
          <Text style="caption">Not connected — this is the last the daemon said about this plan.</Text>
        </div>
      )}

      {/* Disconnected: the values stay and go quiet at `opacity-stale`, the labels do not
          (docs/design/40-connection-states.md). `.orca-stale-value` is the component
          layer's class for exactly that, so no second opacity is stated here. */}
      <div className={live ? "orca-plan__body" : "orca-plan__body orca-stale-value"}>
        <PlanSidebar
          plan={plan}
          filters={filters}
          onRequest={(requestId) => setFilters((current) => ({ ...current, requestId }))}
          onClassification={(classification: ItemClassification) =>
            setFilters((current) => ({ ...current, classification: toggle(current.classification, classification) }))
          }
          onStatus={(status: ItemStatus) =>
            setFilters((current) => ({ ...current, status: toggle(current.status, status) }))
          }
        />

        {/* The rail's boundary (#276). A request title is as long as somebody made it, so this
            is the one rail whose right width is not the design's to know. */}
        <PaneSplitter boundary="plan-rail" label="Resize the requests rail" />

        <div className="orca-plan__pane">
          {mode === "schedule" ? (
            <>
              <div className="orca-plan__bar">
                <input
                  className={`orca-input ${textClass("mono-body")} orca-plan__text`}
                  type="search"
                  value={filters.text}
                  aria-label="Filter work items"
                  placeholder="Slug or title"
                  onChange={(event) => setFilters((current) => ({ ...current, text: event.target.value }))}
                />
                {/* "Load more" is here rather than as a last row in the table, for the two
                    reasons the journal's "Load earlier" is: `.orca-list__scroller` is an
                    overflow container and a control inside one is clipped by it, and a row
                    that is not a work item would be a row of a different height in a list
                    whose whole arithmetic is `--row-h` (rule 9). The page is appended in
                    place, so nothing a person is looking at moves. */}
                {hasMore && (
                  <button
                    type="button"
                    className={`orca-btn ${textClass("caption")} orca-btn--ghost orca-btn--sm`}
                    onClick={feed.loadMore}
                    disabled={loadingMore}
                  >
                    {loadingMore ? "Loading more items" : "Load more items"}
                  </button>
                )}
                <Text style="caption" className="orca-plan__count">
                  {countLabel(visible.length, total)}
                </Text>
              </div>
              <ScheduleBody
                phase={feed.items.phase}
                visible={visible}
                filtered={filtered}
                live={live}
                error={feed.items.phase === "error" ? `${feed.items.error.code}: ${feed.items.error.message}` : ""}
                selectedId={selectedId}
                onSelect={(item) => selectNode(item.id)}
                onExplain={explain}
                explainFor={explainFor}
                lines={lines}
                explainError={explainError}
                onCloseExplanation={() => setExplainFor(undefined)}
                onOpenRun={onOpenRun}
                onRetry={feed.reload}
                onClearFilter={() => setFilters(NO_FILTERS)}
              />
            </>
          ) : mode === "risk" ? (
            <RiskMode
              state={risksState}
              risks={railRisks}
              selectedId={selectedRisk?.id}
              onSelect={selectRisk}
              live={live}
              onRetry={reloadRisks}
            />
          ) : mode === "decision" ? (
            <DecisionMode
              planId={plan.id}
              state={decisionsState}
              decisions={railDecisions}
              selectedId={selectedDecisionId}
              onSelect={selectDecision}
              live={live}
              onRetry={reloadDecisions}
            />
          ) : mode === "deps" ? (
            <DepsMode
              state={depsState}
              nodes={graph.nodes}
              edges={graph.edges}
              cycle={cycle}
              filters={graphFilters}
              onFilters={setGraphFilters}
              selected={focusedNode}
              onSelect={selectNode}
              onOpen={openNode}
              item={targetNode === undefined ? selected : undefined}
              live={live}
              onRetry={reloadDeps}
            />
          ) : (
            <Journal
              entries={feed.journal.entries}
              hasEarlier={feed.journal.hasEarlier}
              loadingEarlier={feed.journal.loadingEarlier}
              loadEarlier={feed.loadEarlier}
              live={live}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Add or remove one value: a filter rail toggles, it does not accumulate. */
function toggle<T>(values: readonly T[], value: T): readonly T[] {
  return values.includes(value) ? values.filter((held) => held !== value) : [...values, value];
}

interface ScheduleBodyProps {
  phase: "loading" | "error" | "ready";
  visible: readonly PlanItemView[];
  filtered: boolean;
  live: boolean;
  error: string;
  selectedId: string | undefined;
  onSelect: (item: PlanItemView) => void;
  onExplain: (item: PlanItemView) => void;
  explainFor: string | undefined;
  lines: readonly string[] | undefined;
  explainError: string | undefined;
  onCloseExplanation: () => void;
  onOpenRun: (runId: string) => void;
  onRetry: () => void;
  onClearFilter: () => void;
}

/** The table, or the one state view that stands in for it. */
function ScheduleBody(props: ScheduleBodyProps): JSX.Element {
  const { phase, visible, filtered, live, error } = props;

  if (phase === "loading") return <StateView kind="loading" title="Loading the schedule" />;
  if (phase === "error") {
    return live ? (
      <StateView
        kind="error"
        title="Could not load the schedule"
        body={error}
        action={{ label: "Try again", onClick: props.onRetry }}
      />
    ) : (
      <StateView
        kind="disconnected"
        title="No daemon to read the schedule from"
        body="Start one with orca serve, then try again."
        action={{ label: "Try again", onClick: props.onRetry }}
      />
    );
  }
  if (visible.length === 0) {
    return filtered ? (
      <StateView
        kind="no-results"
        title="No items match the filter"
        body="Clear it to see the rest of the plan."
        action={{ label: "Clear the filter", onClick: props.onClearFilter }}
      />
    ) : (
      <StateView
        kind="empty"
        title="No work items yet"
        body="Decompose a request with orca plan, and the schedule appears here."
      />
    );
  }

  return (
    <ScheduleTable
      items={visible}
      selectedId={props.selectedId}
      onSelect={props.onSelect}
      onExplain={props.onExplain}
      explainFor={props.explainFor}
      lines={props.lines}
      explainError={props.explainError}
      onCloseExplanation={props.onCloseExplanation}
      onOpenRun={props.onOpenRun}
    />
  );
}
