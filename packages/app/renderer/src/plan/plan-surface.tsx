/**
 * The Plan surface (#170): what is coming, why it is not moving, and what it depends on.
 *
 * The shape is `runs/`'s — the arithmetic in a plain module with a plain test
 * (`plan-model.ts`), the data in one hook (`use-plan.ts`), the markup composed from
 * `ui/`. What is particular to this one:
 *
 * - **Option B, as designed.** The sidebar is requests and filters rather than a list of
 *   sub-screens, and the modes are a segmented control on the object header — a new
 *   `ObjectHeader` variant (`docs/design/80-dependency-graph-options.md`). Two positions
 *   ship: Schedule and Journal. The dependency graph (#171), the risk matrix (#172) and
 *   the decision matrix (#173) are v0.6.0 and are **absent** from the control rather than
 *   disabled in it, because a position that never does anything is a dead end rather than
 *   a promise.
 * - **Two lists, two scopes.** The schedule table is `list`, the journal is
 *   `plan-journal`. One `VirtualList` per scope, so `J` means "next" in whichever of them
 *   the focus is in.
 * - **The filter is a filter, not a search.** Classification, status and request are
 *   `items.list` parameters and are applied across the whole plan; the text half narrows
 *   what is held, and the count says which ("3 of 9 items").
 * - **A daemon with no plan is a state, not an error.** `plan.read` absent from
 *   `hello.capabilities` means this daemon serves no plan, and so does a store with no
 *   plan in it. Neither is a failure and neither is retried.
 * - **Nothing here writes.** `useWritability()` is not consulted because no control on
 *   this surface sends anything; the writes are the palette's (#178).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import type { ConnectionState } from "@orca/design";
import type { ItemClassification, PlanItemView } from "@orca/protocol";
import { useKeyboard } from "../keyboard-context.js";
import { StateView, Text, textClass, type Crumb, type HeaderMode } from "../ui/index.js";
import { Journal } from "./journal.js";
import { Inspector } from "./inspector.js";
import { PlanSidebar } from "./plan-sidebar.js";
import { ScheduleTable } from "./schedule-table.js";
import { countLabel, isFiltered, matchesText, NO_FILTERS, type ItemStatus, type PlanFilters } from "./plan-model.js";
import { useItemDetail, usePlan } from "./use-plan.js";
import "./plan.css";

/** The two modes that exist. The graph, the risks and the decisions are v0.6.0 (#171–#173). */
export const PLAN_MODES: readonly HeaderMode[] = [
  { id: "schedule", label: "Schedule" },
  { id: "journal", label: "Journal" },
];

export type PlanMode = "schedule" | "journal";

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
  onHeader?: (header: PlanHeader) => void;
  /** The inspector, handed up for the docked panel to draw (the dock is the chrome's). */
  onInspector?: (inspector: ReactNode) => void;
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

function PlanBody({ connection, open, onHeader, onInspector, onOpenRun }: PlanSurfaceProps): JSX.Element {
  const [filters, setFilters] = useState<PlanFilters>(NO_FILTERS);
  const [mode, setMode] = useState<PlanMode>("schedule");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  /** The item whose explanation is open, and the lines once `schedule.explain` has answered. */
  const [explainFor, setExplainFor] = useState<string | undefined>(undefined);
  const [lines, setLines] = useState<readonly string[] | undefined>(undefined);

  const feed = usePlan(filters);
  const plan = feed.state.phase === "ready" ? feed.state.plan : undefined;
  const planId = plan?.id;

  const held = feed.items.phase === "ready" ? feed.items.items : EMPTY;
  const total = feed.items.phase === "ready" ? feed.items.total : 0;
  /* The local half of the filter. The daemon applied the other three across the whole
     plan; this one narrows what came back, and the count below says so. */
  const visible = useMemo(() => held.filter((item) => matchesText(item, filters.text)), [held, filters.text]);

  const selected = useMemo(() => visible.find((item) => item.id === selectedId), [visible, selectedId]);
  const detail = useItemDetail(planId, selected?.id);

  /* A link that arrived. `orca://item/<slug-or-id>` selects the item and opens the
     explanation, which is the information architecture's promise for that URL — so it
     lands once the table has the row, and says nothing when the plan does not have it. */
  useEffect(() => {
    if (open === undefined) return;
    const match = held.find((item) => item.id === open || item.slug === open);
    if (!match) return;
    setMode("schedule");
    setSelectedId(match.id);
    setExplainFor(match.id);
  }, [open, held]);

  /* The explanation is read when it is opened and not before: one `schedule.explain` per
     item a person actually asks about, rather than one per row in the table. */
  useEffect(() => {
    if (planId === undefined || explainFor === undefined) {
      setLines(undefined);
      return;
    }
    let live = true;
    setLines(undefined);
    void window.orca.plan.explain({ planId, workItemId: explainFor }).then((result) => {
      if (!live) return;
      // A daemon that cannot explain an item says so as a protocol error; the popover says
      // the code rather than inventing a reason the scheduler never gave (rule 12).
      setLines(result.ok ? result.result.lines : [`${result.error.code}: ${result.error.message}`]);
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
  const inspector = useMemo(
    () =>
      selected === undefined ? null : (
        <Inspector item={selected} dependencies={detail.dependencies} risks={detail.risks} onOpenRun={onOpenRun} />
      ),
    [selected, detail, onOpenRun],
  );
  const reportInspector = useRef(onInspector);
  reportInspector.current = onInspector;
  useEffect(() => {
    reportInspector.current?.(inspector);
  }, [inspector]);

  const live = connection === "live";
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
                onSelect={(item) => setSelectedId(item.id)}
                onExplain={explain}
                explainFor={explainFor}
                lines={lines}
                onCloseExplanation={() => setExplainFor(undefined)}
                onOpenRun={onOpenRun}
                onRetry={feed.reload}
                onClearFilter={() => setFilters(NO_FILTERS)}
              />
            </>
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
      onCloseExplanation={props.onCloseExplanation}
      onOpenRun={props.onOpenRun}
    />
  );
}
