// @vitest-environment happy-dom
/**
 * `VirtualList` as a screen: fifty thousand rows, the keys that move through them, the
 * status gutter, the sticky header and the density toggle.
 *
 * happy-dom has no layout engine, so a virtual list would otherwise only ever be tested in
 * its unmeasured mode — which is a real mode, and has its own section at the bottom, but is
 * not the one a person uses. The `describe` below therefore stands in for the two things a
 * layout would have supplied, and nothing else:
 *
 * - **the cascade**, as a stylesheet binding `--row-h` on the scroller with a
 *   `data-density="compact"` variant, exactly as `components.css` binds it on
 *   `.orca-surface`. happy-dom does not inherit custom properties down the tree, which the
 *   real cascade does, so the binding is written onto the element the substrate reads;
 * - **the viewport**, as a `clientHeight` on the scroller element.
 *
 * Everything else — the window, the spacers, the scroll offsets, the ticks — is the
 * substrate's own arithmetic over those two numbers, and is asserted in pixels a reader can
 * check by hand. `list-window.test.ts` covers that arithmetic's edges without a DOM.
 */
import { useMemo, useRef, useState, type JSX, type ReactNode, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UNMEASURED_ROWS } from "../src/list/list-window.js";
import type { ListScope } from "../src/list/list-scope.js";
import { VirtualList, type VirtualListHandle, type VirtualListTick } from "../src/list/virtual-list.js";
import { harness, type Harness } from "./harness.js";

/** The design system's real row heights, so the numbers below are the app's numbers. */
const ROW = 32;
const COMPACT_ROW = 24;
/** Ten comfortable rows of viewport. */
const VIEWPORT = 320;

const teardown: (() => void)[] = [];

interface ListProps {
  count: number;
  ticks?: readonly VirtualListTick[];
  header?: ReactNode;
  variant?: "single" | "two-line";
  scope?: ListScope;
  label?: string;
  /** Row ids are namespaced by the label, so two lists on one screen do not collide. */
  prefix?: string;
}

/**
 * A list of `count` rows, selected by whatever moved the selection last, under a surface
 * root — which is where density is set, as it is in the real chrome.
 *
 * `ticks` is spread rather than passed: a list with no gutter at all is a case too, and
 * under `exactOptionalPropertyTypes` an absent prop and an `undefined` one differ.
 */
function Fixture({
  count,
  ticks,
  header,
  variant = "single",
  scope = "list",
  label = "Rows",
  prefix = "row",
}: ListProps): JSX.Element {
  const items = useMemo(() => Array.from({ length: count }, (_, i) => `${prefix}-${i}`), [count, prefix]);
  const [selected, setSelected] = useState<number | undefined>(undefined);

  return (
    <div className="orca-surface" data-surface="proof">
      <VirtualList
        label={label}
        items={items}
        header={header}
        variant={variant}
        scope={scope}
        {...(ticks ? { ticks } : {})}
        rowId={(item) => item}
        rowClassName={(_item, _index, isSelected) => `orca-tree-row${isSelected ? " orca-tree-row--selected" : ""}`}
        renderRow={(item) => <span className="proof-row__name">{item}</span>}
        selectedIndex={selected}
        onSelect={setSelected}
      />
    </div>
  );
}

function renderList(props: ListProps): Harness {
  const h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      <Fixture {...props} />
    </Providers>,
  );
  return h;
}

const options = (): HTMLElement[] => screen.queryAllByRole("option");
const listbox = (): HTMLElement => screen.getByRole("listbox", { name: "Rows" });
const rowsElement = (): HTMLElement => listbox();
const scroller = (): HTMLElement => document.querySelector<HTMLElement>(".orca-list__scroller")!;
const mounted = (index: number): HTMLElement | null => document.getElementById(`row-${index}`);

/** A bare key on the list, as the keyboard map reads it: `code` for letters, `key` for the rest. */
const press = (key: string, code = key): void => {
  fireEvent.keyDown(listbox(), { key, code });
};

const pixels = (value: string): number => Number.parseFloat(value || "0");

afterEach(() => {
  cleanup();
  while (teardown.length) teardown.pop()?.();
});

describe("a measured list", () => {
  let cascade: HTMLStyleElement;
  let clientHeight: PropertyDescriptor | undefined;

  beforeEach(() => {
    cascade = document.createElement("style");
    cascade.textContent = `
      .orca-list__scroller { --row-h: ${ROW}px; }
      [data-density="compact"] .orca-list__scroller { --row-h: ${COMPACT_ROW}px; }
    `;
    document.head.append(cascade);

    clientHeight = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "clientHeight");
    Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("orca-list__scroller") ? VIEWPORT : 0;
      },
    });
  });

  afterEach(() => {
    cascade.remove();
    Reflect.deleteProperty(window.HTMLElement.prototype, "clientHeight");
    if (clientHeight) Object.defineProperty(window.HTMLElement.prototype, "clientHeight", clientHeight);
  });

  it("puts fifty thousand rows on screen as a few dozen elements", () => {
    renderList({ count: 50_000 });

    // The point of the whole unit: the document holds the band a person can see and the
    // overscan either side of it, not the store.
    expect(options().length).toBeGreaterThan(0);
    expect(options().length).toBeLessThan(100);
    expect(options()[0]!.id).toBe("row-0");
    expect(mounted(1_000)).toBeNull();
  });

  it("keeps the scrollbar the length of the list, not the length of the window", () => {
    renderList({ count: 50_000 });

    const rows = rowsElement();
    const height = pixels(rows.style.paddingTop) + options().length * ROW + pixels(rows.style.paddingBottom);
    expect(height).toBe(50_000 * ROW);
  });

  it("scrolls to an arbitrary row, which is a row no scrollIntoView could have reached", () => {
    renderList({ count: 50_000 });
    expect(mounted(49_999)).toBeNull();

    press("End");

    // The row was not in the document to be scrolled to: the window moved, and the row
    // exists because of it.
    expect(scroller().scrollTop).toBe(50_000 * ROW - VIEWPORT);
    expect(mounted(49_999)).not.toBeNull();
    expect(mounted(0)).toBeNull();
    expect(listbox().getAttribute("aria-activedescendant")).toBe("row-49999");
    expect(options().length).toBeLessThan(100);
  });

  it("moves a page at a time, one row short of a viewport so a person keeps their place", () => {
    renderList({ count: 50_000 });

    press("J", "KeyJ");
    press("PageDown");

    // Ten rows of viewport: a page is nine, so the row that was at the bottom is at the top.
    expect(listbox().getAttribute("aria-activedescendant")).toBe("row-9");
  });

  it("is one tab stop: focus stays on the listbox while the selection moves between rows", () => {
    renderList({ count: 50_000 });
    listbox().focus();

    press("J", "KeyJ");
    press("ArrowDown");

    expect(document.activeElement).toBe(listbox());
    expect(mounted(1)!.getAttribute("aria-selected")).toBe("true");
    expect(mounted(1)!.hasAttribute("tabindex")).toBe(false);
    expect(listbox().getAttribute("aria-activedescendant")).toBe("row-1");
  });

  it("counts a two-line row as two row heights, because it is a variant and not a row that grew", () => {
    renderList({ count: 200, variant: "two-line" });

    expect(document.querySelector(".orca-list--two-line")).not.toBeNull();
    press("End");
    expect(scroller().scrollTop).toBe(200 * ROW * 2 - VIEWPORT);
  });

  describe("the status gutter", () => {
    const ticks: VirtualListTick[] = [
      { index: 31_234, kind: "failed", label: "row-31234, failed" },
      { index: 40_000, kind: "waiting", label: "row-40000, waiting" },
    ];

    it("marks a failed row that is nowhere near the rendered window", () => {
      renderList({ count: 50_000, ticks });

      // Not rendered, and still visible as a mark: without the gutter the only way to know
      // it is there is to scroll thirty thousand rows past it.
      expect(mounted(31_234)).toBeNull();
      const failed = screen.getByRole("button", { name: "row-31234, failed" });
      expect(failed.classList.contains("orca-minimap__tick--failed")).toBe(true);
      expect(failed.style.top).toBe(`${(31_234 / 50_000) * 100}%`);
      expect(screen.getByRole("button", { name: "row-40000, waiting" })).toBeTruthy();
    });

    it("goes to the row when the mark is clicked, because a mark you cannot follow is a tease", () => {
      renderList({ count: 50_000, ticks });

      fireEvent.click(screen.getByRole("button", { name: "row-31234, failed" }));

      expect(mounted(31_234)).not.toBeNull();
      expect(scroller().scrollTop).toBe(31_234 * ROW + ROW - VIEWPORT);
    });
  });

  describe("the sticky context header", () => {
    it("lifts only once content is actually beneath it", () => {
      renderList({ count: 50_000, header: "Today" });
      const header = document.querySelector(".orca-pane__head")!;

      // Nothing has scrolled: a shadow here would say "there is more above" when there is not.
      expect(header.classList.contains("orca-pane__head--sticky")).toBe(false);

      scroller().scrollTop = ROW * 4;
      fireEvent.scroll(scroller());

      expect(document.querySelector(".orca-pane__head")!.classList.contains("orca-pane__head--sticky")).toBe(true);
    });

    it("takes its type class, since a component class no longer carries a size", () => {
      renderList({ count: 10, header: "Today" });
      expect(document.querySelector(".orca-pane__head")!.classList.contains("orca-text-label-strong")).toBe(true);
    });
  });

  it("keeps the selected row when the density changes under it", async () => {
    renderList({ count: 200 });
    press("End");
    expect(scroller().scrollTop).toBe(200 * ROW - VIEWPORT);

    document.querySelector("[data-surface]")!.setAttribute("data-density", "compact");
    /* happy-dom caches an element's computed style until that element itself is mutated, so
       an ancestor's attribute alone leaves the scroller's `--row-h` stale where a browser
       would have recalculated it. This stands in for that recalculation, and nothing else:
       the attribute above is what the substrate is watching, and the re-measure it triggers
       is the thing under test. */
    scroller().setAttribute("data-recalculated", "");

    /* The row height is re-read from the cascade rather than remembered, so the list is now
       in compact rows — and the selection, which is the surface's and not the window's,
       is still on the row it was on and still in the document. */
    await waitFor(() => expect(scroller().scrollTop).toBe(199 * COMPACT_ROW));
    expect(listbox().getAttribute("aria-activedescendant")).toBe("row-199");
    expect(mounted(199)!.getAttribute("aria-selected")).toBe("true");
  });
});

describe("a list nothing has measured", () => {
  /* No stylesheet and no layout: the case of a first frame, a hidden pane, and every
     renderer test that does not go out of its way to fake a viewport — including the whole
     of `runs-surface.test.tsx`. The list still works; it just windows by counting rows. */
  it("windows by row count rather than dividing by a zero row height", () => {
    renderList({ count: 50_000 });

    expect(options()).toHaveLength(UNMEASURED_ROWS);
    expect(rowsElement().style.paddingTop).toBe("0px");
  });

  it("renders a short list whole, which is why a five-row surface is still five rows", () => {
    renderList({ count: 5 });
    expect(options().map((row) => row.id)).toEqual(["row-0", "row-1", "row-2", "row-3", "row-4"]);
  });

  it("still reaches an arbitrary row, by moving the window instead of the scrollbar", () => {
    renderList({ count: 50_000 });

    press("End");

    expect(mounted(49_999)).not.toBeNull();
    expect(listbox().getAttribute("aria-activedescendant")).toBe("row-49999");
    expect(options()).toHaveLength(UNMEASURED_ROWS);
  });

  it("selects the row a click lands on, wherever the window happens to be", () => {
    renderList({ count: 50_000 });

    fireEvent.click(mounted(3)!);

    expect(mounted(3)!.getAttribute("aria-selected")).toBe("true");
    expect(listbox().getAttribute("aria-activedescendant")).toBe("row-3");
  });

  it("takes J, K and its surface's Enter on its one tab stop, which is not a control that presses itself", () => {
    /* The keyboard map leaves `Enter` on a focused button to the button. A list is not one:
       focus stays on the listbox and the row is its active descendant, so a surface's
       "open the selected row" still reaches it — the run tree's, the schedule table's. */
    const h = renderList({ count: 5 });
    const opened: (string | null)[] = [];
    teardown.push(
      h.keyboard.register({
        scope: "list",
        key: "Enter",
        label: "Open the selected row",
        action: () => opened.push(listbox().getAttribute("aria-activedescendant")),
      }),
    );
    listbox().focus();

    for (const key of ["j", "j", "j", "k"]) press(key, `Key${key.toUpperCase()}`);
    expect(fireEvent.keyDown(listbox(), { key: "Enter", code: "Enter" })).toBe(false);
    expect(opened).toEqual(["row-1"]);
  });
});

/**
 * The same two stand-ins as the measured describe above — the cascade that binds `--row-h`
 * and a `clientHeight` on the scroller — as a helper, because the three additions below are
 * all about pixels and none of them is about density.
 */
function measuredLayout(): void {
  let cascade: HTMLStyleElement;
  let clientHeight: PropertyDescriptor | undefined;

  beforeEach(() => {
    cascade = document.createElement("style");
    cascade.textContent = `.orca-list__scroller { --row-h: ${ROW}px; }`;
    document.head.append(cascade);
    clientHeight = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "clientHeight");
    Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("orca-list__scroller") ? VIEWPORT : 0;
      },
    });
  });

  afterEach(() => {
    cascade.remove();
    Reflect.deleteProperty(window.HTMLElement.prototype, "clientHeight");
    if (clientHeight) Object.defineProperty(window.HTMLElement.prototype, "clientHeight", clientHeight);
  });
}

describe("the scope a list claims", () => {
  /* The rule the substrate enforces, in both directions. Wave 2 puts a run tree, an event
     timeline and a stream of agent output on one screen; before `scope` existed the second
     of those threw, which was correct and also made the screen impossible. */

  it("lets two lists share a screen when they are in different scopes", () => {
    const h = harness();
    teardown.push(h.dispose);
    const { Providers } = h;

    render(
      <Providers>
        <Fixture count={20} scope="run-tree" label="Steps" prefix="step" />
        <Fixture count={20} scope="stream" label="Output" prefix="line" />
      </Providers>,
    );

    expect(screen.getByRole("listbox", { name: "Steps" })).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "Output" })).toBeTruthy();
    expect(document.querySelector('[data-kbd-scope="run-tree"]')).not.toBeNull();
    expect(document.querySelector('[data-kbd-scope="stream"]')).not.toBeNull();
  });

  it("still throws when two lists claim one scope, which is how the collision is found", () => {
    const h = harness();
    teardown.push(h.dispose);
    const { Providers } = h;

    expect(() =>
      render(
        <Providers>
          <Fixture count={20} scope="list" label="Runs" prefix="run" />
          <Fixture count={20} scope="list" label="Also runs" prefix="other" />
        </Providers>,
      ),
    ).toThrow(/already registered in scope list/);
  });

  it("registers its keys in its own scope, so J moves the list the focus is in", () => {
    const h = harness();
    teardown.push(h.dispose);
    const { Providers } = h;
    render(
      <Providers>
        <Fixture count={20} scope="stream" label="Output" prefix="line" />
      </Providers>,
    );

    const box = screen.getByRole("listbox", { name: "Output" });
    fireEvent.keyDown(box, { key: "J", code: "KeyJ" });

    expect(box.getAttribute("aria-activedescendant")).toBe("line-0");
    expect(h.keyboard.list().some((s) => s.scope === "stream" && s.key === "J")).toBe(true);
    expect(h.keyboard.list().some((s) => s.scope === "list" && s.key === "J")).toBe(false);
  });
});

describe("shiftBy, for a list that pages backwards", () => {
  measuredLayout();

  /** A list whose items can be prepended to, with the substrate's handle in hand. */
  function Prependable({ handle }: { handle: RefObject<VirtualListHandle | null> }): JSX.Element {
    const [first, setFirst] = useState(1_000);
    const items = useMemo(() => Array.from({ length: 2_000 - first }, (_, i) => `row-${first + i}`), [first]);
    const [selected, setSelected] = useState<number | undefined>(undefined);
    return (
      <div className="orca-surface" data-surface="proof">
        <button type="button" onClick={() => setFirst((f) => f - 100)}>
          Load earlier
        </button>
        <VirtualList
          ref={handle}
          label="Rows"
          items={items}
          rowId={(item) => item}
          renderRow={(item) => <span>{item}</span>}
          selectedIndex={selected}
          onSelect={setSelected}
        />
      </div>
    );
  }

  it("keeps what was on screen on screen after a page is prepended", () => {
    const h = harness();
    teardown.push(h.dispose);
    const { Providers } = h;
    const handle: RefObject<VirtualListHandle | null> = { current: null };
    render(
      <Providers>
        <Prependable handle={handle} />
      </Providers>,
    );

    scroller().scrollTop = ROW * 50;
    fireEvent.scroll(scroller());
    const onScreen = options()[0]!.id;

    // A hundred rows arrive in front of the list, and then the surface says so.
    act(() => {
      screen.getByRole("button", { name: "Load earlier" }).click();
    });
    act(() => {
      handle.current!.shiftBy(100);
    });

    // Without the shift the offset would still be 50 rows down a list that is now a hundred
    // rows longer at the top — which is the page the person just asked for, thrown away.
    expect(scroller().scrollTop).toBe(ROW * 150);
    expect(options()[0]!.id).toBe(onScreen);
  });

  it("reveals an arbitrary row through the same handle, which is what a surface has instead of scrollIntoView", () => {
    const h = harness();
    teardown.push(h.dispose);
    const { Providers } = h;
    const handle: RefObject<VirtualListHandle | null> = { current: null };
    render(
      <Providers>
        <Prependable handle={handle} />
      </Providers>,
    );

    act(() => {
      handle.current!.reveal(900);
    });

    expect(mounted(1_900)).not.toBeNull();
  });
});

describe("follow, for a stream", () => {
  measuredLayout();

  function Stream({
    count,
    onHold,
    handle,
  }: {
    count: number;
    onHold: () => void;
    handle?: RefObject<VirtualListHandle | null>;
  }): JSX.Element {
    const [following, setFollowing] = useState(true);
    const [selected, setSelected] = useState<number | undefined>(undefined);
    const items = useMemo(() => Array.from({ length: count }, (_, i) => `row-${i}`), [count]);
    const held = useRef(onHold);
    held.current = onHold;
    return (
      <div className="orca-surface" data-surface="proof">
        <VirtualList
          ref={handle ?? null}
          label="Rows"
          items={items}
          follow={following}
          onHold={() => {
            setFollowing(false);
            held.current();
          }}
          rowId={(item) => item}
          renderRow={(item) => <span>{item}</span>}
          selectedIndex={selected}
          onSelect={setSelected}
          ticks={[{ index: 20, kind: "failed", label: "Earlier failure" }]}
        />
      </div>
    );
  }

  it.each(["K", "ArrowUp", "Home", "PageUp", "minimap", "reveal"])(
    "holds after %s navigation, including after further appends",
    (navigation) => {
      const h = harness();
      teardown.push(h.dispose);
      const { Providers } = h;
      const onHold = vi.fn();
      const handle: RefObject<VirtualListHandle | null> = { current: null };
      const view = (count: number) => (
        <Providers>
          <Stream count={count} onHold={onHold} handle={handle} />
        </Providers>
      );
      const { rerender } = render(view(100));
      press("End");
      expect(onHold).not.toHaveBeenCalled();
      if (navigation === "minimap") fireEvent.click(screen.getByRole("button", { name: "Earlier failure" }));
      else if (navigation === "reveal") act(() => handle.current!.reveal(20));
      else press(navigation, navigation === "K" ? "KeyK" : navigation);
      const heldAt = scroller().scrollTop;
      expect(heldAt).toBeLessThanOrEqual(100 * ROW - VIEWPORT);
      expect(onHold).toHaveBeenCalledTimes(1);
      fireEvent.scroll(scroller());
      rerender(view(140));
      rerender(view(180));
      expect(scroller().scrollTop).toBe(heldAt);
      expect(onHold).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps automatic selection synchronization and growth from releasing follow", () => {
    const h = harness();
    teardown.push(h.dispose);
    const { Providers } = h;
    const onHold = vi.fn();
    const view = (count: number, selectedIndex: number) => (
      <Providers>
        <VirtualList
          label="Rows"
          items={Array.from({ length: count }, (_, i) => `row-${i}`)}
          rowId={(item) => item}
          renderRow={(item) => <span>{item}</span>}
          selectedIndex={selectedIndex}
          onSelect={() => undefined}
          follow
          onHold={onHold}
        />
      </Providers>
    );
    const { rerender } = render(view(100, 20));
    expect(scroller().scrollTop).toBe(100 * ROW - VIEWPORT);
    rerender(view(100, 10));
    expect(onHold).not.toHaveBeenCalled();
    rerender(view(140, 10));
    expect(scroller().scrollTop).toBe(140 * ROW - VIEWPORT);
    expect(onHold).not.toHaveBeenCalled();
  });

  it("stays at the end as the list grows, and lets go once when a scroll leaves it", () => {
    const h = harness();
    teardown.push(h.dispose);
    const { Providers } = h;
    const onHold = vi.fn();
    const { rerender } = render(
      <Providers>
        <Stream count={100} onHold={onHold} />
      </Providers>,
    );

    expect(scroller().scrollTop).toBe(100 * ROW - VIEWPORT);

    rerender(
      <Providers>
        <Stream count={140} onHold={onHold} />
      </Providers>,
    );
    expect(scroller().scrollTop).toBe(140 * ROW - VIEWPORT);
    expect(onHold).not.toHaveBeenCalled();

    // A drag is many scroll events. Following stops once, not forty times.
    for (const top of [ROW * 60, ROW * 55, ROW * 50]) {
      scroller().scrollTop = top;
      fireEvent.scroll(scroller());
    }
    expect(onHold).toHaveBeenCalledTimes(1);

    // Held: the list grew again and the window did not move.
    rerender(
      <Providers>
        <Stream count={180} onHold={onHold} />
      </Providers>,
    );
    expect(scroller().scrollTop).toBe(ROW * 50);
  });
});
