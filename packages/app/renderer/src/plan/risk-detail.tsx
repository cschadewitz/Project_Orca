/**
 * A risk's detail, drawn in the docked panel when the risk mode has one selected (#172).
 *
 * Its status (open, mitigating, mitigated, accepted, realized, closed — the wire's words), the
 * work items it holds (`affects`) and the ones whose delivery reduces it (`mitigatedBy`), and
 * the journal entries that name it, each with the daemon's own summary. Like the work-item
 * inspector it does not write: moving a risk along its lifecycle is the palette's
 * `Update risk` (#178).
 */
import type { JSX } from "react";
import type { ItemRef, PlanJournalEntryView, RiskView } from "@orca/protocol";
import { Chip, Text, Time, textClass } from "../ui/index.js";

export interface RiskDetailProps {
  risk: RiskView;
  journal: readonly PlanJournalEntryView[];
  /** A held item, opened on the schedule. */
  onOpenItem: (itemId: string) => void;
  live: boolean;
}

export function RiskDetail({ risk, journal, onOpenItem, live }: RiskDetailProps): JSX.Element {
  return (
    <div className="orca-plan__inspector" aria-label={`Risk ${risk.key}`}>
      <div className="orca-plan__section">
        <Text style="label-strong" as="h2">
          {risk.title}
        </Text>
        <span className={`orca-plan__id ${textClass("mono-id")}`}>{risk.key}</span>
      </div>

      <div className="orca-plan__meta">
        <Chip>{`status ${risk.status}`}</Chip>
        <Chip>{risk.level}</Chip>
        <Chip>{`L${risk.likelihood} × I${risk.impact} = ${risk.score}`}</Chip>
        <Chip>{risk.category}</Chip>
      </div>

      {risk.description !== "" && <Text style="caption">{risk.description}</Text>}

      <Items label="Holds" empty="It holds no work item." items={risk.affects} onOpenItem={onOpenItem} />
      <Items
        label="Mitigated by"
        empty="No work item is recorded as reducing it."
        items={risk.mitigatedBy}
        onOpenItem={onOpenItem}
      />

      {risk.mitigation !== undefined && (
        <section className="orca-plan__section" aria-label="Mitigation">
          <Text style="eyebrow" as="h3">
            Mitigation
          </Text>
          <Text style="caption">{risk.mitigation}</Text>
        </section>
      )}

      <section className="orca-plan__section" aria-label="Journal">
        <Text style="eyebrow" as="h3">
          Journal
        </Text>
        {journal.length === 0 ? (
          <Text style="caption">No journal entry names this risk.</Text>
        ) : (
          <ul className={`orca-plan__lines ${textClass("caption")}`}>
            {journal.map((entry) => (
              <li key={entry.seq}>
                <Time at={new Date(entry.at)} show={live ? "both" : "absolute"} />
                <Text style="caption">{` ${entry.type}: ${entry.summary}`}</Text>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Items({
  label,
  empty,
  items,
  onOpenItem,
}: {
  label: string;
  empty: string;
  items: readonly ItemRef[];
  onOpenItem: (itemId: string) => void;
}): JSX.Element {
  return (
    <section className="orca-plan__section" aria-label={label}>
      <Text style="eyebrow" as="h3">
        {label}
      </Text>
      {items.length === 0 ? (
        <Text style="caption">{empty}</Text>
      ) : (
        <ul className={`orca-plan__lines ${textClass("caption")}`}>
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`orca-bare orca-link ${textClass("mono-id")}`}
                onClick={() => onOpenItem(item.id)}
              >
                {item.slug}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
