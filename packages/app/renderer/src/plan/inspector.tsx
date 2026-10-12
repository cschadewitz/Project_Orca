/**
 * The Plan inspector, drawn in the docked panel — the same dock the artifact panel uses on
 * Runs, which `docs/design/80-dependency-graph-options.md` says becomes a Plan surface as
 * well as a Runs one when option B ships.
 *
 * It shows the selected item whole: what a row had to truncate, the priority reasons the
 * row could only show one of, the dependencies with **both** states the wire carries, its
 * risks, and the claim. Three things it deliberately does not do:
 *
 * - **It does not write.** Waive, release, start a run and the rest are the palette's
 *   (#178) — "the palette is the only place a phase-2 write action needs to be
 *   discoverable, which keeps the chrome of the screens empty".
 * - **It does not re-phrase.** The priority reasons and the dependency detail are the
 *   scheduler's own lines, as `schedule.explain` renders them.
 * - **It shows a dependency twice on purpose.** `status` is what was last written to the
 *   document and `evaluation` is what `computeSchedule` decided against the plan as it
 *   stands now; they differ until `reconcile` catches up, and a screen that showed only
 *   one of them would be hiding the difference that explains a row nobody can start.
 */
import type { JSX } from "react";
import type { DependencyView, PlanItemView, RiskView } from "@orca/protocol";
import { Chip, ObjectId, ScheduleBadge, StatusChip, Text, textClass } from "../ui/index.js";
import { classificationMark } from "./plan-model.js";

export interface InspectorProps {
  item: PlanItemView;
  dependencies: readonly DependencyView[];
  risks: readonly RiskView[];
  onOpenRun: (runId: string) => void;
}

export function Inspector({ item, dependencies, risks, onOpenRun }: InspectorProps): JSX.Element {
  const mark = classificationMark(item.classification);

  return (
    <div className="orca-plan__inspector" aria-label={`Work item ${item.slug}`}>
      <div className="orca-plan__section">
        <Text style="label-strong" as="h2">
          {item.title}
        </Text>
        <span className={`orca-plan__id ${textClass("mono-id")}`}>{item.slug}</span>
      </div>

      <div className="orca-plan__meta">
        {mark.kind === "badge" ? (
          /* No disclosure here: the explanation is the table's popover, and a second
             trigger for it in the panel would be a second place to open one popover. */
          <ScheduleBadge classification={mark.classification} />
        ) : (
          <StatusChip status={mark.status} />
        )}
        <Chip>{item.status}</Chip>
        <Chip>{item.kind}</Chip>
        {/* The request as its token, whole on hover; there is no request title to lead with. */}
        <Chip>
          {"request "}
          <ObjectId id={item.requestId} kind="request" />
        </Chip>
      </div>

      {item.priority !== undefined && item.priority.reasons.length > 0 && (
        <section className="orca-plan__section" aria-label="Why it is in this position">
          <Text style="eyebrow" as="h3">
            {`Priority ${item.priority.score.toFixed(1)}`}
          </Text>
          {/* The scheduler's lines, word for word. */}
          <ul className={`orca-plan__lines ${textClass("caption")}`}>
            {item.priority.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </section>
      )}

      {item.deferredReason !== undefined && (
        <section className="orca-plan__section" aria-label="Why the plan is not dispatching it">
          <Text style="eyebrow" as="h3">
            Deferred
          </Text>
          <Text style="caption">{item.deferredReason}</Text>
        </section>
      )}

      <section className="orca-plan__section" aria-label="Dependencies">
        <Text style="eyebrow" as="h3">
          Dependencies
        </Text>
        {dependencies.length === 0 ? (
          <Text style="caption">Nothing blocks this item.</Text>
        ) : (
          <ul className={`orca-plan__lines ${textClass("caption")}`}>
            {dependencies.map((dependency) => (
              <li key={dependency.id}>
                <span className={textClass("mono-id")}>{targetOf(dependency)}</span>
                {/* Stored, then live. Two facts, said as two. */}
                <Text style="caption">{` — ${dependency.type}, recorded ${dependency.status}, now ${dependency.evaluation.state}: ${dependency.evaluation.detail}`}</Text>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="orca-plan__section" aria-label="Risks">
        <Text style="eyebrow" as="h3">
          Risks
        </Text>
        {risks.length === 0 ? (
          <Text style="caption">No open risk names this item.</Text>
        ) : (
          <ul className={`orca-plan__lines ${textClass("caption")}`}>
            {risks.map((risk) => (
              <li key={risk.id}>
                <span className={textClass("mono-id")}>{risk.key}</span>
                <Text style="caption">{` — ${risk.level}, ${risk.status} (L${risk.likelihood} × I${risk.impact})`}</Text>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="orca-plan__section" aria-label="Claim">
        <Text style="eyebrow" as="h3">
          Claim
        </Text>
        {item.claim === undefined ? (
          <Text style="caption">No run is holding this item.</Text>
        ) : (
          /* The detail pane is where the whole id belongs: verbatim, with the tail the table
             showed lifted out of it so the two can be matched by eye. */
          <button type="button" className="orca-bare orca-link" onClick={() => onOpenRun(item.claim!.runId)}>
            <ObjectId id={item.claim.runId} kind="run" variant="full" />
          </button>
        )}
      </section>
    </div>
  );
}

/** What a dependency points at, in the words the three target kinds are written in. */
function targetOf(dependency: DependencyView): string {
  const target = dependency.target;
  switch (target.kind) {
    case "work-item":
      return target.stage === undefined
        ? (target.slug ?? target.workItemId)
        : `${target.slug ?? target.workItemId}:${target.stage}`;
    case "decision":
      return `decision ${target.key ?? target.decisionId}`;
    case "external":
      return `external ${target.key}`;
  }
}
