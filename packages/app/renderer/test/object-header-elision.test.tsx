// @vitest-environment happy-dom
/**
 * Chain elision in the object header, as a person meets it: the trail folds its middle into
 * `…` when it does not fit, `…` is a menu of what it holds, and choosing one goes where the
 * crumb would have.
 *
 * happy-dom has no layout engine, so the widths are injected: through `ObjectHeader`'s
 * `measure` where the question is what the header *does* with a measurement, and by
 * stubbing the boxes the default measurer reads where the question is what it measures.
 * Which crumbs fold for which widths is `crumb-elision.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { harness } from "./harness.js";
import { ObjectHeader, type Crumb, type ObjectHeaderProps, type TrailMeasurer } from "../src/ui/index.js";

const REQUEST = "req_01M4M896DER1YQSTMV3G5BNH42";

/** The Runs header's whole chain: request ▸ work item ▸ run ▸ step. */
const CHAIN: readonly Crumb[] = [
  { type: "request", id: REQUEST, label: REQUEST },
  { type: "item", id: "wi_01M4M899VKJZRZSBHNDY5M579G", label: "Database schema" },
  {
    type: "run",
    id: "run_01M4M8A1WDAQMMX98Q6KJH7X8P",
    label: "Nightly build",
    version: "ai-sdlc v1",
    counterpartIds: { workflow: "ai-sdlc" },
  },
  { type: "step", id: "step_01M4M899NFEG7WR79H3HC6SE2Q", label: "design (attempt 2)", current: true },
];

/** Natural widths for `CHAIN`: all four with gaps is 904, folding the item 708, the run too 400. */
const WIDTHS = [120, 220, 300, 240];

/** A measurer that reports `available` for the trail and `widths` for the crumbs. */
const room = (available: number, widths: readonly number[] = WIDTHS): ReturnType<typeof vi.fn<TrailMeasurer>> =>
  vi.fn<TrailMeasurer>(() => ({ available, crumbs: widths, elision: 24, gap: 8 }));

const teardown: (() => void)[] = [];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  while (teardown.length) teardown.pop()?.();
});

function mount(ui: ReactNode): { rerender: (next: ReactNode) => void } {
  const h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  const { rerender } = render(<Providers>{ui}</Providers>);
  return { rerender: (next) => rerender(<Providers>{next}</Providers>) };
}

function header(props: Partial<ObjectHeaderProps> & { measure: TrailMeasurer }): ReactNode {
  return <ObjectHeader crumbs={CHAIN} onOpen={() => {}} onOpenCounterpart={() => {}} {...props} />;
}

const nav = (): HTMLElement => screen.getByRole("navigation", { name: "Object" });
/** The trail as a screen reader has it: the one list in the header it can reach. */
const trail = (): HTMLElement => within(nav()).getByRole("list");
const levels = (): HTMLElement[] => within(trail()).getAllByRole("listitem");
const folded = (): HTMLElement | null => within(nav()).queryByRole("button", { name: /hidden levels?:/ });
/** What each place in the trail says, with `…` for the fold. */
const shown = (): string[] =>
  levels().map((level) => {
    if (within(level).queryByRole("button", { name: /hidden levels?:/ })) return "…";
    return level.querySelector(".orca-crumb__type")?.textContent ?? "";
  });

describe("chain elision in the object header", () => {
  it("shows the whole chain when it fits — a wide window folds nothing", () => {
    mount(header({ measure: room(1000) }));
    expect(shown()).toEqual(["request", "item", "run", "step"]);
    expect(folded()).toBeNull();
  });

  it("folds the work item first, keeping the root and the last two", () => {
    mount(header({ measure: room(800) }));
    expect(shown()).toEqual(["request", "…", "run", "step"]);
    expect(folded()?.getAttribute("aria-label")).toBe("1 hidden level: work item Database schema");
    // The folded crumb is not a second control on screen: `…` is the way to it.
    expect(within(nav()).queryByRole("button", { name: /^Database schema/ })).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Links for Database schema" })).toBeNull();
  });

  it("folds the parent last, and never the current crumb, however narrow", () => {
    const { rerender } = mount(header({ measure: room(500) }));
    expect(shown()).toEqual(["request", "…", "step"]);
    expect(folded()?.getAttribute("aria-label")).toBe("2 hidden levels: work item Database schema, run Nightly build");

    rerender(header({ measure: room(1) }));
    expect(shown()).toEqual(["request", "…", "step"]);
    // Still the current crumb, still not a link.
    const current = within(trail()).getByText("design (attempt 2)").closest(".orca-crumb");
    expect(current?.getAttribute("aria-current")).toBe("page");
    expect(current?.tagName).toBe("SPAN");
  });

  it("unfolds when the room comes back", () => {
    const { rerender } = mount(header({ measure: room(500) }));
    expect(folded()).not.toBeNull();
    rerender(header({ measure: room(1000) }));
    expect(shown()).toEqual(["request", "item", "run", "step"]);
    expect(folded()).toBeNull();
  });

  it("never folds a trail of three that fits", () => {
    const three = CHAIN.slice(1);
    const { rerender } = mount(header({ crumbs: three, measure: room(776, [220, 300, 240]) }));
    expect(shown()).toEqual(["item", "run", "step"]);
    rerender(header({ crumbs: three, measure: room(775, [220, 300, 240]) }));
    expect(shown()).toEqual(["item", "…", "step"]);
  });

  it("lists the folded crumbs in order, as type, name and token, and opens one as its crumb would", () => {
    const onOpen = vi.fn();
    mount(header({ measure: room(500), onOpen }));

    fireEvent.click(folded()!);
    const menu = screen.getByRole("menu", { name: "2 hidden levels: work item Database schema, run Nightly build" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    // Name, then the faint token, then the type as the item's hint.
    expect(items[0]!.querySelector(".orca-objid-named__name")?.textContent).toBe("Database schema");
    expect(items[0]!.querySelector(".orca-objid__tail")?.textContent).toBe("5M579G");
    expect(items[0]!.querySelector(".orca-menu__type")?.textContent).toBe("item");
    expect(items[1]!.querySelector(".orca-objid-named__name")?.textContent).toBe("Nightly build");
    expect(items[1]!.querySelector(".orca-objid__tail")?.textContent).toBe("JH7X8P");
    expect(items[1]!.querySelector(".orca-menu__type")?.textContent).toBe("run");
    // The menu primitive's contract: focus lands on the first item.
    expect(document.activeElement).toBe(items[0]);

    fireEvent.click(items[1]!);
    // The crumb itself, as `onOpen` would have had it from the crumb — the chrome routes it.
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(CHAIN[2]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(folded());
  });

  it("walks the folded crumbs with the keyboard, as every menu does", () => {
    const onOpen = vi.fn();
    mount(header({ measure: room(500), onOpen }));

    folded()!.focus();
    fireEvent.click(folded()!);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter", code: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(CHAIN[2]);
  });

  it("draws a folded crumb with no name as its token, never its raw id", () => {
    // A nameless crumb in the middle of a trail: no surface builds one today, but `…` must
    // not print a raw id when one does.
    const crumbs: readonly Crumb[] = [CHAIN[1]!, CHAIN[0]!, CHAIN[2]!, CHAIN[3]!];
    mount(header({ crumbs, measure: room(500, [220, 120, 300, 240]) }));

    expect(folded()?.getAttribute("aria-label")).toBe("2 hidden levels: request 5BNH42, run Nightly build");
    fireEvent.click(folded()!);
    const [request] = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(request!.textContent).not.toContain(REQUEST);
    expect(request!.querySelector(".orca-objid__tail")?.textContent).toBe("5BNH42");
    // The token is the label, so it is not drawn faint, and it says its kind.
    expect(request!.querySelector(".orca-objid--faint")).toBeNull();
    expect(request!.querySelector(".orca-visually-hidden")?.textContent).toBe("request ");
  });

  it("is a button in the tab order that says it opens a menu", () => {
    mount(header({ measure: room(500) }));
    const trigger = folded()!;
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.hasAttribute("tabindex")).toBe(false);
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // The glyph is decoration; the name is the trigger's label.
    expect(trigger.textContent).toBe("…");
    expect(trigger.querySelector('[aria-hidden="true"]')?.textContent).toBe("…");
  });

  it("keeps the folded crumbs where only the measurer reaches them", () => {
    const measure = room(500);
    mount(header({ measure }));

    const unseen = nav().querySelector(".orca-objhead__measure")!;
    expect(unseen.getAttribute("aria-hidden")).toBe("true");
    expect(unseen.hasAttribute("inert")).toBe(true);
    expect(unseen.textContent).toContain("Database schema");
    expect(unseen.textContent).toContain("Nightly build");
    expect(trail().textContent).not.toContain("Database schema");

    // Every crumb, in chain order, wherever it is drawn: the decision is over all of them.
    const [list, crumbs, elision] = measure.mock.lastCall!;
    expect(list).toBe(nav().querySelector(".orca-objhead__trail"));
    expect(crumbs.map((crumb) => crumb.getAttribute("data-orca-crumb"))).toEqual(["0", "1", "2", "3"]);
    expect(unseen.contains(crumbs[1]!)).toBe(true);
    expect(unseen.contains(crumbs[2]!)).toBe(true);
    expect(trail().contains(crumbs[3]!)).toBe(true);
    expect(unseen.contains(elision)).toBe(true);
  });

  it("builds a folded crumb's link from the whole chain, not the trail on screen", () => {
    // The step's Copy link needs the run above it, which is folded.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    teardown.push(() => Reflect.deleteProperty(navigator, "clipboard"));
    mount(header({ measure: room(500) }));

    fireEvent.click(within(nav()).getByRole("button", { name: "Links for design (attempt 2)" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy link/ }));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringMatching(/^orca:\/\/run\/run_01M4M8A1WDAQMMX98Q6KJH7X8P\/step\//),
    );
  });
});

describe("the header variants, narrow", () => {
  it("never folds plan ▸ work item, and the mode control and the actions stay", () => {
    const crumbs: readonly Crumb[] = [
      { type: "plan", id: "plan-auth", label: "Auth rollout" },
      { type: "item", id: "wi_01M4M899VKJZRZSBHNDY5M579G", label: "Database schema", current: true },
    ];
    mount(
      <ObjectHeader
        crumbs={crumbs}
        measure={room(40, [180, 260])}
        mode={{
          options: [
            { id: "schedule", label: "Schedule" },
            { id: "journal", label: "Journal" },
          ],
          active: "schedule",
          onChange: () => {},
          label: "Plan view",
        }}
        actions={<span className="orca-id">auth-rollout</span>}
      />,
    );

    expect(shown()).toEqual(["plan", "item"]);
    expect(folded()).toBeNull();
    const mode = within(nav()).getByRole("group", { name: "Plan view" });
    expect(
      within(mode)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Schedule", "Journal"]);
    expect(nav().textContent).toContain("auth-rollout");
    // The trail is first and the controls follow it, so the trail is what gives way.
    expect(nav().firstElementChild).toBe(trail());
  });
});

describe("the default measurer", () => {
  /**
   * Boxes a layout engine would have produced, by what the header draws. Everything else is
   * the zero box happy-dom draws anyway.
   */
  function layOut(widths: { trail: number; crumbs: readonly number[]; elision: number }): void {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const at = this.getAttribute("data-orca-crumb");
      const width = this.matches(".orca-objhead__trail")
        ? widths.trail
        : at !== null
          ? (widths.crumbs[Number(at)] ?? 0)
          : this.matches(".orca-objhead__measure-row > li:last-child")
            ? widths.elision
            : 0;
      return new DOMRect(0, 0, width, 0);
    });
  }

  it("measures the current crumb at its whole width while its name is cut", () => {
    // The step's box is 140 because its name is cut by 100: whole, it is 240. Measured as
    // 140 the run would fit beside it in 650 (584) and unfold — and the name would be cut
    // again, every frame. Measured whole (684), the run folds and the name is not cut.
    layOut({ trail: 650, crumbs: [120, 220, 300, 140], elision: 24 });
    const cut = (element: Element): boolean =>
      element.matches(".orca-crumb__name") && element.closest(".orca-objhead__crumb--current") !== null;
    /* happy-dom keeps these getters on whichever prototype it likes; stub them where they are. */
    const stub = (property: "scrollWidth" | "clientWidth", width: number): void => {
      let owner: object | null = HTMLElement.prototype;
      while (owner !== null && !Object.prototype.hasOwnProperty.call(owner, property)) {
        owner = Object.getPrototypeOf(owner) as object | null;
      }
      // Zero for everything else, which is what happy-dom measures.
      vi.spyOn(owner as HTMLElement, property, "get").mockImplementation(function (this: HTMLElement) {
        return cut(this) ? width : 0;
      });
    };
    stub("scrollWidth", 200);
    stub("clientWidth", 100);

    mount(<ObjectHeader crumbs={CHAIN} onOpen={() => {}} />);
    expect(shown()).toEqual(["request", "…", "step"]);
  });

  it("folds nothing when nothing has been laid out", () => {
    mount(<ObjectHeader crumbs={CHAIN} onOpen={() => {}} />);
    expect(shown()).toEqual(["request", "item", "run", "step"]);
  });
});
