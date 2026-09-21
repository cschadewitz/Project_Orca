/**
 * The Plan sidebar: the plan's requests, and the filters over its items.
 *
 * It is deliberately *not* a list of sub-screens. Option B in
 * `docs/design/80-dependency-graph-options.md` is what shipped: "the Plan sidebar loses its
 * Schedule/Dependencies/Risks/Decisions/Journal list in favour of requests and filters",
 * because the modes are the object header's segmented control and a rail of destinations
 * beside a rail of modes is two navigations for one screen.
 *
 * Selecting a request filters the table by `requestId`, which is an `items.list` parameter
 * and so is applied to the whole plan rather than to the page on screen. The counts beside
 * the classifications are `plan.counts` — the schedule folded to seven numbers by the
 * daemon — and not a count of the rows currently held, which would change as a filter
 * narrowed them and mean something else.
 */
import type { JSX } from "react";
import type { ItemClassification, PlanView } from "@orca/protocol";
import { Text, textClass } from "../ui/index.js";
import {
  CLASSIFICATIONS,
  CLASSIFICATION_WORDS,
  ITEM_STATUSES,
  type ItemStatus,
  type PlanFilters,
} from "./plan-model.js";

export interface PlanSidebarProps {
  plan: PlanView;
  filters: PlanFilters;
  onRequest: (requestId: string | undefined) => void;
  onClassification: (classification: ItemClassification) => void;
  onStatus: (status: ItemStatus) => void;
}

export function PlanSidebar({ plan, filters, onRequest, onClassification, onStatus }: PlanSidebarProps): JSX.Element {
  return (
    <nav className="orca-plan__rail" aria-label="Requests and filters">
      <div className="orca-plan__group">
        <Text style="eyebrow" as="h2">
          Requests
        </Text>
        <div className="orca-plan__chips">
          <Filter label="All requests" pressed={filters.requestId === undefined} onPress={() => onRequest(undefined)} />
          {plan.requestIds.map((requestId) => (
            <Filter
              key={requestId}
              label={requestId}
              mono
              pressed={filters.requestId === requestId}
              /* A second press on the selected request clears it: a filter rail with no
                 way back out of it is a rail a person gets stuck in. */
              onPress={() => onRequest(filters.requestId === requestId ? undefined : requestId)}
            />
          ))}
        </div>
      </div>

      <div className="orca-plan__group">
        <Text style="eyebrow" as="h2">
          Schedule
        </Text>
        <div className="orca-plan__chips">
          {CLASSIFICATIONS.map((classification) => (
            <Filter
              key={classification}
              label={CLASSIFICATION_WORDS[classification]}
              /* The plan's own count for this classification. Absent is zero — the daemon
                 leaves a bucket out rather than sending a nought. */
              count={plan.counts[classification] ?? 0}
              pressed={filters.classification.includes(classification)}
              onPress={() => onClassification(classification)}
            />
          ))}
        </div>
      </div>

      <div className="orca-plan__group">
        <Text style="eyebrow" as="h2">
          Status
        </Text>
        <div className="orca-plan__chips">
          {ITEM_STATUSES.map((status) => (
            <Filter
              key={status}
              label={status}
              pressed={filters.status.includes(status)}
              onPress={() => onStatus(status)}
            />
          ))}
        </div>
      </div>
    </nav>
  );
}

/**
 * One filter. A button with `aria-pressed`, not a checkbox and not a chip: it is a control
 * that acts on press, and `accent` is what marks it as the one in effect — which is rule
 * 5's "accent means interactive", used for the state of an interactive thing.
 */
function Filter({
  label,
  count,
  mono = false,
  pressed,
  onPress,
}: {
  label: string;
  count?: number;
  mono?: boolean;
  pressed: boolean;
  onPress: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`orca-plan__filter ${textClass(mono ? "mono-id" : "caption")}`}
      aria-pressed={pressed}
      onClick={onPress}
    >
      {count === undefined ? label : `${label} ${count}`}
    </button>
  );
}
