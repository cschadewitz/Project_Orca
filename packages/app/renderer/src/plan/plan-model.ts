/**
 * The Plan surface's arithmetic, with no React and no DOM in it — the plain module the
 * worked surfaces put beside their hook (`runs/run-rows.ts`, `attention/card-model.ts`).
 *
 * Five things live here because each one is a decision rather than a rendering:
 *
 * - **which half of a filter is the daemon's.** Classification, status and request are
 *   `items.list` parameters, so they are applied across the whole plan; the text half
 *   narrows what is already held, exactly as the run list's does, and the count says which
 *   ("3 of 9 items"). Sending `text` as well would re-read the plan on every keystroke.
 * - **the seven classifications against a design system that draws five.** `done` and
 *   `failed` are outcomes rather than places in the schedule, and a `ScheduleBadge` has no
 *   drawing for them — so the table marks them with `StatusChip`'s `succeeded` and
 *   `failed`, which are the run statuses that mean the same thing and already carry a
 *   glyph and a word.
 * - **the journal's cursors.** `journal.list` pages oldest-first whichever anchor it was
 *   given, the surface reads newest-first, and a backward page may overlap what is held —
 *   so entries are folded by `seq` and sorted once, rather than concatenated and hoped
 *   over.
 * - **`plan.changed` is a signal, not a payload.** A frame names the areas that moved and
 *   the journal `seq` behind it; this says which reads that makes stale, and which frames
 *   have already been folded so a repeated one costs nothing.
 * - **the explanation is passed through untouched.** `explanationItems` turns the lines
 *   into menu rows and does nothing else: the scheduler's account of its own decision is
 *   the CLI's word for word (`schedule.explain`), and a surface that re-sentenced it would
 *   be a second explanation to keep true.
 */
import type { RunStatus, ScheduleClass } from "@orca/design";
import {
  ITEM_CLASSIFICATIONS,
  type ItemClassification,
  type ItemsListParams,
  type PlanItemView,
  type PlanJournalEntryView,
  type PlanChangeKind,
} from "@orca/protocol";

/**
 * The work-item statuses `items.list` filters by, taken off the parameter's own type so
 * this cannot name one the wire does not have. The values are written out because the
 * protocol exports no constant for them — only the schema — and a filter rail needs the
 * list, in the order a work item moves through it.
 */
export type ItemStatus = NonNullable<ItemsListParams["status"]>[number];
export const ITEM_STATUSES: readonly ItemStatus[] = [
  "pending",
  "ready",
  "in-progress",
  "blocked",
  "done",
  "failed",
  "cancelled",
];

/** The seven the wire classifies by, in the daemon's own order. */
export const CLASSIFICATIONS: readonly ItemClassification[] = ITEM_CLASSIFICATIONS;

/** What the sidebar and the table are filtered to. Empty arrays mean "no filter". */
export interface PlanFilters {
  classification: readonly ItemClassification[];
  status: readonly ItemStatus[];
  /** The request selected in the sidebar, when one is. */
  requestId?: string | undefined;
  /** Applied locally to what is held, never sent. */
  text: string;
}

export const NO_FILTERS: PlanFilters = { classification: [], status: [], text: "" };

/** Whether anything is narrowing the table — what an empty result says to clear. */
export const isFiltered = (filters: PlanFilters): boolean =>
  filters.classification.length > 0 ||
  filters.status.length > 0 ||
  filters.requestId !== undefined ||
  filters.text.trim() !== "";

/**
 * The `items.list` parameters for a filter: the daemon's three, and never `text`.
 *
 * An empty array is left out rather than sent: the wire reads "empty or absent means all of
 * them", and a request that spells out all seven classifications would be a filter the
 * daemon has to apply for no reason.
 */
export function itemsParams(planId: string, filters: PlanFilters): ItemsParams {
  return {
    planId,
    ...(filters.classification.length > 0 ? { classification: [...filters.classification] } : {}),
    ...(filters.status.length > 0 ? { status: [...filters.status] } : {}),
    ...(filters.requestId !== undefined ? { requestId: filters.requestId } : {}),
  };
}

/**
 * What the bridge takes: `limit` and `offset` have schema defaults, and a surface that
 * does not page says nothing about paging (`Params` in `src/bridge.ts`).
 */
export type ItemsParams = Partial<ItemsListParams> & { planId: string };

/** The local half of the filter: slug or title, the two fields the daemon matches too. */
export function matchesText(item: PlanItemView, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle === "") return true;
  return item.slug.toLowerCase().includes(needle) || item.title.toLowerCase().includes(needle);
}

/** "9 items", or "3 of 9 items" once the text filter has narrowed what the daemon sent. */
export function countLabel(shown: number, total: number): string {
  const items = `${total} ${total === 1 ? "item" : "items"}`;
  return shown === total ? items : `${shown} of ${items}`;
}

/**
 * How a classification is drawn.
 *
 * `badge` is one of the design system's five `ScheduleClass`es. `outcome` is the two that
 * are not: a settled item is not in the ordering at all, so what a row shows is what
 * happened to it, in the run status that means the same — never a sixth badge invented
 * here (rule 3).
 */
export type ClassificationMark =
  { kind: "badge"; classification: ScheduleClass } | { kind: "outcome"; status: RunStatus };

const OUTCOMES: Partial<Record<ItemClassification, RunStatus>> = { done: "succeeded", failed: "failed" };

export function classificationMark(classification: ItemClassification): ClassificationMark {
  const outcome = OUTCOMES[classification];
  return outcome === undefined
    ? { kind: "badge", classification: classification as ScheduleClass }
    : { kind: "outcome", status: outcome };
}

/**
 * The filter chip's word for a classification, which is the same word the badge draws so
 * that a chip and a row cannot disagree. `done` and `failed` are the run statuses' words
 * for the same reason.
 */
export const CLASSIFICATION_WORDS: Record<ItemClassification, string> = {
  ready: "ready",
  running: "running",
  waiting: "waiting on deps",
  held: "held",
  unschedulable: "unschedulable",
  done: "succeeded",
  failed: "failed",
};

/* ---------------------------------------------------------------- the journal ---- */

/**
 * Fold a page into what is held: by `seq`, which is per plan, monotonic and gap-free, so
 * an overlapping backward page replaces rather than duplicates. The result is oldest
 * first, which is the order both the wire and the fold work in; the surface reverses it
 * once, at the edge.
 */
export function foldJournal(
  held: readonly PlanJournalEntryView[],
  page: readonly PlanJournalEntryView[],
): readonly PlanJournalEntryView[] {
  if (page.length === 0) return held;
  const bySeq = new Map(held.map((entry) => [entry.seq, entry]));
  for (const entry of page) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Newest first, which is how a journal reads: the last thing that happened, at the top. */
export const newestFirst = (entries: readonly PlanJournalEntryView[]): readonly PlanJournalEntryView[] =>
  [...entries].sort((a, b) => b.seq - a.seq);

/** The `before` cursor for "load earlier": the oldest sequence number held. */
export const earliestSeq = (entries: readonly PlanJournalEntryView[]): number | undefined =>
  entries.length === 0 ? undefined : entries.reduce((low, entry) => Math.min(low, entry.seq), entries[0]!.seq);

/* ------------------------------------------------------------- plan.changed ---- */

/** Which reads a frame's `kinds` make stale. Every other kind is #171–#173's to hear. */
export interface Stale {
  plan: boolean;
  items: boolean;
  journal: boolean;
}

export const NOTHING_STALE: Stale = { plan: false, items: false, journal: false };

/**
 * A frame's areas, folded to the three lists this surface holds.
 *
 * `items` and `schedule` both move the table — the classification, the score and the
 * ordering are one `computeSchedule` over the plan — and every kind moves the counts in
 * the header, because those are the schedule folded to seven numbers.
 */
export function staleFor(kinds: readonly PlanChangeKind[]): Stale {
  const has = (kind: PlanChangeKind): boolean => kinds.includes(kind);
  const table = has("items") || has("schedule") || has("dependencies") || has("risks") || has("decisions");
  return { plan: table, items: table, journal: has("journal") };
}

/** Whether a frame is news. A `seq` already folded is a repeat and costs nothing. */
export const isNewFrame = (folded: number | undefined, seq: number): boolean => folded === undefined || seq > folded;

/* ------------------------------------------------------------ the explanation ---- */

/**
 * The explanation's lines as menu rows: one row per line, the line verbatim as the label,
 * in the order `schedule.explain` returned them — the scheduler's own first, then the
 * dependency and risk lines `orca plan explain` adds.
 *
 * Nothing is parsed, joined, re-cased or sorted. The id is the position, because two
 * identical lines are two lines and a menu keys its rows by id.
 */
export function explanationItems(lines: readonly string[]): readonly { id: string; label: string }[] {
  return lines.map((line, index) => ({ id: String(index), label: line }));
}
