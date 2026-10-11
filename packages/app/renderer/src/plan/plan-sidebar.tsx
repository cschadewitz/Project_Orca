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
import { ObjectId, Text, textClass, useIdTails } from "../ui/index.js";
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
  const tailOf = useIdTails(plan.requestIds);
  return (
    <nav className="orca-plan__rail" aria-label="Requests and filters">
      <div className="orca-plan__group">
        <Text style="eyebrow" as="h2">
          Requests
        </Text>
        <div className="orca-chips">
          <Filter label="All requests" pressed={filters.requestId === undefined} onPress={() => onRequest(undefined)} />
          {plan.requestIds.map((requestId) => (
            <Filter
              key={requestId}
              request={{ id: requestId, tail: tailOf(requestId) }}
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
        <div className="orca-chips">
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
        <div className="orca-chips">
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
 *
 * A `request` filter names a request by its id, and the plan's read model carries no
 * request title to lead with — so it is the id's token alone, `❝ 5BNH42`: the kind's glyph
 * and the last six characters, with the whole id in the token's title (`ObjectId`). A raw
 * id — `req_` and 26 characters whose first ten are the same for every request one session
 * made — was wider than the rail and truncated to exactly the half that does not differ. The
 * label is still a span of its own and still truncates at its end, should a rail ever be
 * narrower than a token: the ellipsis is drawn by the block whose text overflows, and a
 * button's text sits in an anonymous box inside it that the button's `text-overflow` does
 * not reach.
 */
function Filter({
  label,
  request,
  count,
  pressed,
  onPress,
}: {
  label?: string;
  /** A request, by its id and the tail the rail draws it with (`useIdTails`). */
  request?: { id: string; tail: string };
  count?: number;
  pressed: boolean;
  onPress: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`orca-plan__filter ${textClass(request === undefined ? "caption" : "mono-id")}`}
      aria-pressed={pressed}
      onClick={onPress}
    >
      <span className="orca-plan__filter-label">
        {request !== undefined ? (
          <ObjectId id={request.id} kind="request" tail={request.tail} />
        ) : count === undefined ? (
          label
        ) : (
          `${label} ${count}`
        )}
      </span>
    </button>
  );
}
