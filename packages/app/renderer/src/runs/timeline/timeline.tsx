/**
 * The event timeline: the selected run's log, oldest at the top, newest at the bottom
 * (#157). The event log is the source of truth and this is the projection of it, which is
 * why the sticky header says which event the screen is current *as of* rather than
 * claiming to be current in the abstract (docs/design/60-implementation.md).
 *
 * Three things worth knowing before changing anything here:
 *
 * - **It pages both ways and the two are different.** Backwards is `runs.events` off disk,
 *   and a page that lands in front of the list moves every index down by its length — so
 *   the substrate's `shiftBy` is called with exactly that number, or a person would be
 *   thrown back by the page they just asked to see. Forwards is the push channel and needs
 *   no paging at all.
 * - **A coalesced batch is one row.** `agent.update` arrives as at most one notification
 *   per step per 100 ms with many updates inside, and it is drawn as one row saying how
 *   many. One row per update would put forty rows a second into a list a person is reading.
 * - **The cursor is the run's, not the app's.** The status bar's store-wide cell stays
 *   absent — sequence numbers are per run and the app holds one store-wide subscription, so
 *   there is no single number to put there (#163). Here there *is* one, because this list
 *   is about one run, so it is said here.
 *
 * A row names its event by **sequence number**, `#148`, at the end of the row — not by an id
 * tail. The sequence is the run's own cursor, it is what "as of event 148" in the header
 * counts, and it orders: two rows' numbers say which came first, which no tail does. The
 * event id is one step away, in the row's `Menu` with its kind's token (`✦ 4BFJ1C`), and
 * copying it copies the whole id. The menu is the app's one popover primitive — a
 * hand-rolled context menu would be a second copy of the keyboard and focus contract, which
 * is the thing #202 exists to prevent.
 */
import { memo, useCallback, useMemo, type JSX, type Ref } from "react";
import { CHROME_GLYPHS, STATUS_PRESENTATION } from "@orca/design";
import { VirtualList, type MinimapKind, type VirtualListHandle, type VirtualListTick } from "../../list/index.js";
import { Menu, StateView, Text, Time, countedOf, idText, textClass, type MenuItem } from "../../ui/index.js";
import { kindsOf, timelineRowId, type TimelineEntry } from "./timeline-entries.js";
import type { EventsState } from "./use-run-events.js";

/** "All kinds" is the absence of a filter, not a kind. */
export const ALL_KINDS = "all";

export interface TimelineProps {
  state: EventsState;
  /** The node name of the step the sticky header calls current, when there is one. */
  currentStep: string | undefined;
  selectedSeq: number | undefined;
  onSelect: (entry: TimelineEntry) => void;
  loadEarlier: () => void;
  onRetry: () => void;
  /** The substrate's imperative half, so a backward page can hold a person's place. */
  listRef: Ref<VirtualListHandle>;
  /** `all`, or one event kind. */
  kind: string;
  onKind: (kind: string) => void;
  /**
   * Stay at the newest end as the log grows. A run opens following, because the last thing
   * that happened is what a person came for; scrolling away holds it, and the substrate
   * says so once rather than on every scroll event.
   */
  follow: boolean;
  onHold: () => void;
}

const TICK_KINDS: Readonly<Record<string, MinimapKind>> = {
  failed: "failed",
  waiting: "waiting",
  blocked: "blocked",
};

/** A stable empty page, so the memos do not recompute before the log lands. */
const EMPTY: readonly TimelineEntry[] = [];

/**
 * Memoised, and that is load-bearing rather than an optimisation.
 *
 * The run tree and the timeline are siblings under one surface, so a `step.changed` —
 * which is the tree's and arrives whenever any step in any open run moves — re-renders the
 * surface. Without this, every one of those would re-render a list of ten thousand event
 * rows for a notification that changed nothing in it. Every prop below is either a value or
 * a `useCallback`/`useState` identity held across renders, which is what makes the shallow
 * compare tell the truth (docs/design/60-implementation.md: "do not re-render the run tree
 * on every agent update", read the other way round).
 */
export const Timeline = memo(function Timeline(props: TimelineProps): JSX.Element {
  const { state, currentStep, selectedSeq, onSelect, loadEarlier, onRetry, listRef, kind, onKind, follow, onHold } =
    props;

  const all = state.phase === "ready" ? state.entries : EMPTY;
  /* The kind filter is applied locally, like the run list's text filter and for the same
     reason: `runs.events` has a `types` parameter, but re-reading the log on every change
     of a menu would re-page a run that may be ten thousand events long. What is filtered
     is what is held, and the header says which event it is current to. */
  const entries = useMemo(() => (kind === ALL_KINDS ? all : all.filter((entry) => entry.kind === kind)), [all, kind]);

  const kindItems = useMemo<MenuItem[]>(
    () => [{ id: ALL_KINDS, label: "All kinds" }, ...kindsOf(all).map((k) => ({ id: k, label: k }))],
    [all],
  );

  const selectedIndex = useMemo(() => {
    if (selectedSeq === undefined) return undefined;
    const at = entries.findIndex((entry) => entry.seq === selectedSeq);
    return at === -1 ? undefined : at;
  }, [entries, selectedSeq]);

  const ticks = useMemo<VirtualListTick[]>(
    () =>
      entries.flatMap((entry, index) => {
        const status = entry.status;
        const mark = status === undefined ? undefined : TICK_KINDS[status];
        if (!mark || status === undefined) return [];
        return [{ index, kind: mark, label: `${entry.summary}, ${STATUS_PRESENTATION[status].word}` }];
      }),
    [entries],
  );

  const selectAt = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (entry) onSelect(entry);
    },
    [entries, onSelect],
  );

  if (state.phase === "idle") {
    return (
      <StateView
        kind="empty"
        className="orca-runs__timeline-state"
        title="No run selected"
        body="Pick a run in the tree above to see its events."
      />
    );
  }
  if (state.phase === "loading") {
    return <StateView kind="loading" className="orca-runs__timeline-state" title="Loading the event log" />;
  }
  if (state.phase === "error") {
    return (
      <StateView
        kind="error"
        className="orca-runs__timeline-state"
        title="Could not load the event log"
        body={`${state.error.code}: ${state.error.message}`}
        action={{ label: "Try again", onClick: onRetry }}
      />
    );
  }

  return (
    <div className="orca-runs__timeline-pane">
      {/* The kind filter and the backward page sit *above* the scroller rather than in the
          sticky header: `.orca-list__scroller` is an overflow container, and a popover
          opened inside one is clipped by it. */}
      <div className="orca-runs__timeline-bar">
        <Menu
          label={`Filter by event kind, currently ${kind === ALL_KINDS ? "all kinds" : kind}`}
          items={kindItems}
          triggerClassName={`orca-btn ${textClass("caption")} orca-btn--ghost orca-btn--sm`}
          onChoose={(item) => onKind(item.id)}
        >
          {kind === ALL_KINDS ? "All kinds" : kind}
          <span className="orca-runs__caret" aria-hidden="true">
            {CHROME_GLYPHS.crumbSeparator}
          </span>
        </Menu>
        {/* "Load earlier" is a button, not a scroll handler: a second listener over the
            substrate's own scroll is a second opinion about where the list is
            (docs/design/30-long-running-content.md). */}
        {state.hasEarlier && (
          <button
            type="button"
            className={`orca-btn ${textClass("caption")} orca-btn--ghost orca-btn--sm`}
            onClick={loadEarlier}
            disabled={state.loadingEarlier}
          >
            {state.loadingEarlier ? "Loading earlier events" : "Load earlier events"}
          </button>
        )}
        <Text style="caption" className="orca-runs__count">
          {countLabel(eventsIn(entries), eventsIn(all))}
        </Text>
      </div>

      <VirtualList
        className="orca-runs__timeline"
        label="Event timeline"
        noun="event"
        scope="list"
        items={entries}
        ticks={ticks}
        ref={listRef}
        follow={follow}
        onHold={onHold}
        header={
          <TimelineHeader
            currentStep={currentStep}
            applied={entries[entries.length - 1]?.seq}
            lastSeq={state.lastSeq}
          />
        }
        rowId={(entry) => timelineRowId(entry.seq)}
        rowClassName={rowClassName}
        renderRow={(entry) => <TimelineEntryRow entry={entry} />}
        selectedIndex={selectedIndex}
        onSelect={selectAt}
      />
    </div>
  );
});

/**
 * How many *events* a list of rows stands for, which is not how many rows it has: a
 * coalesced batch is one row and many events, and the count a person reads is of the log,
 * not of the drawing of it.
 */
const eventsIn = (entries: readonly TimelineEntry[]): number => entries.reduce((n, entry) => n + entry.count, 0);

/** "412 events", or "6 of 412 events" once the kind filter has narrowed them. */
function countLabel(shown: number, total: number): string {
  return countedOf(shown, total, "event");
}

/**
 * The system's timeline row and its selected modifier — but none of its status modifiers.
 * `.orca-timeline-entry--waiting` and `--selected` both set the left rail and the later one
 * wins, so the rail stays selection's (accent, rule 5) and the status goes on the marker
 * and into the row's words (rules 3 and 4).
 */
const rowClassName = (entry: TimelineEntry, _index: number, selected: boolean): string =>
  [
    "orca-timeline-entry",
    // A gate a policy settled is drawn quietly and never raises a count (#157).
    entry.autoApproved === true ? "orca-runs__auto" : "",
    selected ? "orca-timeline-entry--selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

/**
 * The sticky header: the current step, and the run's cursor.
 *
 * "As of event *n*" is the highest sequence number this list has applied. When the run's
 * log has gone past it — a kind filter is on, or the newest page has not caught up — it
 * says so with `lastSeq` beside it rather than printing a number that claims more than it
 * has (rule 12).
 */
function TimelineHeader({
  currentStep,
  applied,
  lastSeq,
}: {
  currentStep: string | undefined;
  applied: number | undefined;
  lastSeq: number;
}): JSX.Element {
  return (
    <span className="orca-runs__timeline-head">
      <Text style="label-strong">{currentStep === undefined ? "Event timeline" : currentStep}</Text>
      <Text style="caption" className="orca-runs__cursor">
        {applied === undefined
          ? "no events yet"
          : applied >= lastSeq
            ? `as of event ${applied}`
            : `as of event ${applied} of ${lastSeq}`}
      </Text>
    </span>
  );
}

/**
 * One event's cells. The time is first in the DOM as well as on screen, and the summary
 * carries the subject first, so a truncated row still means something (rule 13).
 *
 * The marker's colour comes off `STATUS_PRESENTATION` rather than a class per status: the
 * value is a token reference (`var(--status-failed)`), which is what rule 1 asks for, and
 * eight one-line classes in the app's own stylesheet would be eight second statements of
 * what the design system already says once.
 */
function TimelineEntryRow({ entry }: { entry: TimelineEntry }): JSX.Element {
  const presentation = entry.status === undefined ? undefined : STATUS_PRESENTATION[entry.status];

  return (
    <>
      <Time at={new Date(entry.at)} show="absolute" className="orca-timeline-entry__time" />
      <span
        className="orca-timeline-entry__marker"
        aria-hidden="true"
        style={presentation === undefined ? undefined : { color: presentation.fg }}
      >
        {presentation?.glyph ?? ""}
      </span>
      <span className={`orca-timeline-entry__body ${textClass("label")}`}>
        {entry.summary}
        {presentation !== undefined && (
          // The glyph is decorative, so the word carries the status into the row's
          // accessible name — status is never colour or shape alone (rules 3 and 4).
          <span className="orca-runs__event-status">{` — ${presentation.word}`}</span>
        )}
      </span>
      <span className="orca-runs__event-tail">
        <span className={`orca-timeline-entry__kind ${textClass("mono-id")}`}>{entry.kind}</span>
        <EntryMenu entry={entry} />
      </span>
    </>
  );
}

/** How a row names itself: by its sequence number, or the range a coalesced batch spans. */
const rangeOf = (entry: TimelineEntry): string =>
  entry.fromSeq === entry.seq ? String(entry.seq) : `${entry.fromSeq}-${entry.seq}`;

/**
 * The row's copy menu — a `Menu`, because every popover in this app is one. Its trigger is
 * the row's sequence number, `#148`; the event id is an item in it, drawn as its token and
 * copied whole.
 *
 * A coalesced `agent.update` batch has no event id to copy: the notification carries a
 * sequence range and the updates, and no ids (see `timeline-entries.ts`). Those rows offer
 * the range, which is what addresses them, rather than an id nobody sent.
 */
function EntryMenu({ entry }: { entry: TimelineEntry }): JSX.Element | null {
  const { eventId, seq } = entry;
  const range = rangeOf(entry);

  const items = useMemo<MenuItem[]>(
    () =>
      eventId === undefined
        ? [{ id: "seq", label: `Copy the sequence range ${range}` }]
        : [
            { id: "id", label: "Copy the event id", hintMachine: idText(eventId, { kind: "event" }) },
            { id: "seq", label: `Copy the sequence number ${seq}` },
          ],
    [eventId, seq, range],
  );

  const copy = useCallback(
    (item: MenuItem) => {
      const text = item.id === "id" ? (eventId ?? "") : range;
      // Absent in a DOM with no clipboard (a test, a sandboxed frame): a copy that cannot
      // happen is nothing happening, not an error to report.
      void navigator.clipboard?.writeText(text);
    },
    [eventId, range],
  );

  return (
    <Menu
      label={`Event #${range}`}
      items={items}
      triggerClassName={`orca-bare ${textClass("mono-id")} orca-runs__event-id`}
      onChoose={copy}
    >
      <span aria-hidden="true">{`#${range}`}</span>
    </Menu>
  );
}
