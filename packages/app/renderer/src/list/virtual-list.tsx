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
 * - **the row's identity and its ARIA**: one row element per row, `aria-selected`, and a
 *   single tab stop on the container with `aria-activedescendant` naming the selected row.
 *   Focus stays on the container; selection moves between rows. They are different things
 *   and both have to stay legible (docs/design/RULES.md rule 10) — one is the ring the
 *   `:focus-visible` rule draws, the other is `--surface-selected` and the accent rail the
 *   surface's row class carries. Whether that is a `listbox` of `option`s or a `tree` of
 *   `treeitem`s is the `role` prop's, and it is the substrate's to set because the row
 *   element is the substrate's — a surface can only reach the row's *children*.
 * - **the keys**, registered on the `KeyboardMap` in the list's scope (`use-list-keys.ts`),
 *   because a list that bound its own `keydown` would be a list whose keys the command
 *   palette cannot show — and because two lists binding `J` in *one* scope is a bug the map
 *   throws on rather than a race. Which is why `scope` is a prop: a screen may hold a run
 *   tree, a timeline and a stream of output, and `J` means "next" in whichever of the three
 *   the focus is in, because scope resolution is innermost-first.
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
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type JSX,
  type Ref,
  type ReactNode,
} from "react";
import { scopeProps } from "../keyboard-map.js";
import { textClass } from "../ui/index.js";
import type { ListScope } from "./list-scope.js";
import { moveIndex, pageRows, tickOffset, type ListMove } from "./list-window.js";
import { useListKeys } from "./use-list-keys.js";
import { useListViewport } from "./use-list-viewport.js";

/**
 * What the minimap has a mark for (`.orca-minimap__tick--*` in components.css): the three
 * statuses a person scrolls a long list looking for, plus where they currently are.
 *
 * It is deliberately not the eight run statuses — a gutter that marked every row would mark
 * nothing. `current` is not a status at all, and draws taller rather than only differently
 * coloured, so position cannot be mistaken for a state.
 */
export type MinimapKind = "failed" | "waiting" | "blocked" | "current";

export interface VirtualListTick {
  /** Index into the whole list, not into the rendered window. */
  index: number;
  kind: MinimapKind;
  /** The tick's accessible name — it is a control, so it says which row it jumps to. */
  label: string;
}

/**
 * The two things a surface cannot ask for by re-rendering, so they are imperative.
 *
 * `reveal` is "put this row on screen" — the same call the keys make. `shiftBy` is the one
 * a list that pages *backwards* needs: after `rows` items land in front of the list, every
 * index moved down by `rows`, and a scroll offset left alone would throw a person back by
 * exactly the page they just asked to see.
 */
export interface VirtualListHandle {
  /** Explicit navigation: releases following when targeting an earlier row. */
  reveal: (index: number) => void;
  shiftBy: (rows: number) => void;
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
  /**
   * Which `ShortcutScope` this list's keys belong to. One list per scope: a second
   * `VirtualList` in the same scope registers `J` twice and the `KeyboardMap` throws, which
   * is how a collision is meant to be found. Defaults to `list`.
   */
  scope?: ListScope;
  /**
   * Stay at the end as the list grows — a stream that is following. A growing `items`
   * reveals the last row; a scroll away from the bottom is the person taking it back, and
   * calls `onHold` **once** rather than on every scroll event. The surface owns the flag:
   * the substrate says when following stopped, not whether it should start again.
   */
  follow?: boolean;
  /** Called once when scrolling or explicit navigation releases `follow`. */
  onHold?: () => void;
  /**
   * What the rows *are*, as ARIA sees them. `listbox` of `option`s is a flat list of
   * choices and is the default; `tree` of `treeitem`s is a list whose rows have depth, and
   * the run tree is one (#156, docs/design/50-accessibility-and-keyboard.md); `grid` of
   * `row`s is a list whose rows have *controls* in them, and the plan's schedule table is
   * one (#170).
   *
   * That third one is not a preference. An `option` is a leaf: a control inside one is
   * unreachable — the row is one stop and the button inside it is not another — and axe
   * says so as `nested-interactive`. A `grid` is the role that carries cells which may
   * themselves be interactive, so a surface whose rows hold a button asks for it and gives
   * each cell `role="gridcell"` in `renderRow`.
   *
   * It is the substrate's to set because the substrate owns the row element — a surface
   * that put `aria-level` on a span inside the row, or a `treeitem` inside an `option`,
   * would be writing invalid ARIA and a screen reader would read a flat list either way.
   * Everything else is the same for all three: one tab stop, `aria-activedescendant`,
   * `aria-selected`.
   */
  role?: "listbox" | "tree" | "grid";
  /**
   * Per-row ARIA only the surface can know: `aria-level` and `aria-expanded` on a tree row.
   * Merged onto the row element the substrate renders, after the attributes the substrate
   * owns, and intended for nothing else — a row's *content* is `renderRow`'s.
   */
  rowProps?: (item: T, index: number, selected: boolean) => Record<string, string | number | boolean | undefined>;
  /**
   * Per-row custom properties the row's own class reads: `--level` on a tree row, which
   * `.orca-tree-row` indents by. Custom properties only — how a row looks stays its class's;
   * this is how a value only the surface knows (how deep the row is) reaches that class.
   */
  rowStyle?: (item: T, index: number, selected: boolean) => Record<`--${string}`, string | number>;
  /** The imperative half: `reveal` and `shiftBy`. */
  ref?: Ref<VirtualListHandle>;
}

/** The row role that goes with each container role. A tree of `option`s is not a tree. */
const ROW_ROLE = { listbox: "option", tree: "treeitem", grid: "row" } as const;

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
    scope = "list",
    follow = false,
    onHold,
    role = "listbox",
    rowProps,
    rowStyle,
    ref,
  } = props;

  const count = items.length;

  /* Through a ref, so the viewport's scroll handler keeps one identity: it is on the
     scroller's `onScroll` and re-binding it on every frame of a stream would be a listener
     churned forty times a second. */
  const hold = useRef(onHold);
  hold.current = onHold;
  const leaveBottom = useCallback(() => hold.current?.(), []);

  const viewport = useListViewport(count, variant === "two-line" ? 2 : 1, follow ? leaveBottom : undefined);
  const { metricsRef, reveal: revealAutomatically, shiftBy, window: slice } = viewport;
  const following = useRef(follow);
  following.current = follow;
  // Keys, the minimap and imperative search landings belong to the reader. Selection
  // synchronization, density changes, prepends and appends remain automatic maintenance.
  const reveal = useCallback(
    (index: number) => {
      if (following.current && index >= 0 && index < metricsRef.current.count - 1) {
        following.current = false;
        leaveBottom();
      }
      revealAutomatically(index);
    },
    [metricsRef, leaveBottom, revealAutomatically],
  );

  useImperativeHandle(ref, () => ({ reveal, shiftBy }), [reveal, shiftBy]);

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
  useListKeys(noun, move, scope);

  /* Keep the selected row on screen — for a click as much as for a key, and again when the
     row height changes under it, which is what a density toggle does. The selection itself
     is the surface's state and survives all of it; this only moves the window to it. */
  const rowHeight = viewport.metrics.rowHeight;
  useEffect(() => {
    if (selectedIndex !== undefined) revealAutomatically(selectedIndex);
  }, [selectedIndex, rowHeight, revealAutomatically]);

  /* Following is half an effect and half a scroll handler, and the split is the point: the
     list grew, so go to its end — and a person scrolled away from the end, so stop, which
     is `onLeaveBottom` above. Deciding both from render state would stop a stream on the
     frame between the new offset being computed and being committed, when nobody touched
     anything. */
  useEffect(() => {
    if (follow && count > 0) revealAutomatically(count - 1);
  }, [follow, count, rowHeight, revealAutomatically]);

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
      {...scopeProps(scope)}
    >
      <div className="orca-list__scroller" ref={viewport.scrollerRef} onScroll={viewport.onScroll}>
        {header !== undefined && (
          <div
            className={[
              "orca-pane__head",
              textClass("label-strong"),
              /* Sticky and lifted are two facts and two classes (#240): where the header
                 sits, and whether anything is passing under it. They happen to turn on
                 together here — a header only has to stick once there is something to
                 stick above — but a surface with a header that is always sticky can now
                 say "lift only now" without giving up the first. */
              viewport.scrolled ? "orca-pane__head--sticky orca-pane__head--lifted" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {header}
          </div>
        )}
        {/* The rows the window left out are this element's padding rather than two spacer
            elements, so every child of the container is a row. The two numbers are
            arithmetic over a measured row height, not values anybody chose. */}
        <div
          className="orca-list__rows"
          role={role}
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
                /* The surface's attributes go on first, so the four the substrate owns —
                   the role, the id, the selection and the click — cannot be overwritten by
                   a surface that meant to add `aria-level` and reached too far. */
                {...rowProps?.(item, index, isSelected)}
                style={rowStyle?.(item, index, isSelected)}
                role={ROW_ROLE[role]}
                aria-selected={isSelected}
                className={["orca-list__row", rowClassName?.(item, index, isSelected) ?? ""].filter(Boolean).join(" ")}
                onClick={() => {
                  reveal(index);
                  onSelect(index);
                }}
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
          className={`orca-bare orca-minimap__tick orca-minimap__tick--${mark.kind}`}
          style={{ top: `${mark.offset}%` }}
          aria-label={mark.label}
          onClick={() => onGoTo(mark.index)}
        />
      ))}
    </div>
  );
}
