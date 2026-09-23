/**
 * The risk mode of Plan (#172): the plan's matrix over its register, split by a stacked
 * `PaneSplitter`.
 *
 * The matrix is the picture and the register is the same risks as rows — the one a keyboard
 * walks with `J`/`K`, in the `list` scope the schedule table holds in its own mode (the two
 * are never mounted together). Selecting a risk in either selects it in both, and hands its
 * detail up to the docked panel, which is the surface's and not this mode's.
 *
 * The split is a layout of its own, so it bounds both halves and says where each scrolls: the
 * matrix region scrolls when a 10×10 grid is taller than its share, and the register is a
 * `VirtualList`, which scrolls itself.
 */
import { useCallback, useMemo, type JSX } from "react";
import type { RiskView } from "@orca/protocol";
import { PaneSplitter } from "../chrome/pane-splitter.js";
import { VirtualList } from "../list/index.js";
import { Chip, RiskMatrix, StateView, Text, textClass, type RiskLevel } from "../ui/index.js";
import { riskCountLabel } from "./risk-model.js";
import type { RisksState } from "./use-risks.js";

export interface RiskModeProps {
  state: RisksState;
  /** What the rail leaves on screen, already narrowed (`risksForRail`). */
  risks: readonly RiskView[];
  selectedId: string | undefined;
  onSelect: (risk: RiskView) => void;
  live: boolean;
  onRetry: () => void;
}

export const riskRowId = (id: string): string => `plan-risk-${id}`;

export function RiskMode({ state, risks, selectedId, onSelect, live, onRetry }: RiskModeProps): JSX.Element {
  if (state.phase === "loading") return <StateView kind="loading" title="Loading the risks" />;
  if (state.phase === "error") {
    return live ? (
      <StateView
        kind="error"
        title="Could not load the risks"
        body={`${state.error.code}: ${state.error.message}`}
        action={{ label: "Try again", onClick: onRetry }}
      />
    ) : (
      <StateView
        kind="disconnected"
        title="No daemon to read the risks from"
        body="Start one with orca serve, then try again."
        action={{ label: "Try again", onClick: onRetry }}
      />
    );
  }
  return (
    <RiskSplit
      risks={risks}
      total={state.risks.length}
      scale={state.matrix.scale}
      thresholds={state.matrix.thresholds}
      appetite={state.appetite}
      selectedId={selectedId}
      onSelect={onSelect}
    />
  );
}

interface RiskSplitProps {
  risks: readonly RiskView[];
  total: number;
  scale: number;
  thresholds: { medium: number; high: number; critical: number };
  appetite: RiskLevel;
  selectedId: string | undefined;
  onSelect: (risk: RiskView) => void;
}

function RiskSplit({ risks, total, scale, thresholds, appetite, selectedId, onSelect }: RiskSplitProps): JSX.Element {
  const byId = useMemo(() => new Map(risks.map((risk) => [risk.id, risk])), [risks]);
  const selectById = useCallback(
    (id: string) => {
      const risk = byId.get(id);
      if (risk) onSelect(risk);
    },
    [byId, onSelect],
  );
  const selectedIndex = useMemo(() => {
    const at = risks.findIndex((risk) => risk.id === selectedId);
    return at === -1 ? undefined : at;
  }, [risks, selectedId]);

  return (
    <div className="orca-plan__risk">
      <div className="orca-plan__matrix">
        <RiskMatrix
          scale={scale}
          thresholds={thresholds}
          appetite={appetite}
          risks={risks}
          selected={selectedId}
          onSelect={selectById}
        />
        {/* The appetite line in words, because an outline is a shape and a shape is not a
            sentence (rule 4). The thresholds are the plan's own, so they are said too. */}
        <Text style="caption" className="orca-plan__legend">
          {`Outlined cells are above the plan's risk appetite (${appetite}). Hatched cells are critical, from ${thresholds.critical}; high from ${thresholds.high}, medium from ${thresholds.medium}.`}
        </Text>
      </div>

      <PaneSplitter boundary="plan-risk" label="Resize the risk matrix" />

      <div className="orca-plan__register">
        <div className="orca-plan__bar">
          <Text style="label-strong">Risks</Text>
          <Text style="caption" className="orca-plan__count">
            {riskCountLabel(risks.length, total)}
          </Text>
        </div>
        {risks.length === 0 ? (
          <StateView kind="empty" title="No risks here" body="No risk holds the items the filter leaves on screen." />
        ) : (
          <VirtualList
            className="orca-plan__table"
            label="Risk register"
            noun="risk"
            scope="list"
            items={risks}
            rowId={(risk) => riskRowId(risk.id)}
            rowClassName={(_risk, _index, selected) =>
              selected ? "orca-plan__risk-row orca-plan__row--selected" : "orca-plan__risk-row"
            }
            renderRow={(risk) => <RiskRow risk={risk} />}
            selectedIndex={selectedIndex}
            onSelect={(index) => {
              const risk = risks[index];
              if (risk) onSelect(risk);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** One risk as a row: key, title, ratings, level and status — each a fact the wire carries. */
function RiskRow({ risk }: { risk: RiskView }): JSX.Element {
  return (
    <>
      <span className={`orca-plan__id ${textClass("mono-id")}`}>{risk.key}</span>
      <span className={`orca-plan__cell ${textClass("label")}`}>{risk.title}</span>
      <span className={`orca-plan__score ${textClass("mono-id")}`}>{`L${risk.likelihood} × I${risk.impact}`}</span>
      <span className="orca-plan__cell">
        <Chip>{risk.level}</Chip>
      </span>
      <span className="orca-plan__cell">
        <Chip>{risk.status}</Chip>
      </span>
    </>
  );
}
