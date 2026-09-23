/**
 * The decision mode of Plan (#173): the plan's decisions as a list, over the selected one's
 * weighted matrix, split by a stacked `PaneSplitter`.
 *
 * The list is a `grid` rather than a `listbox` because a row can hold a control — the link to
 * the decision it supersedes — and a control inside an `option` is one nothing can reach.
 * Below it, the matrix: criteria and weights, options and scores, the weighted totals, and the
 * recommended column outlined in accent. That column is never applied by the app. A person
 * decides — from a column header here, or from the palette — and says why if they want to,
 * and the request is the CLI's (`decideParams`).
 *
 * Two things this mode does *not* do:
 *
 * - **It does not put a decision on Attention.** A plan decision is a gate-tier item only
 *   while a workflow's `decision` node has parked a run on it, and nothing on the wire ties
 *   an `OpenInputView` to a plan decision key yet; until one does, a decision is Plan's.
 * - **It does not re-read after a write.** `decisions.decide` and `decisions.reopen` journal,
 *   the daemon pushes `plan.changed`, and the read above this re-runs on that.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type { DecisionView } from "@orca/protocol";
import { useAnnounce } from "../a11y/announce-context.js";
import { useMethodPresent, useWritability } from "../chrome/use-connection.js";
import { PaneSplitter } from "../chrome/pane-splitter.js";
import { VirtualList } from "../list/index.js";
import { Button, Chip, DecisionMatrix, StateView, Text, Time, textClass } from "../ui/index.js";
import { confidenceWord, decideParams, optionName, recommendedOf, reopenQuestion } from "./decision-model.js";
import type { DecisionsState } from "./use-decisions.js";
import { useDecisionWrites } from "./use-decision-writes.js";

export interface DecisionModeProps {
  planId: string;
  state: DecisionsState;
  /** What the rail leaves on screen (`decisionsForRail`). */
  decisions: readonly DecisionView[];
  selectedId: string | undefined;
  onSelect: (decision: DecisionView) => void;
  live: boolean;
  onRetry: () => void;
}

export const decisionRowId = (id: string): string => `plan-decision-${id}`;

export function DecisionMode(props: DecisionModeProps): JSX.Element {
  const { state, live, onRetry } = props;
  if (state.phase === "loading") return <StateView kind="loading" title="Loading the decisions" />;
  if (state.phase === "error") {
    return live ? (
      <StateView
        kind="error"
        title="Could not load the decisions"
        body={`${state.error.code}: ${state.error.message}`}
        action={{ label: "Try again", onClick: onRetry }}
      />
    ) : (
      <StateView
        kind="disconnected"
        title="No daemon to read the decisions from"
        body="Start one with orca serve, then try again."
        action={{ label: "Try again", onClick: onRetry }}
      />
    );
  }
  return <DecisionSplit {...props} all={state.decisions} />;
}

function DecisionSplit({
  planId,
  decisions,
  all,
  selectedId,
  onSelect,
  live,
}: DecisionModeProps & { all: readonly DecisionView[] }): JSX.Element {
  const selectedIndex = useMemo(() => {
    const at = decisions.findIndex((decision) => decision.id === selectedId);
    return at === -1 ? undefined : at;
  }, [decisions, selectedId]);
  const selected = selectedIndex === undefined ? undefined : decisions[selectedIndex];
  useDecisionWrites(planId, selected);
  const openKey = useCallback(
    (key: string) => {
      const found = all.find((decision) => decision.key === key || decision.id === key);
      if (found) onSelect(found);
    },
    [all, onSelect],
  );

  return (
    <div className="orca-plan__decision">
      <div className="orca-plan__register">
        <div className="orca-plan__bar">
          <Text style="label-strong">Decisions</Text>
          <Text style="caption" className="orca-plan__count">
            {decisions.length === all.length
              ? `${all.length} ${all.length === 1 ? "decision" : "decisions"}`
              : `${decisions.length} of ${all.length} decisions`}
          </Text>
        </div>
        {decisions.length === 0 ? (
          <StateView kind="empty" title="No decisions here" body="No decision gates the items the filter leaves." />
        ) : (
          <VirtualList
            className="orca-plan__table"
            label="Decisions"
            noun="decision"
            scope="list"
            role="grid"
            items={decisions}
            rowId={(decision) => decisionRowId(decision.id)}
            rowClassName={(_d, _i, isSelected) =>
              isSelected ? "orca-plan__decision-row orca-plan__row--selected" : "orca-plan__decision-row"
            }
            renderRow={(decision) => <DecisionRow decision={decision} onOpenKey={openKey} />}
            selectedIndex={selectedIndex}
            onSelect={(index) => {
              const decision = decisions[index];
              if (decision) onSelect(decision);
            }}
          />
        )}
      </div>

      <PaneSplitter boundary="plan-decision" label="Resize the decision list" />

      <div className="orca-plan__decision-detail">
        {selected === undefined ? (
          /* A hint, not a state view: nothing failed or is loading, and a `role="status"`
             here would be a live region that speaks on every mode switch. */
          <Text style="caption" className="orca-plan__hint">
            Select a decision to see its matrix.
          </Text>
        ) : (
          <DecisionDetail key={selected.id} planId={planId} decision={selected} live={live} onOpenKey={openKey} />
        )}
      </div>
    </div>
  );
}

/** One decision as a row: its status, key, title, due-by, the recommendation and the choice. */
function DecisionRow({
  decision,
  onOpenKey,
}: {
  decision: DecisionView;
  onOpenKey: (key: string) => void;
}): JSX.Element {
  const recommended = recommendedOf(decision);
  const confidence = confidenceWord(decision);
  return (
    <>
      <span className="orca-plan__cell" role="gridcell">
        <Chip>{decision.status}</Chip>
      </span>
      <span className={`orca-plan__id ${textClass("mono-id")}`} role="gridcell">
        {decision.key}
      </span>
      <span className={`orca-plan__cell ${textClass("label")}`} role="gridcell">
        {decision.title}
      </span>
      <span className={`orca-plan__cell ${textClass("caption")}`} role="gridcell">
        {decision.dueBy === undefined ? "" : `due ${decision.dueBy}`}
      </span>
      <span className={`orca-plan__cell ${textClass("caption")}`} role="gridcell">
        {decision.chosen !== undefined
          ? `chose ${optionName(decision, decision.chosen)}`
          : recommended === undefined
            ? ""
            : `recommends ${optionName(decision, recommended)}${confidence === undefined ? "" : `, ${confidence}`}`}
      </span>
      <span className="orca-plan__cell" role="gridcell">
        {decision.supersedes !== undefined && (
          <button
            type="button"
            className={`orca-bare orca-link ${textClass("mono-id")}`}
            onClick={() => onOpenKey(decision.supersedes!)}
          >
            {`supersedes ${decision.supersedes}`}
          </button>
        )}
      </span>
    </>
  );
}

interface DecisionDetailProps {
  planId: string;
  decision: DecisionView;
  live: boolean;
  onOpenKey: (key: string) => void;
}

/**
 * The selected decision: its question, the matrix, and either the way to decide it or who
 * decided it, when and why, with the way back.
 */
function DecisionDetail({ planId, decision, live, onOpenKey }: DecisionDetailProps): JSX.Element {
  const announce = useAnnounce();
  const writability = useWritability();
  const canDecide = useMethodPresent("decisions.decide");
  const canReopen = useMethodPresent("decisions.reopen");
  const reason = writability.can ? undefined : writability.reason;

  /** The option a person pressed, awaiting their rationale and a second press. */
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [rationale, setRationale] = useState("");
  /** Whether the reopen question is on screen. It is asked once, here, and not again. */
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPending(undefined);
    setAsking(false);
  }, [decision.status]);

  const recommended = recommendedOf(decision);
  const confidence = confidenceWord(decision);
  const decided = decision.status === "decided" && decision.chosen !== undefined;

  const decide = (): void => {
    if (pending === undefined) return;
    setBusy(true);
    void window.orca.plan.decide(decideParams(planId, decision.key, pending, rationale)).then((result) => {
      setBusy(false);
      setPending(undefined);
      setRationale("");
      announce(
        result.ok
          ? `${decision.key} is decided: ${optionName(decision, result.result.choice)}.`
          : `That did not go through: ${result.error.message}`,
      );
    });
  };

  const reopen = (): void => {
    setBusy(true);
    void window.orca.plan.reopen({ planId, key: decision.key }).then((result) => {
      setBusy(false);
      setAsking(false);
      if (!result.ok) {
        announce(`That did not go through: ${result.error.message}`);
        return;
      }
      const n = result.result.reopenedDependencyIds.length;
      announce(
        `${decision.key} is open again; ${n === 0 ? "nothing" : n === 1 ? "1 dependency" : `${n} dependencies`} reopened with it.`,
      );
    });
  };

  return (
    <section className="orca-plan__inspector" aria-label={`Decision ${decision.key}`}>
      <div className="orca-plan__section">
        <Text style="label-strong" as="h2">
          {decision.title}
        </Text>
        <span className={`orca-plan__id ${textClass("mono-id")}`}>{decision.key}</span>
        {decision.question !== "" && <Text style="caption">{decision.question}</Text>}
      </div>

      <div className="orca-plan__meta">
        <Chip>{decision.status}</Chip>
        {/* An input somebody stated, never a projection: ORCA computes no dates (#174). */}
        {decision.dueBy !== undefined && <Chip>{`due by ${decision.dueBy}`}</Chip>}
        {decision.supersedes !== undefined && (
          <button
            type="button"
            className={`orca-bare orca-link ${textClass("mono-id")}`}
            onClick={() => onOpenKey(decision.supersedes!)}
          >
            {`supersedes ${decision.supersedes}`}
          </button>
        )}
        {decision.blocks.length > 0 && (
          <Text style="caption">{`gates ${decision.blocks.map((ref) => ref.slug).join(", ")}`}</Text>
        )}
      </div>

      {recommended === undefined ? (
        <Text style="caption">
          The matrix has no ranking: an option is missing a score, or there is nothing to rank.
        </Text>
      ) : (
        <p className={`orca-plan__recommendation ${textClass("label")}`}>
          <span>{`The matrix recommends ${optionName(decision, recommended)}`}</span>
          {confidence !== undefined && <Chip>{confidence}</Chip>}
          {decision.resultIsPreview === true && (
            <Text style="caption" className="orca-plan__preview">
              Preview — worked out for this view; nothing has evaluated or decided it yet.
            </Text>
          )}
        </p>
      )}

      <div className="orca-plan__matrix-table">
        <DecisionMatrix
          label={`Decision matrix for ${decision.key}`}
          criteria={decision.criteria}
          options={decision.options}
          scale={decision.scale}
          result={decision.result}
          chosen={decision.chosen}
          {...(!decided && canDecide ? { onChoose: setPending, disabledReason: reason } : {})}
        />
      </div>

      {pending !== undefined && !decided && (
        <form
          className="orca-plan__decide"
          aria-label={`Decide ${decision.key}`}
          onSubmit={(event) => {
            event.preventDefault();
            decide();
          }}
        >
          <label className={`orca-plan__field ${textClass("caption")}`}>
            <span>Rationale, recorded in the journal</span>
            <textarea
              className={`orca-input ${textClass("label")}`}
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
            />
          </label>
          <div className="orca-plan__actions">
            <Button type="submit" tone="primary" size="sm" disabled={busy}>
              {`Decide ${optionName(decision, pending)}`}
            </Button>
            <Button size="sm" tone="ghost" onClick={() => setPending(undefined)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {decided && (
        <section className="orca-plan__section" aria-label="Decided">
          <Text style="eyebrow" as="h3">
            Decided
          </Text>
          <Text style="label">
            {`${optionName(decision, decision.chosen!)}, by ${decision.decidedBy ?? "an unrecorded actor"}`}
            {decision.decidedAt !== undefined && (
              <>
                {" "}
                <Time at={new Date(decision.decidedAt)} show={live ? "both" : "absolute"} />
              </>
            )}
          </Text>
          <Text style="caption">{decision.rationale ?? "No rationale was recorded."}</Text>

          {canReopen &&
            (asking ? (
              <div className="orca-plan__confirm" role="group" aria-label={`Reopen ${decision.key}`}>
                <Text style="caption">{reopenQuestion(decision)}</Text>
                <div className="orca-plan__actions">
                  <Button
                    tone="danger"
                    size="sm"
                    disabled={busy || reason !== undefined}
                    {...(reason === undefined ? {} : { disabledReason: reason })}
                    onClick={reopen}
                  >
                    {`Reopen ${decision.key}`}
                  </Button>
                  <Button size="sm" tone="ghost" onClick={() => setAsking(false)}>
                    Keep the decision
                  </Button>
                </div>
              </div>
            ) : (
              <div className="orca-plan__actions">
                <Button size="sm" onClick={() => setAsking(true)}>
                  Reopen…
                </Button>
              </div>
            ))}
        </section>
      )}
    </section>
  );
}
