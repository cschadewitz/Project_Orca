/**
 * The Runs surface: what is happening and what happened
 * (docs/design/10-information-architecture.md).
 *
 * It is a **list**, not the run tree — the tree, with its steps, attempts and children, is
 * its own surface. So every run in the store is one fixed-height row here, whatever its
 * parentage, and a row says the five things that let a person pick one out: status, name,
 * the workflow that produced it, how long it has taken, and the agent doing the work.
 *
 * Three decisions worth knowing before changing anything here:
 *
 * - **The filter is a filter, not a search.** The IA rules out a global search screen and
 *   puts the finding of things in the palette and in per-surface filter fields. The status
 *   half is a `runs.list` parameter, so the daemon applies it across the whole store; the
 *   text half narrows what is already on screen, because the protocol has no text parameter
 *   and a client-side "search" that only saw one page would be a lie.
 * - **Nothing here polls.** The page is read once and every later change arrives as a
 *   `run.changed` notification (`use-runs.ts`).
 * - **There is no progress bar, no ETA and no cost column.** ORCA cannot supply any of the
 *   three and a placeholder is worse than their absence (docs/design/RULES.md rule 12,
 *   docs/design/60-implementation.md). Elapsed time is what the row shows instead.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { CHROME_GLYPHS, STATUS_PRESENTATION, type ConnectionState, type RunStatus } from "@orca/design";
import { DISPLAY_STATUSES, type RunSummaryView } from "@orca/protocol";
import { scopeProps } from "../keyboard-map.js";
import { Duration, Menu, StateView, StatusChip, Text, type MenuItem } from "../ui/index.js";
import { matchesText } from "./run-rows.js";
import { useRunSelection } from "./use-run-selection.js";
import { useRuns, type StatusFilter } from "./use-runs.js";
import "./runs.css";

export interface RunsSurfaceProps {
  /** Whether the daemon is answering. A list nobody is updating says so rather than lying. */
  connection: ConnectionState;
}

/** `aria-activedescendant` needs a DOM id per row, and a row needs one that is stable. */
const rowId = (runId: string): string => `run-row-${runId}`;

/** A stable empty page, so `visible` is not recomputed on every render before the data lands. */
const EMPTY: readonly RunSummaryView[] = [];

/** "All statuses" plus the eight, in the design system's order. */
const STATUS_ITEMS: readonly MenuItem[] = [
  { id: "all", label: "All statuses" },
  ...DISPLAY_STATUSES.map((status) => ({ id: status, label: STATUS_PRESENTATION[status].word })),
];

const statusLabel = (status: StatusFilter): string =>
  status === "all" ? "All statuses" : STATUS_PRESENTATION[status].word;

/** "7 runs", or "3 of 7 runs" once the text filter has narrowed what the daemon sent. */
function countLabel(shown: number, total: number): string {
  const runs = `${total} ${total === 1 ? "run" : "runs"}`;
  return shown === total ? runs : `${shown} of ${runs}`;
}

export function RunsSurface({ connection }: RunsSurfaceProps): JSX.Element {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [text, setText] = useState("");
  const { state, reload } = useRuns(status);

  const runs = state.phase === "ready" ? state.runs : EMPTY;
  const visible = useMemo(() => runs.filter((run) => matchesText(run, text)), [runs, text]);
  const ids = useMemo(() => visible.map((run) => run.id), [visible]);
  const { selectedId, select } = useRunSelection(ids);

  /* Keep the selected row on screen when a key moved the selection rather than the mouse.
     `block: "nearest"` so a row already visible does not scroll under the person's eyes. */
  useEffect(() => {
    if (selectedId === undefined) return;
    const row = document.getElementById(rowId(selectedId));
    // happy-dom has no layout and no `scrollIntoView`; the guard keeps the tests honest
    // about what they are asserting rather than making them stub a DOM method.
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const live = connection === "live";
  const filtered = status !== "all" || text.trim() !== "";

  return (
    <div className="orca-runs" {...scopeProps("list")}>
      {/* Last-known data, said out loud: the values stay, the banner says not to trust their
          freshness (docs/design/40-connection-states.md). */}
      {!live && state.phase === "ready" && (
        <div className="orca-banner orca-banner--stale" role="status">
          <Text style="caption">Not connected — these runs are the last the daemon sent.</Text>
        </div>
      )}

      <div className="orca-runs__filters">
        <input
          className="orca-input orca-runs__text"
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
          triggerClassName="orca-btn orca-btn--ghost orca-btn--sm"
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

      <Body
        state={state}
        visible={visible}
        selectedId={selectedId}
        live={live}
        filtered={filtered}
        connection={connection}
        onSelect={select}
        onRetry={reload}
        onClearFilter={() => {
          setText("");
          setStatus("all");
        }}
      />
    </div>
  );
}

interface BodyProps {
  state: ReturnType<typeof useRuns>["state"];
  visible: readonly RunSummaryView[];
  selectedId: string | undefined;
  live: boolean;
  filtered: boolean;
  connection: ConnectionState;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onClearFilter: () => void;
}

/** The list, or the one state view that stands in for it. */
function Body(props: BodyProps): JSX.Element {
  const { state, visible, selectedId, live, filtered, connection, onSelect, onRetry, onClearFilter } = props;

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
    <div
      className="orca-runs__list"
      role="listbox"
      aria-label="Runs"
      tabIndex={0}
      {...(selectedId !== undefined ? { "aria-activedescendant": rowId(selectedId) } : {})}
    >
      {visible.map((run) => (
        <RunRow key={run.id} run={run} selected={run.id === selectedId} live={live} onSelect={onSelect} />
      ))}
    </div>
  );
}

interface RunRowProps {
  run: RunSummaryView;
  selected: boolean;
  live: boolean;
  onSelect: (id: string) => void;
}

/**
 * One run as a row. The status chip is first in the DOM as well as on screen, so the row's
 * accessible name starts with the status word — "failed, SSO rollout, nightly v1"
 * (docs/design/50-accessibility-and-keyboard.md).
 *
 * The row is an `option`, not a button: it is not focusable itself. Focus stays on the
 * listbox and `aria-activedescendant` names the selected row, which is what keeps one tab
 * stop over a list that may be thousands of rows long.
 */
function RunRow({ run, selected, live, onSelect }: RunRowProps): JSX.Element {
  // `DisplayStatus` and the design system's `RunStatus` are the same eight words, pinned
  // against each other in packages/protocol/test — so no fold and no cast here.
  const status: RunStatus = run.status;
  /* Elapsed while the run is going, total once it has stopped. A disconnected app stops the
     clock: a duration accruing against a daemon that is not talking is an invented number. */
  const accruing = live && run.finishedAt === undefined && run.startedAt !== undefined;

  /* The system's row, and its selected modifier — but not its status modifiers. In
     components.css `--running`, `--waiting` and `--failed` are declared *after* `--selected`
     at the same specificity and all four set the same left rail, so a selected failed row
     would draw a red rail and nothing on screen would say what is selected. The rail is
     selection's (accent, rule 5) and status is the chip's (glyph, word, colour third, rules
     3 and 4), which is the reading the accessibility doc's selection paragraph takes. The
     run tree will have to settle the same question when it arrives. */
  const className = ["orca-tree-row", "orca-tree-row--run", selected ? "orca-tree-row--selected" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      id={rowId(run.id)}
      className={className}
      role="option"
      aria-selected={selected}
      onClick={() => onSelect(run.id)}
    >
      <StatusChip status={status} className="orca-runs__chip" />
      <span className="orca-tree-row__name orca-runs__name">{run.name}</span>
      <span className="orca-tree-row__meta">
        <span className="orca-id orca-runs__workflow">
          {run.workflowId}
          <span className="orca-faint"> v{run.workflowVersion}</span>
        </span>
        <RunDuration run={run} accruing={accruing} stale={!live} />
        <span className="orca-id orca-runs__agent">{run.agentId ?? ""}</span>
      </span>
    </div>
  );
}

/** The duration cell, kept apart so the three cases it has are readable. */
function RunDuration({
  run,
  accruing,
  stale,
}: {
  run: RunSummaryView;
  accruing: boolean;
  stale: boolean;
}): JSX.Element {
  const className = ["orca-tree-row__dur", "orca-runs__dur", stale ? "orca-stale-value" : ""].filter(Boolean).join(" ");

  if (accruing && run.startedAt !== undefined) {
    return <Duration since={new Date(run.startedAt)} className={className} />;
  }
  // A run that has not started has no duration at all, and an empty cell is the honest
  // rendering of that — the column still holds its width, so the rows below stay aligned.
  if (run.durationMs === undefined) return <span className={className} />;
  return <Duration ms={run.durationMs} className={className} />;
}
