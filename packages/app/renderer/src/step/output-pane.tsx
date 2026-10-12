/**
 * `OutputPane` — a step's agent output, one line per row, virtualised.
 *
 * The rows are *lines* at `row-log`, which is what makes a screen of log worth scrolling
 * (docs/design/30-long-running-content.md): fixed height, `white-space: pre`, no wrapping,
 * and a line longer than 2,000 characters collapsed to `… n more characters` rather than
 * allowed to own the screen. The substrate underneath is the same `VirtualList` the run
 * list uses, in the `stream` scope, so `J`/`K` and the page keys mean "next line" here
 * while still meaning "next run" over there.
 *
 * The three behaviours worth reading before changing anything:
 *
 * - **Following and held.** Following is pinned to the end; scrolling away stops it
 *   *immediately* and nothing scrolls under the reader's eyes after that. The jump button
 *   says how many lines have arrived since. Returning to the bottom by any means — the
 *   button, `⇧G`, or `End`, which is the substrate's own "last line" — re-enters
 *   following, which is why `End` is not registered again here: it is already the
 *   substrate's in this scope, and selecting the last row is what re-entering following
 *   means.
 * - **Search is over the buffer, and says so.** `/` searches the lines that are held, not
 *   the log on disk: the protocol has no text parameter over events, and a search that
 *   only saw what happened to be in memory while claiming otherwise would be a lie. The
 *   count beside the field is how many it found and in what.
 * - **A labelled `log` region that never speaks** (rule 11, #167). The spec asks for two
 *   things at once and they pull against each other: the pane is "a labelled `log` region
 *   the person reads on demand", *and* streaming output is not a live region, because an
 *   agent producing forty lines a second would make the app unusable with a screen reader.
 *   `role="log"` on its own gives the second away — the role carries an implicit
 *   `aria-live="polite"`, so the role by itself *is* the flood. So the role is stated and
 *   the live behaviour is turned off beside it with an explicit `aria-live="off"`. What
 *   that buys is navigation without narration: the pane appears in the region list a
 *   screen reader offers, named for the step it belongs to ("Output of build, attempt 2",
 *   `outputLabel` at the bottom of this file), and a person goes to it and reads it when
 *   they choose to. What announces instead is the app's one polite live region
 *   (`a11y/announcer.tsx`): step transitions and terminal states, which is the part of the
 *   flood worth hearing. Do not drop the `aria-live="off"` to "complete" the role — that
 *   attribute is the whole of what keeps this pane usable.
 */
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from "react";
import { useKeyboard } from "../keyboard-context.js";
import { VirtualList, type VirtualListHandle } from "../list/index.js";
import { Text, counted, textClass } from "../ui/index.js";
import { foldLabel, type LineRow, type OutputRow } from "./line-buffer.js";

/** The first row of the pane: what is, or is not, in front of what the buffer holds. */
interface EdgeRow {
  kind: "edge";
  key: string;
  /** The `before` cursor, or `undefined` when this is genuinely the start of the output. */
  before: number | undefined;
}

type PaneRow = OutputRow | EdgeRow;

export interface OutputPaneHandle {
  /** After a page lands in front of the list, keep the reader where they were. */
  shiftBy: (rows: number) => void;
  reveal: (index: number) => void;
}

export interface OutputPaneProps {
  /** The lines, and the seams where the stream stopped and started again. */
  rows: readonly OutputRow[];
  /** What the pane is called for a screen reader: "Output of build, attempt 2". */
  label: string;
  /** True while the step is producing output; draws the caret at the end of the stream. */
  streaming: boolean;
  /** `following` pins to the end; `held` shows the jump button. */
  mode: "following" | "held";
  /** Lines that have arrived since following stopped. */
  pending: number;
  /** Set when there is output in front of the buffer: renders **Load earlier output**. */
  trimmedBefore?: number;
  loadingEarlier?: boolean;
  onJumpToLatest: () => void;
  /** Called once when a scroll leaves the end while following. */
  onHold: () => void;
  onLoadEarlier?: () => void;
  className?: string;
  ref?: Ref<OutputPaneHandle>;
}

const rowId = (row: PaneRow): string => `log-${row.key}`;

/** A row's text, for search. Seams and the edge marker have none to match on. */
const textOfRow = (row: PaneRow): string => (row.kind === "line" ? row.text : "");

/** `14:02:31` — the seam says when, in the one format a log correlates with. */
function clockOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

export function OutputPane(props: OutputPaneProps): JSX.Element {
  const {
    rows,
    label,
    streaming,
    mode,
    pending,
    trimmedBefore,
    loadingEarlier = false,
    onJumpToLatest,
    onHold,
    onLoadEarlier,
    className,
    ref,
  } = props;

  const keyboard = useKeyboard();
  const list = useRef<VirtualListHandle>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | undefined>(undefined);

  /* The edge marker is always row zero, in one of its two readings: "there is more in
     front of this, and here is how to get it", or "this is where the output starts". The
     second is not decoration — docs/design/30-long-running-content.md's rule is that the
     app never *silently* shows a partial log, and a row that says which of the two you are
     looking at is the whole of that promise. Keeping it at index 0 in both readings also
     keeps `shiftBy` arithmetic honest: the row count in front of the lines never changes
     under a page that just landed. */
  const items = useMemo<PaneRow[]>(
    () => [{ kind: "edge", key: "edge", before: trimmedBefore }, ...rows],
    [rows, trimmedBefore],
  );

  const matches = useMemo<number[]>(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    const found: number[] = [];
    for (let i = 0; i < items.length; i++) {
      if (textOfRow(items[i]!).toLowerCase().includes(needle)) found.push(i);
    }
    return found;
  }, [items, query]);

  /* Everything the shortcuts act on, through refs, so the five registrations below happen
     once for the life of the pane rather than on every frame of a stream. */
  const state = useRef({ items, matches, selected, onJumpToLatest, onHold });
  state.current = { items, matches, selected, onJumpToLatest, onHold };

  const goTo = useCallback((index: number) => {
    setSelected(index);
    list.current?.reveal(index);
  }, []);

  const cycle = useCallback(
    (delta: number) => {
      const { matches: found, selected: at } = state.current;
      if (found.length === 0) return;
      const from = at ?? -1;
      const next =
        delta > 0
          ? (found.find((i) => i > from) ?? found[0]!)
          : ([...found].reverse().find((i) => i < from) ?? found[found.length - 1]!);
      goTo(next);
    },
    [goTo],
  );

  useEffect(() => {
    const shortcuts = [
      {
        key: "G",
        label: "Top of the output",
        /* Going to the top *is* leaving the end, so following stops here rather than
           waiting for a scroll event: the substrate reports a person scrolling away, and
           a key that moves the offset itself is not one of those. */
        action: () => {
          goTo(0);
          state.current.onHold();
        },
      },
      {
        key: "Shift+G",
        label: "Latest output, and follow it",
        action: () => {
          goTo(Math.max(0, state.current.items.length - 1));
          state.current.onJumpToLatest();
        },
      },
      { key: "/", label: "Search the output held in memory", action: () => search.current?.focus() },
      { key: "N", label: "Next match", action: () => cycle(1) },
      { key: "Shift+N", label: "Previous match", action: () => cycle(-1) },
    ];
    const off = shortcuts.map((s) => keyboard.register({ scope: "stream", ...s }));
    return () => off.forEach((u) => u());
  }, [keyboard, goTo, cycle]);

  useImperativeHandle(
    ref,
    () => ({
      shiftBy: (n: number) => list.current?.shiftBy(n),
      reveal: (index: number) => list.current?.reveal(index),
    }),
    [],
  );

  const select = useCallback(
    (index: number) => {
      setSelected(index);
      // Returning to the end by any means re-enters following — including `End`, which is
      // the substrate's and must not be registered a second time in this scope.
      if (index === items.length - 1) onJumpToLatest();
    },
    [items.length, onJumpToLatest],
  );

  /** `Enter` commits the search and hands focus back to the lines, where `N` works. */
  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const first = matches[0];
    if (first !== undefined) goTo(first);
  };

  const last = items.length - 1;

  return (
    <div
      className={["orca-log", textClass("mono-log"), className].filter(Boolean).join(" ")}
      /* The region, its name and its silence, in that order — see the header. The role is
         what puts the output in a screen reader's region list; `aria-live="off"` is what
         stops the role's implicit `polite` from reading the stream out loud. */
      role="log"
      aria-live="off"
      aria-label={label}
    >
      <div className={`orca-pane__head ${textClass("label-strong")}`}>
        <span>Output</span>
        <input
          ref={search}
          className={`orca-input ${textClass("mono-body")} orca-step__find`}
          type="search"
          value={query}
          aria-label="Search the output held in memory"
          placeholder="Search buffered lines"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKey}
        />
        {query.trim() !== "" && (
          <Text style="caption" className="orca-faint">
            {`${matches.length} in ${rows.length} buffered lines`}
          </Text>
        )}
      </div>

      <VirtualList
        className="orca-step__stream"
        label={label}
        noun="line"
        scope="stream"
        items={items}
        rowId={rowId}
        rowClassName={rowClassName}
        renderRow={(row, index) => (
          <Row row={row} caret={streaming && index === last} loading={loadingEarlier} onLoadEarlier={onLoadEarlier} />
        )}
        selectedIndex={selected}
        onSelect={select}
        follow={mode === "following"}
        onHold={onHold}
        ref={list}
      />

      {mode === "held" && (
        <button type="button" className={`orca-jump ${textClass("caption")}`} onClick={onJumpToLatest}>
          {/* The count is the point: "go to the end" is worth less than "412 lines have
              happened since you stopped looking". */}
          {`↓ ${counted(pending, "new line")}`}
        </button>
      )}
    </div>
  );
}

/**
 * Every row is exactly one `--row-h` tall, whichever of the three kinds it is (rule 9).
 *
 * A seam takes `.orca-timeline-rule` *instead of* `.orca-log__line`, not as well: the rule
 * draws its hairline with `::before`/`::after` flex fills and the line is a two-column
 * grid, and the two cannot be the same box. `.orca-step__seam` is what cuts the rule's
 * padding back to the bound row height.
 */
const rowClassName = (row: PaneRow, _index: number, selected: boolean): string => {
  const seam = row.kind === "paused" || row.kind === "reconnected";
  return [
    seam ? `orca-timeline-rule ${textClass("caption")} orca-step__seam` : "orca-log__line",
    selected ? "orca-step__line--selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
};

interface RowProps {
  row: PaneRow;
  caret: boolean;
  loading: boolean;
  onLoadEarlier?: (() => void) | undefined;
}

function Row({ row, caret, loading, onLoadEarlier }: RowProps): JSX.Element {
  if (row.kind === "line") return <Line row={row} caret={caret} />;
  if (row.kind === "edge") return <Edge before={row.before} loading={loading} onLoadEarlier={onLoadEarlier} />;
  return (
    <span>{row.kind === "paused" ? `${PAUSED_GLYPH} paused — reconnecting` : `reconnected ${clockOf(row.at)}`}</span>
  );
}

function Line({ row, caret }: { row: LineRow; caret: boolean }): JSX.Element {
  return (
    <>
      {/* The line's *event* sequence number, not an ordinal. It repeats when one
          `agent.update` rendered several lines, and that is the honest rendering: a line
          boundary is not a thing the wire can name, and `seq` is what a `before` cursor
          and the trim marker are both written in. */}
      <span className="orca-log__n">{row.seq}</span>
      <span className={`orca-log__t${row.tone === "out" ? "" : ` orca-log__t--${row.tone === "dim" ? "dim" : "err"}`}`}>
        {row.text}
        {row.folded > 0 && <span className={`orca-log__fold ${textClass("caption")}`}>{foldLabel(row.folded)}</span>}
        {caret && <span className="orca-log__caret" aria-hidden="true" />}
      </span>
    </>
  );
}

function Edge({
  before,
  loading,
  onLoadEarlier,
}: {
  before: number | undefined;
  loading: boolean;
  onLoadEarlier?: (() => void) | undefined;
}): JSX.Element {
  if (before === undefined) {
    return (
      <>
        <span className="orca-log__n" />
        <Text style="caption" className="orca-faint">
          Start of this step&rsquo;s output
        </Text>
      </>
    );
  }
  return (
    <>
      <span className="orca-log__n" />
      <span className="orca-log__t--dim">
        <Text style="caption" className="orca-faint">
          {`Earlier output is on disk, from event ${before}. `}
        </Text>
        {/* A bare button, not `.orca-btn`: this sits inside a row bound to `row-log`, and a
            control with a control height in it would be a row that grew for its content. */}
        <button
          type="button"
          className={`orca-bare ${textClass("caption")} orca-step__more`}
          onClick={() => onLoadEarlier?.()}
          {...(loading || !onLoadEarlier ? { "aria-disabled": true } : {})}
        >
          {loading ? "Loading…" : "Load earlier output"}
        </button>
      </span>
    </>
  );
}

/** What the pane is called for a screen reader — the one place the wording is written. */
export function outputLabel(nodeId: string, attempt: number): string {
  return `Output of ${nodeId}, attempt ${attempt}`;
}

/** `status-stale`'s glyph: the system's mark for "nothing is happening here now". */
export const PAUSED_GLYPH = "◷";
