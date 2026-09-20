/**
 * `VirtualList` — the substrate every list surface in the app is built on: the Runs list
 * today, the run tree, the event timeline and the inputs queue as they land.
 *
 * It renders a window, not a list. A store with fifty thousand runs in it is one
 * `runs.list` answer, and putting fifty thousand rows in the document costs a second of
 * layout, a hundred megabytes and a scroll that stutters for the rest of the session — so
 * what is in the document is the band a person can see plus a few rows either side, with
 * the rest standing in as two spacer heights. The scrollbar is still the length of the
 * whole list, because the spacers are.
 *
 * What the substrate owns, and why each one is here rather than in a surface:
 *
 * - **the row's identity and its ARIA**: one `option` per row, `aria-selected`, and a
 *   single tab stop on the listbox with `aria-activedescendant` naming the selected row.
 *   Focus stays on the listbox; selection moves between rows. They are different things
 *   and both have to stay legible (docs/design/RULES.md rule 10) — one is the ring the
 *   `:focus-visible` rule draws, the other is `--surface-selected` and the accent rail the
 *   surface's row class carries.
 * - **the keys**, registered on the `KeyboardMap` in the `list` scope (`use-list-keys.ts`),
 *   because a list that bound its own `keydown` would be a list whose keys the command
 *   palette cannot show — and because two surfaces binding `J` in one scope is a bug the
 *   map throws on rather than a race.
 * - **scrolling to a row**, which replaces `scrollIntoView`: the row a key just selected
 *   may not be in the document at all. See `use-list-viewport.ts`.
 * - **the status minimap**, which is over the *whole* list and not the window. That is the
 *   entire point of it: a failed run four thousand rows down is a mark on the right-hand
 *   edge you can click, rather than something you find by scrolling past it.
 *
 * What it does not own: what a row looks like. The surface passes the row's class — a
 * system row class such as `.orca-tree-row`, which is where `--row-h` and the selection
 * rail come from — and the cells inside it. The substrate never states a height; it reads
 * the one the cascade already bound (`row-height.ts`).
 */
import { useCallback, useEffect, useMemo, useRef, type JSX, type ReactNode } from "react";
import { scopeProps } from "../keyboard-map.js";
import { textClass } from "../ui/index.js";
import { moveIndex, pageRows, tickOffset, type ListMove } from "./list-window.js";
import { useListKeys } from "./use-list-keys.js";
import { useListViewport } from "./use-list-viewport.js";
import "./list.css";

/**
 * The three statuses the minimap has a colour for
 * (`.orca-minimap__tick--{failed,waiting,blocked}` in components.css). It is deliberately
 * not the eight run statuses: a gutter that marked every row would mark nothing, and these
 * are the three a person scrolls a long list looking for.
 */
export type MinimapKind = "failed" | "waiting" | "blocked";

export interface VirtualListTick {
  /** Index into the whole list, not into the rendered window. */
  index: number;
  kind: MinimapKind;
  /** The tick's accessible name — it is a control, so it says which row it jumps to. */
  label: string;
}

export interface VirtualListProps<T> {
  /** The whole list, in order. Only a window of it is ever in the document. */
  items: readonly T[];
  /** The listbox's accessible name: "Runs". */
  label: string;
  /** A stable DOM id per row; `aria-activedescendant` names it. */
  rowId: (item: T, index: number) => string;
  /** The row's own classes — a system row class, which is where `--row-h` comes from. */
  rowClassName?: (item: T, index: number, selected: boolean) => string;
  /** The cells inside the row. The substrate supplies the row element around them. */
  renderRow: (item: T, index: number, selected: boolean) => ReactNode;
  selectedIndex: number | undefined;
  onSelect: (index: number) => void;
  /** The word the palette uses for a row: "run" gives "Next run". */
  noun?: string;
  /**
   * Two lines is a declared variant, never a row that grew (rule 9). The row is exactly two
   * `--row-h` tall and the arithmetic counts it that way.
   */
  variant?: "single" | "two-line";
  /** Ticks for the whole list. Pass an empty array to keep the gutter and no marks. */
  ticks?: readonly VirtualListTick[];
  /** The sticky context header's content. It lifts only once content is under it. */
  header?: ReactNode;
  /** The surface's class on the substrate's root, for its own place in a layout. */
  className?: string;
}

export function VirtualList<T>(props: VirtualListProps<T>): JSX.Element {
  const {
    items,
    label,
    rowId,
    rowClassName,
    renderRow,
    selectedIndex,
    onSelect,
    noun = "row",
    variant = "single",
    ticks,
    header,
    className,
  } = props;

  const count = items.length;
  const viewport = useListViewport(count, variant === "two-line" ? 2 : 1);
  const { metricsRef, reveal, window: slice } = viewport;

  /* Both read through refs by the key handler, which keeps one identity for the life of
     the list so the eight shortcuts are registered once (see `use-list-keys.ts`). */
  const selected = useRef(selectedIndex);
  selected.current = selectedIndex;
  const select = useRef(onSelect);
  select.current = onSelect;

  const move = useCallback(
    (kind: ListMove) => {
      const metrics = metricsRef.current;
      if (metrics.count === 0) return;
      const next = moveIndex(kind, selected.current, metrics.count, pageRows(metrics));
      select.current(next);
      reveal(next);
    },
    [metricsRef, reveal],
  );
  useListKeys(noun, move);

  /* Keep the selected row on screen — for a click as much as for a key, and again when the
     row height changes under it, which is what a density toggle does. The selection itself
     is the surface's state and survives all of it; this only moves the window to it. */
  const rowHeight = viewport.metrics.rowHeight;
  useEffect(() => {
    if (selectedIndex !== undefined) reveal(selectedIndex);
  }, [selectedIndex, rowHeight, reveal]);

  /* The id of the selected row, and only while that row is one the list actually has: a
     dangling `aria-activedescendant` names nothing, which is worse than naming nothing. */
  let activeId: string | undefined;
  if (selectedIndex !== undefined) {
    const active = items[selectedIndex];
    if (active !== undefined) activeId = rowId(active, selectedIndex);
  }
  const rendered = items.slice(slice.first, slice.end);

  return (
    <div
      className={["orca-list", variant === "two-line" ? "orca-list--two-line" : "", className]
        .filter(Boolean)
        .join(" ")}
      {...scopeProps("list")}
    >
      <div className="orca-list__scroller" ref={viewport.scrollerRef} onScroll={viewport.onScroll}>
        {header !== undefined && (
          <div
            className={[
              "orca-pane__head",
              textClass("label-strong"),
              viewport.scrolled ? "orca-pane__head--sticky" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {header}
          </div>
        )}
        {/* The rows the window left out are this element's padding rather than two spacer
            elements, so every child of the listbox is an option. The two numbers are
            arithmetic over a measured row height, not values anybody chose. */}
        <div
          className="orca-list__rows"
          role="listbox"
          aria-label={label}
          tabIndex={0}
          style={{ paddingTop: slice.padTop, paddingBottom: slice.padBottom }}
          {...(activeId !== undefined ? { "aria-activedescendant": activeId } : {})}
        >
          {rendered.map((item, offset) => {
            const index = slice.first + offset;
            const isSelected = index === selectedIndex;
            const id = rowId(item, index);
            return (
              <div
                key={id}
                id={id}
                role="option"
                aria-selected={isSelected}
                className={["orca-list__row", rowClassName?.(item, index, isSelected) ?? ""].filter(Boolean).join(" ")}
                onClick={() => onSelect(index)}
              >
                {renderRow(item, index, isSelected)}
              </div>
            );
          })}
        </div>
      </div>
      {ticks !== undefined && <Minimap label={label} ticks={ticks} count={count} onGoTo={reveal} />}
    </div>
  );
}

/**
 * The gutter. Each tick is a button, not a mark: the one reason to draw a failure you
 * cannot see is to be able to go to it, and a mark that is only informative leaves a person
 * scrolling for the row it promised. Position is a percentage of the whole list, so the
 * gutter reads as the list's own length whatever is rendered.
 */
function Minimap({
  label,
  ticks,
  count,
  onGoTo,
}: {
  label: string;
  ticks: readonly VirtualListTick[];
  count: number;
  onGoTo: (index: number) => void;
}): JSX.Element {
  const marks = useMemo(
    () => ticks.map((tick) => ({ ...tick, offset: tickOffset(tick.index, count) })),
    [ticks, count],
  );

  return (
    <div className="orca-minimap" role="group" aria-label={`${label}, status gutter`}>
      {marks.map((mark) => (
        <button
          key={`${mark.kind}-${mark.index}`}
          type="button"
          className={`orca-minimap__tick orca-minimap__tick--${mark.kind} orca-list__tick`}
          style={{ top: `${mark.offset}%` }}
          aria-label={mark.label}
          onClick={() => onGoTo(mark.index)}
        />
      ))}
    </div>
  );
}
