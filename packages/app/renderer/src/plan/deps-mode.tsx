/**
 * The dependency graph as a mode of Plan (#171) — option B of
 * `docs/design/80-dependency-graph-options.md`, with option A's inspector in the dock.
 *
 * Three things beside the canvas, and each is B's answer to one of A's reasons:
 *
 * - **A second rail for what only the graph has**: which kinds of edge to draw, and whether to
 *   leave out what no longer holds anything. The row filters stay in the first rail, shared
 *   with the schedule — that rail decides which items are on the canvas.
 * - **Shared selection.** The selected row is the focused node and the reverse, because the
 *   surface holds one item selection and both modes read it.
 * - **A pinned row strip** under the canvas for the selected item: its schedule class, slug,
 *   title and status, the row the table would show, so leaving the mode costs nothing.
 *
 * The split is a column of its own — canvas over strip — so the canvas is the region that
 * scrolls and the strip is a fixed row.
 */
import type { JSX } from "react";
import type { PlanItemView } from "@orca/protocol";
import { PaneSplitter } from "../chrome/pane-splitter.js";
import { Chip, ScheduleBadge, StateView, StatusChip, Text, textClass } from "../ui/index.js";
import { DependencyGraph } from "./dependency-graph.js";
import { DEPENDENCY_KINDS, type DepEdge, type DepNode, type DependencyKind, type GraphFilters } from "./graph-model.js";
import { classificationMark, workItemStatusMark } from "./plan-model.js";
import type { DependenciesState } from "./use-dependencies.js";
import { NoDaemonView } from "../first-run/no-daemon-view.js";

export interface DepsModeProps {
  state: DependenciesState;
  nodes: readonly DepNode[];
  edges: readonly DepEdge[];
  cycle: ReadonlySet<string>;
  filters: GraphFilters;
  onFilters: (filters: GraphFilters) => void;
  selected: string | undefined;
  onSelect: (nodeId: string) => void;
  onOpen: (nodeId: string) => void;
  /** The selected work item, for the strip. */
  item: PlanItemView | undefined;
  live: boolean;
  onRetry: () => void;
}

const STROKE_WORD: Record<DependencyKind, string> = { blocks: "solid", soft: "dashed", informs: "dotted" };

export function DepsMode(props: DepsModeProps): JSX.Element {
  const { state, filters, onFilters, live, onRetry } = props;

  const body = ((): JSX.Element => {
    if (state.phase === "loading") return <StateView kind="loading" title="Loading the dependencies" />;
    if (state.phase === "error") {
      return live ? (
        <StateView
          kind="error"
          title="Could not load the dependencies"
          body={`${state.error.code}: ${state.error.message}`}
          action={{ label: "Try again", onClick: onRetry }}
        />
      ) : (
        <NoDaemonView title="No daemon to read the dependencies from" onRetry={onRetry} />
      );
    }
    if (props.nodes.length === 0) {
      return <StateView kind="no-results" title="Nothing to draw" body="No work item is left by the filters." />;
    }
    return (
      <DependencyGraph
        nodes={props.nodes}
        edges={props.edges}
        cycle={props.cycle}
        selected={props.selected}
        onSelect={props.onSelect}
        onOpen={props.onOpen}
      />
    );
  })();

  return (
    <div className="orca-plan__deps">
      <nav className="orca-plan__graph-rail" aria-label="Graph controls">
        <div className="orca-plan__group">
          <Text style="eyebrow" as="h2">
            Edges
          </Text>
          <div className="orca-chips">
            {DEPENDENCY_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className={`orca-plan__filter ${textClass("caption")}`}
                aria-pressed={filters.kinds.includes(kind)}
                onClick={() =>
                  onFilters({
                    ...filters,
                    kinds: filters.kinds.includes(kind)
                      ? filters.kinds.filter((k) => k !== kind)
                      : [...filters.kinds, kind],
                  })
                }
              >
                {`${kind}, ${STROKE_WORD[kind]}`}
              </button>
            ))}
            <button
              type="button"
              className={`orca-plan__filter ${textClass("caption")}`}
              aria-pressed={filters.unmetOnly}
              onClick={() => onFilters({ ...filters, unmetOnly: !filters.unmetOnly })}
            >
              Unmet only
            </button>
          </div>
        </div>
        {props.cycle.size > 0 && (
          <Text style="caption" className="orca-plan__legend">
            Heavy edges close a cycle of blocks: nothing on one can start.
          </Text>
        )}
      </nav>

      {/* The second rail is the same kind of pane as the first, so it shares the first's
          boundary id and its remembered width (#276). */}
      <PaneSplitter boundary="plan-rail" label="Resize the graph controls" />

      <div className="orca-plan__graph">
        {body}
        <Strip item={props.item} />
      </div>
    </div>
  );
}

/** The selected item as the schedule row draws it, pinned under the canvas. */
function Strip({ item }: { item: PlanItemView | undefined }): JSX.Element {
  if (item === undefined) {
    return (
      <div className="orca-plan__strip" role="group" aria-label="Selected work item">
        <Text style="caption">Select a work item to pin its row here.</Text>
      </div>
    );
  }
  const mark = classificationMark(item.classification);
  const status = workItemStatusMark(item.status);
  return (
    <div className="orca-plan__strip" role="group" aria-label="Selected work item">
      {mark.kind === "badge" ? (
        <ScheduleBadge classification={mark.classification} />
      ) : (
        <StatusChip status={mark.status} />
      )}
      <span className={`orca-plan__id ${textClass("mono-id")}`}>{item.slug}</span>
      <span className={`orca-plan__cell ${textClass("label")}`}>{item.title}</span>
      <Chip {...(status.glyph === undefined ? {} : { glyph: status.glyph })}>{status.word}</Chip>
      {item.priority !== undefined && (
        <span className={`orca-plan__score ${textClass("mono-id")}`}>{item.priority.score.toFixed(1)}</span>
      )}
    </div>
  );
}
