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
import { useMemo, useState, type JSX, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UNMEASURED_ROWS } from "../src/list/list-window.js";
import { VirtualList, type VirtualListTick } from "../src/list/virtual-list.js";
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
}

/**
 * A list of `count` rows, selected by whatever moved the selection last, under a surface
 * root — which is where density is set, as it is in the real chrome.
 *
 * `ticks` is spread rather than passed: a list with no gutter at all is a case too, and
 * under `exactOptionalPropertyTypes` an absent prop and an `undefined` one differ.
 */
function Fixture({ count, ticks, header, variant = "single" }: ListProps): JSX.Element {
  const items = useMemo(() => Array.from({ length: count }, (_, i) => `row-${i}`), [count]);
  const [selected, setSelected] = useState<number | undefined>(undefined);

  return (
    <div className="orca-surface" data-surface="proof">
      <VirtualList
        label="Rows"
        items={items}
        header={header}
        variant={variant}
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
});
