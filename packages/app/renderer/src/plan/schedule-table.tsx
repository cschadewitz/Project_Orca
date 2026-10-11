/**
 * The schedule table: every work item in the plan, in the order the daemon returned it —
 * ready first and best first, then running, waiting, held, unschedulable and the settled
 * ones. That order is `computeSchedule`'s and this list never re-sorts it; a column header
 * that sorted would be the client deciding what the scheduler decides.
 *
 * Eight columns, and each is a fact the wire carries: the classification, the slug, the
 * title, the request the item was decomposed from, the item's own status, the priority
 * score with its first reason as the cell's title, the highest open risk level, and the
 * run holding the claim. There is no "ready by" and no estimate — there is nothing on the
 * wire that could fill one (rule 12).
 *
 * The **status** column and the **classification** column are not the same fact and are
 * drawn so they cannot be mistaken for each other. The classification is where the
 * scheduler put the item and is a tinted `ScheduleBadge` with a **why** beside it; the
 * status is what the item says about itself, is a plain `Chip` with its own word and glyph
 * (`WORK_ITEM_STATUS_PRESENTATION`), and nothing opens off it. An item can be `pending`
 * and `ready`, or `pending` and `waiting on deps` — which is exactly why both are on
 * screen.
 *
 * The **why** beside the badge opens the explanation, and it opens in the app's one `Menu`:
 * the lines are `schedule.explain`'s, verbatim, one per row, in the order it returned them.
 * Choosing a row copies that line, which is the only thing a read-only popover can
 * usefully do and is what keeps the menu's focus contract intact — a list of items that
 * are all disabled is a popover focus cannot enter.
 */
import { useCallback, useMemo, type JSX } from "react";
import type { ItemClassification, PlanItemView } from "@orca/protocol";
import { VirtualList, type MinimapKind, type VirtualListTick } from "../list/index.js";
import { Chip, Menu, ScheduleBadge, StatusChip, textClass, type MenuItem } from "../ui/index.js";
import { CLASSIFICATION_WORDS, classificationMark, explanationItems, workItemStatusMark } from "./plan-model.js";

export interface ScheduleTableProps {
  items: readonly PlanItemView[];
  selectedId: string | undefined;
  onSelect: (item: PlanItemView) => void;
  /** `Enter` on a row, and the **why** beside its badge: both open the explanation. */
  onExplain: (item: PlanItemView) => void;
  /** The item whose explanation is open, and its lines once they have been read. */
  explainFor: string | undefined;
  lines: readonly string[] | undefined;
  /** What the daemon said instead of lines. Never one of them (`Explanation`). */
  explainError: string | undefined;
  onCloseExplanation: () => void;
  /** The run a claim names, opened through the route table. */
  onOpenRun: (runId: string) => void;
}

export const scheduleRowId = (id: string): string => `plan-row-${id}`;

/** The four the minimap marks, as the plan's classifications name them. */
const TICKS: Partial<Record<ItemClassification, MinimapKind>> = {
  failed: "failed",
  waiting: "waiting",
  unschedulable: "blocked",
  held: "blocked",
};

export function ScheduleTable(props: ScheduleTableProps): JSX.Element {
  const { items, selectedId, onSelect, onExplain, explainFor, lines, explainError, onCloseExplanation, onOpenRun } =
    props;

  const selectedIndex = useMemo(() => {
    const at = items.findIndex((item) => item.id === selectedId);
    return at === -1 ? undefined : at;
  }, [items, selectedId]);

  const ticks = useMemo<VirtualListTick[]>(
    () =>
      items.flatMap((item, index) => {
        const mark = TICKS[item.classification];
        return mark ? [{ index, kind: mark, label: `${item.slug}, ${item.classification}` }] : [];
      }),
    [items],
  );

  const selectAt = useCallback(
    (index: number) => {
      const item = items[index];
      if (item) onSelect(item);
    },
    [items, onSelect],
  );

  return (
    <VirtualList
      className="orca-plan__table"
      label="Schedule"
      noun="work item"
      scope="list"
      /* A `grid`, not the substrate's default `listbox`: a row here holds controls — the
         **why** beside the badge and the claim's run — and a control inside an `option` is a
         control nothing can reach (`nested-interactive`). The cells below carry
         `role="gridcell"`, which is what makes those controls legal and reachable. */
      role="grid"
      items={items}
      ticks={ticks}
      header={<TableHead />}
      rowId={(item) => scheduleRowId(item.id)}
      rowClassName={(_item, _index, selected) =>
        selected ? "orca-plan__row orca-plan__row--selected" : "orca-plan__row"
      }
      renderRow={(item) => (
        <Row
          item={item}
          onExplain={onExplain}
          open={explainFor === item.id}
          lines={explainFor === item.id ? lines : undefined}
          explainError={explainFor === item.id ? explainError : undefined}
          onCloseExplanation={onCloseExplanation}
          onOpenRun={onOpenRun}
        />
      )}
      selectedIndex={selectedIndex}
      onSelect={selectAt}
    />
  );
}

/** The column headings, in the substrate's sticky header so they stay above the rows. */
function TableHead(): JSX.Element {
  return (
    <span className={`orca-plan__head ${textClass("caption")}`}>
      <span>Schedule</span>
      <span>Work item</span>
      <span>Title</span>
      <span>Request</span>
      <span>Status</span>
      <span className="orca-plan__score">Priority</span>
      <span>Risk</span>
      <span>Claim</span>
    </span>
  );
}

interface RowProps {
  item: PlanItemView;
  onExplain: (item: PlanItemView) => void;
  open: boolean;
  lines: readonly string[] | undefined;
  explainError: string | undefined;
  onCloseExplanation: () => void;
  onOpenRun: (runId: string) => void;
}

function Row({ item, onExplain, open, lines, explainError, onCloseExplanation, onOpenRun }: RowProps): JSX.Element {
  const mark = classificationMark(item.classification);
  const status = workItemStatusMark(item.status);
  /* The first reason, as the cell's title: the whole list is in the explanation and in the
     inspector, and a row never grows a second line (rule 9). */
  const reason = item.priority?.reasons[0];
  const why = (
    <Explanation
      item={item}
      open={open}
      lines={lines}
      error={explainError}
      onOpen={() => onExplain(item)}
      onClose={onCloseExplanation}
    />
  );

  return (
    <>
      {/* Every row is the mark, then the why: never the why inside the badge's tint, because
          it is a control and accent is never a state (rule 5), and because the settled rows
          draw a chip with nothing inside it — so a why inside the badge ended its tint on some
          rows and not others, and the links did not line up. Both marks take the badge's
          aligned width, so every why starts at one edge. */}
      <span className="orca-plan__cell" role="gridcell">
        {mark.kind === "badge" ? (
          <ScheduleBadge classification={mark.classification} aligned />
        ) : (
          /* A settled item is not in the ordering, so it has no schedule badge to draw:
             what it has is an outcome, in the run status that means the same thing. The
             explanation is still one press away, because `schedule.explain` answers for a
             settled item too. */
          <StatusChip status={mark.status} aligned="schedule" />
        )}
        {why}
      </span>

      <span className={`orca-plan__id ${textClass("mono-id")}`} role="gridcell">
        {item.slug}
      </span>
      <span className={`orca-plan__cell ${textClass("label")}`} role="gridcell">
        {item.title}
      </span>

      {/* The request this item was decomposed from, in mono because it is ORCA's own name
          for that object and not prose about it (rule 8). */}
      <span className={`orca-plan__id ${textClass("mono-id")}`} role="gridcell">
        {item.requestId}
      </span>

      {/* The item's own status: word and glyph, in the plain chip, never the tinted one —
          a tinted chip on screen means a run status and this is not one (ui/chip.tsx). */}
      <span className="orca-plan__cell" role="gridcell">
        <Chip {...(status.glyph === undefined ? {} : { glyph: status.glyph })}>{status.word}</Chip>
      </span>

      <span className={`orca-plan__score ${textClass("mono-id")}`} title={reason} role="gridcell">
        {item.priority === undefined ? "" : item.priority.score.toFixed(1)}
      </span>
      <span className="orca-plan__cell" role="gridcell">
        {item.risk.level === "none" ? null : <Chip>{`${item.risk.level} risk`}</Chip>}
      </span>
      <span className="orca-plan__cell" role="gridcell">
        {item.claim === undefined ? null : (
          <button
            type="button"
            className={`orca-bare orca-link ${textClass("mono-id")}`}
            onClick={() => onOpenRun(item.claim!.runId)}
          >
            {item.claim.runId}
          </button>
        )}
      </span>
    </>
  );
}

/**
 * The explanation popover. It is a `Menu` because every popover in this app is one, and
 * the lines go in as items untouched — the scheduler's own account of its decision, in the
 * same words `orca plan explain` prints, dependency and risk lines last because that is
 * the order `schedule.explain` returns them in.
 *
 * A read that *failed* is not one of those lines and is never rendered as one. A protocol
 * error is the daemon saying it could not answer, and a menu row is a line you can choose
 * and copy — so an error put in that list would leave the clipboard holding
 * `PLAN_NOT_FOUND: no plan …` as if the scheduler had said it about the item. It goes in
 * the menu's `note` instead: said, visible, not a choice.
 */
function Explanation({
  item,
  open,
  lines,
  error,
  onOpen,
  onClose,
}: {
  item: PlanItemView;
  open: boolean;
  lines: readonly string[] | undefined;
  error: string | undefined;
  onOpen: () => void;
  onClose: () => void;
}): JSX.Element {
  /* Until the lines land the menu still has a row, because a `Menu` with no items renders
     no trigger at all — and "why" has to be there to be pressed. The row says what is
     happening rather than standing in for an explanation nobody has read yet.
     Once a read has failed there are no rows at all: the note is the whole of it. */
  const items = useMemo<MenuItem[]>(() => {
    if (error !== undefined) return [];
    return lines === undefined ? [{ id: "reading", label: "Reading the explanation" }] : [...explanationItems(lines)];
  }, [lines, error]);

  const copy = useCallback((chosen: MenuItem) => {
    // Nothing in the plan changes from here: the one act a line offers is taking it with
    // you. A clipboard that is not there (a test, a sandboxed frame) is nothing happening.
    void navigator.clipboard?.writeText(chosen.label);
  }, []);

  return (
    <Menu
      /* The classification's *word*, which is what the badge beside it draws: the raw key
         `waiting` reads as "waiting" where the row says "waiting on deps", and an
         accessible name that disagrees with the label next to it is two names for one
         thing. */
      label={`Why ${item.slug} is ${CLASSIFICATION_WORDS[item.classification]}`}
      items={items}
      open={open}
      onOpenChange={(next) => (next ? onOpen() : onClose())}
      triggerClassName={`orca-badge__why ${textClass("caption")}`}
      onChoose={copy}
      {...(error === undefined
        ? {}
        : {
            note: (
              <span className={`orca-menu__error ${textClass("caption")}`}>
                {`The scheduler could not explain this item. ${error}`}
              </span>
            ),
          })}
    >
      why
    </Menu>
  );
}
