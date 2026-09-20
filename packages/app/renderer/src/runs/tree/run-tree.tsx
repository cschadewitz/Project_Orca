/**
 * The run tree: a run, its steps, its attempts and its child runs as one list of rows
 * (#156). A finished run replays into the same components a live one streams into — there
 * is no "historical" rendering here, which is what makes opening yesterday's failure the
 * same code path as watching this morning's.
 *
 * What a row says, in this order, because the order *is* the accessible name: the status
 * glyph and word, then the machine name, then the attempt, then the meta a person scans
 * rather than reads. "failed, build, attempt 2 of 3" — status first
 * (docs/design/50-accessibility-and-keyboard.md), and glyph plus word on every row, so a
 * greyscale screenshot still reads (rules 3 and 4).
 *
 * Two things this file deliberately does not do:
 *
 * - **No percentage.** A running run draws an indeterminate `.orca-meter` and nothing
 *   more. A workflow graph with loops and conditional branches has no completion fraction,
 *   ORCA cannot supply one, and approximating it is what rule 12 forbids
 *   (docs/design/60-implementation.md). The meter is `aria-hidden`: it says "going", which
 *   the status chip beside it already says in words.
 * - **No indent past six levels.** `--level` stops climbing at `MAX_INDENT` and the
 *   ancestor chain moves into the sticky header, so a step eight deep does not start 200px
 *   from the left edge (docs/design/30-long-running-content.md).
 *
 * **One thing it cannot do, and it is a finding, not an oversight.** #156 asks for
 * `role="tree"` with `treeitem` rows carrying `aria-level` and `aria-expanded`. The list
 * substrate owns the row element and hard-codes `role="listbox"` on the rows container and
 * `role="option"` per row (`list/virtual-list.tsx`), with no prop to change either and no
 * way to reach the element from `renderRow`. Adding that hook is a change in `list/`,
 * which this unit does not own, so the tree ships as a listbox whose rows are named
 * status-first and whose depth is visible but not announced. See the hand-back.
 */
import { useCallback, useMemo, type CSSProperties, type JSX } from "react";
import { CHROME_GLYPHS, STATUS_PRESENTATION } from "@orca/design";
import { VirtualList, type MinimapKind, type VirtualListTick } from "../../list/index.js";
import { Duration, StateView, StatusChip, Text, textClass } from "../../ui/index.js";
import { parentIndex, treeRowId, SKIPPED_WORD, type TreeRow } from "./tree-rows.js";
import { useTreeKeys } from "./use-tree-keys.js";
import type { RunTree as RunTreeModel } from "./use-run-tree.js";

export interface RunTreeProps {
  tree: RunTreeModel;
  selectedRunId: string | undefined;
  selectedStepRunId: string | undefined;
  /** A click or a key landed on a row. The surface turns it into one selection. */
  onSelect: (row: TreeRow) => void;
  /** `Enter`, or a second click: show this row in the step detail beside the tree. */
  onOpen: (row: TreeRow) => void;
  /** Whether the daemon is answering. A disconnected tree stops its clocks. */
  live: boolean;
}

/** The three the gutter marks: a failure, a run asking for a person, a run that cannot move. */
const TICK_KINDS: Readonly<Record<string, MinimapKind>> = {
  failed: "failed",
  waiting: "waiting",
  blocked: "blocked",
};

export function RunTree({ tree, selectedRunId, selectedStepRunId, onSelect, onOpen, live }: RunTreeProps): JSX.Element {
  const { rows } = tree;

  /*
   * The selection is the surface's, and it is said in ids — a run and a step run — because
   * that is how the timeline says it too. The tree turns it back into a row index.
   *
   * A `note` row resolves to the step it is about: a skipped branch is a fact about a
   * fan-out, not an object with a log of its own, and selecting it selects the fan-out.
   */
  const selectedIndex = useMemo(() => {
    const at =
      selectedStepRunId === undefined
        ? -1
        : rows.findIndex((row) => row.kind !== "note" && row.stepRunId === selectedStepRunId);
    if (at !== -1) return at;
    if (selectedRunId === undefined) return undefined;
    const run = rows.findIndex(
      (row) => (row.kind === "run" || row.kind === "child-run") && row.runId === selectedRunId,
    );
    return run === -1 ? undefined : run;
  }, [rows, selectedRunId, selectedStepRunId]);

  const ticks = useMemo<VirtualListTick[]>(
    () =>
      rows.flatMap((row, index) => {
        const kind = row.status === undefined ? undefined : TICK_KINDS[row.status];
        if (!kind || row.status === undefined) return [];
        return [{ index, kind, label: `${row.name}, ${STATUS_PRESENTATION[row.status].word}` }];
      }),
    [rows],
  );

  const selectAt = useCallback(
    (index: number) => {
      const row = rows[index];
      if (row) onSelect(row);
    },
    [rows, onSelect],
  );

  useTreeKeys(
    {
      expand: () => {
        if (selectedIndex === undefined) return;
        const row = rows[selectedIndex];
        if (!row) return;
        // Open what is closed; step into what is already open, which is what a tree's `→`
        // does once there is nothing left to reveal.
        if (row.hasChildren && !row.expanded) tree.expand(row.key);
        else if (row.expanded) selectAt(selectedIndex + 1);
      },
      collapse: () => {
        if (selectedIndex === undefined) return;
        const row = rows[selectedIndex];
        if (!row) return;
        if (row.expanded) {
          tree.collapse(row.key);
          return;
        }
        const up = parentIndex(rows, selectedIndex);
        if (up !== undefined) selectAt(up);
      },
      expandDeep: () => {
        const row = selectedIndex === undefined ? undefined : rows[selectedIndex];
        if (row) tree.expandDeep(row.key);
      },
      open: () => {
        const row = selectedIndex === undefined ? undefined : rows[selectedIndex];
        if (row) onOpen(row);
      },
      toggleAttention: tree.toggleAttention,
    },
    tree.attentionOnly,
  );

  /* The only way a tree with runs in it empties is `F`, because the roots are the run list
     the surface already found rows for. So this is the filter's own no-results view, with
     the way back in it rather than a dead end. */
  if (rows.length === 0 && tree.attentionOnly) {
    return (
      <StateView
        kind="no-results"
        className="orca-runs__tree-state"
        title="No failed or waiting rows"
        body="Press F to show the whole tree again."
        action={{ label: "Show every row", onClick: tree.toggleAttention }}
      />
    );
  }

  const selected = selectedIndex === undefined ? undefined : rows[selectedIndex];

  return (
    <VirtualList
      className="orca-runs__tree"
      label="Run tree"
      noun="row"
      scope="run-tree"
      items={rows}
      ticks={ticks}
      header={<TreeHeader row={selected} filtered={tree.attentionOnly} />}
      rowId={(row) => treeRowId(row.key)}
      rowClassName={rowClassName}
      renderRow={(row) => <RunTreeRow row={row} live={live} onToggle={() => tree.toggle(row.key)} />}
      selectedIndex={selectedIndex}
      onSelect={selectAt}
    />
  );
}

/**
 * The system's row class and its selected modifier, and not its status modifiers — the
 * same reading `runs-surface.tsx` takes: in components.css `--running`, `--waiting` and
 * `--failed` are declared after `--selected` at the same specificity and all four set the
 * left rail, so a selected failed row would draw a red rail and nothing would say what is
 * selected. The rail is selection's (accent, rule 5); status is the chip's (rules 3 and 4).
 */
const rowClassName = (row: TreeRow, _index: number, selected: boolean): string =>
  [
    "orca-tree-row",
    `orca-tree-row--${row.kind === "child-run" ? "run" : row.kind}`,
    selected ? "orca-tree-row--selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

/**
 * The sticky header: where the selected row is, said as the chain above it.
 *
 * It is the *selected* row's chain rather than the topmost visible row's, which is what
 * docs/design/30-long-running-content.md describes. The substrate windows the list and
 * does not tell a surface which row is at the top of the viewport, so the chain that is
 * available is the one the person is on. Noted in the hand-back with the rest.
 */
function TreeHeader({ row, filtered }: { row: TreeRow | undefined; filtered: boolean }): JSX.Element {
  return (
    <span className="orca-runs__tree-head">
      {row === undefined || row.ancestors.length === 0 ? (
        <Text style="label-strong">Run tree</Text>
      ) : (
        <span className={`orca-id ${textClass("mono-id")}`}>
          {row.ancestors.map((name, at) => (
            <span key={`${at}-${name}`}>
              {at > 0 && (
                <span className="orca-faint" aria-hidden="true">
                  {` ${CHROME_GLYPHS.crumbSeparator} `}
                </span>
              )}
              {name}
            </span>
          ))}
        </span>
      )}
      {filtered && (
        <Text style="caption" className="orca-runs__tree-filtered">
          failed and waiting only
        </Text>
      )}
    </span>
  );
}

interface RunTreeRowProps {
  row: TreeRow;
  live: boolean;
  onToggle: () => void;
}

/**
 * One row's cells, inside the row element the substrate draws around them.
 *
 * The twisty is `aria-hidden` and so is the guide: both are pictures of the structure the
 * row's position already carries, and a screen reader reading "triangle" before every name
 * would bury the thing the row is about.
 */
function RunTreeRow({ row, live, onToggle }: RunTreeRowProps): JSX.Element {
  const accruing = live && row.finished !== true && row.startedAt !== undefined;

  return (
    <>
      {/* One hairline per level above this row. A border, not a box-drawing glyph: at
          mono-log's line height `│` leaves a gap at every line boundary (#212). */}
      {Array.from({ length: row.indent }, (_unused, level) => (
        <span
          key={level}
          className="orca-tree-guide orca-runs__guide"
          aria-hidden="true"
          style={{ "--guide": level + 1 } as CSSProperties}
        />
      ))}
      <button
        type="button"
        className={[
          "orca-bare",
          "orca-tree-row__twisty",
          row.hasChildren ? "" : "orca-tree-row__twisty--empty",
          row.expanded ? "orca-runs__twisty--open" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        tabIndex={-1}
        aria-hidden="true"
        onClick={(event) => {
          // The row element around this one is the substrate's and selects on click; a
          // twisty that also selected would make "open this" and "go to this" one act.
          event.stopPropagation();
          onToggle();
        }}
      >
        {/* The bundled symbol face has no downward triangle, so the open state is this
            glyph turned a quarter — the same trick `.orca-crumb__more` uses. */}
        {row.hasChildren ? CHROME_GLYPHS.crumbSeparator : ""}
      </button>

      {row.status === undefined ? (
        <span className={`orca-tree-row__note ${textClass("label")} orca-runs__skipped`}>{SKIPPED_WORD}</span>
      ) : (
        <StatusChip status={row.status} className="orca-runs__chip" />
      )}

      <span className={`orca-tree-row__name ${textClass("mono-strong")} orca-runs__name`}>{row.name}</span>

      {row.attempt !== undefined && (
        <Text style="caption" className="orca-runs__attempt">
          {`attempt ${row.attempt.n} of ${row.attempt.of}`}
        </Text>
      )}
      {row.note !== undefined && (
        <Text style="label" className="orca-tree-row__note">
          {row.note}
        </Text>
      )}
      {row.loading && (
        <Text style="caption" className="orca-runs__loading">
          loading
        </Text>
      )}

      <span className={`orca-tree-row__meta ${textClass("caption")}`}>
        {/* Indeterminate, and never a percentage: ORCA has no completion fraction to give
            (rule 12). Decorative — the chip beside it already says "running" in words. */}
        {row.meter && (
          <span className="orca-meter orca-runs__meter" aria-hidden="true">
            <span className="orca-meter__fill" />
          </span>
        )}
        <RowDuration row={row} accruing={accruing} stale={!live} />
        <span className={`orca-id ${textClass("mono-id")} orca-runs__agent`}>{row.agent ?? ""}</span>
      </span>
    </>
  );
}

/** Elapsed while it runs, total once it has stopped, empty when it never started. */
function RowDuration({ row, accruing, stale }: { row: TreeRow; accruing: boolean; stale: boolean }): JSX.Element {
  const className = ["orca-tree-row__dur", textClass("mono-id"), "orca-runs__dur", stale ? "orca-stale-value" : ""]
    .filter(Boolean)
    .join(" ");

  if (accruing && row.startedAt !== undefined)
    return <Duration since={new Date(row.startedAt)} className={className} />;
  if (row.durationMs === undefined) return <span className={className} />;
  return <Duration ms={row.durationMs} className={className} />;
}
