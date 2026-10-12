/**
 * The plan journal: every act recorded against the plan, newest first, on the component
 * layer's timeline row.
 *
 * `runs/timeline/`'s `TimelineEntryRow` is **not** reused and was not promoted to `ui/`.
 * The two rows look alike and are about different things: an event row carries a run
 * status, an event kind, a sequence range and a copy menu for an event id, and none of the
 * four exists on a plan journal entry — a plan entry has an origin (who did it) where an
 * event has a status (what happened to it). Promoting the component would have meant every
 * one of those props becoming optional, which is two rows in one file rather than one row
 * used twice. What *is* shared is the class, `.orca-timeline-entry`, which is where the
 * grid, the row height and the truncation live.
 *
 * Its own scope (`plan-journal`): one `VirtualList` per scope, and the schedule table above
 * it already holds `list`.
 *
 * It pages backwards and still does not call `shiftBy`, which every other backward-paging
 * list in the app does. The reason is the reading order: the rows are newest first, so an
 * earlier page lands at the *end* of the list and no index a person is looking at moves.
 * `shiftBy` is for a page that arrives in front of them.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type { PlanJournalEntryView } from "@orca/protocol";
import { VirtualList } from "../list/index.js";
import { Chip, Text, Time, counted, textClass } from "../ui/index.js";
import { newestFirst } from "./plan-model.js";

export interface JournalProps {
  entries: readonly PlanJournalEntryView[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => void;
  /** Absolute times only when the daemon is not answering: "6m ago" against a stale clock lies. */
  live: boolean;
}

export const journalRowId = (seq: number): string => `plan-journal-${seq}`;

export function Journal({ entries, hasEarlier, loadingEarlier, loadEarlier, live }: JournalProps): JSX.Element {
  /* Newest first is the reading order of a journal; the wire pages oldest-first whichever
     anchor it was given, so the reversal happens once, here, at the edge. */
  const rows = useMemo(() => newestFirst(entries), [entries]);

  /* Selection is held here, exactly as `ScheduleTable` holds the schedule's.
     `selectedIndex={undefined}` with a no-op `onSelect` was the substrate being asked to
     move something nobody was holding: `J`, `K` and the arrows scrolled, no row was ever
     marked, and `aria-activedescendant` was never set — which is the whole of how a
     screen reader is told where it is in a list (rule 10).
     `Enter` on a journal row still does nothing, deliberately: an entry is a record of
     something that already happened and the acts a row could lead to — opening the item,
     the decision or the risk it names — are #171's and #178's. What moves now is the
     selection, because "where am I" is not an act and does not wait on them. */
  const [selectedSeq, setSelectedSeq] = useState<number | undefined>(undefined);
  const selectedIndex = useMemo(() => {
    const at = rows.findIndex((entry) => entry.seq === selectedSeq);
    return at === -1 ? undefined : at;
  }, [rows, selectedSeq]);

  /* Held by `seq` rather than by index so that a page of earlier entries, or a push that
     puts a newer one on top, leaves the selection on the entry a person put it on. An
     entry that is no longer held stops being selected rather than selecting its neighbour. */
  useEffect(() => {
    if (selectedSeq !== undefined && !rows.some((entry) => entry.seq === selectedSeq)) setSelectedSeq(undefined);
  }, [rows, selectedSeq]);

  const onSelect = useCallback(
    (index: number) => {
      const entry = rows[index];
      if (entry) setSelectedSeq(entry.seq);
    },
    [rows],
  );

  return (
    <div className="orca-plan__journal">
      {/* Above the scroller, not in the sticky header: `.orca-list__scroller` is an
          overflow container and a control inside one is clipped by it. */}
      <div className="orca-plan__bar">
        <Text style="label-strong">Journal</Text>
        {hasEarlier && (
          <button
            type="button"
            className={`orca-btn ${textClass("caption")} orca-btn--ghost orca-btn--sm`}
            onClick={loadEarlier}
            disabled={loadingEarlier}
          >
            {loadingEarlier ? "Loading earlier entries" : "Load earlier entries"}
          </button>
        )}
        <Text style="caption" className="orca-plan__count">
          {counted(rows.length, "entry", "entries")}
        </Text>
      </div>

      <VirtualList
        className="orca-plan__journal-list"
        label="Plan journal"
        noun="entry"
        scope="plan-journal"
        items={rows}
        rowId={(entry) => journalRowId(entry.seq)}
        rowClassName={(_entry, _index, selected) =>
          selected ? "orca-timeline-entry orca-timeline-entry--selected" : "orca-timeline-entry"
        }
        renderRow={(entry) => <JournalRow entry={entry} live={live} />}
        selectedIndex={selectedIndex}
        onSelect={onSelect}
      />
    </div>
  );
}

/**
 * One entry: when, what the daemon says happened, and who did it.
 *
 * `summary` is the daemon's own one-line rendering — the same line `orca plan journal`
 * prints — and goes on screen as it arrived. The payload is not folded here: a second
 * rendering of a shape this surface would have to keep in step with `core`'s `PlanEvent`
 * union is exactly what `summary` exists instead of.
 */
function JournalRow({ entry, live }: { entry: PlanJournalEntryView; live: boolean }): JSX.Element {
  return (
    <>
      <Time at={new Date(entry.at)} show={live ? "both" : "absolute"} className="orca-timeline-entry__time" />
      {/* The marker column the row's grid reserves. A journal entry has no status glyph to
          put in it — inventing one would be a status ORCA never recorded (rule 12). */}
      <span className="orca-timeline-entry__marker" aria-hidden="true" />
      <span className={`orca-timeline-entry__body ${textClass("label")}`}>{entry.summary}</span>
      <span className="orca-plan__origin">
        {/* Who wrote it: the origin's kind and its actor, which is what tells a decision a
            person made from one the decomposition made. */}
        {/* `actor` is optional on the wire, and an entry without one says only its kind
            rather than naming somebody who was never recorded (rule 12). */}
        <Chip>
          {entry.origin.actor === undefined ? entry.origin.kind : `${entry.origin.kind} · ${entry.origin.actor}`}
        </Chip>
      </span>
    </>
  );
}
