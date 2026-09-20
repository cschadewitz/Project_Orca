// @vitest-environment happy-dom
/**
 * The popover primitive's contract (#202), asserted through the surface that grew it: the
 * object header's counterpart menu. Two of these are the issue's "done when" — walking the
 * menu with the arrow keys and activating with `Enter` leaves focus on the trigger, and so
 * does closing with `Esc`.
 *
 * `Esc` is fired at the focused item and travels to the window listener the harness
 * installs, exactly as it does in the app: nothing here reaches into the layer stack by
 * hand, because the point of the test is that the menu has no `Escape` handler of its own.
 *
 * Placement is tested two ways, because happy-dom has no layout engine and measures every
 * rectangle as zero: `placeMenu` is a pure function over rects and is tested with real
 * numbers, and the component takes its measurements through an injectable measurer, so the
 * class the decision produces is asserted in the DOM as well.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { harness, type Harness } from "./harness.js";
import { expectedToken, inBothThemes, resolved, setTheme } from "./themes.js";
import { Menu, placeMenu, type Counterpart, type Crumb, type MenuItem, type MenuMeasurement } from "../src/ui/index.js";
import { ObjectHeader } from "../src/ui/object-header.js";
import { useEscapeClosesTopLayer } from "../src/layers-context.js";

const teardown: (() => void)[] = [];

/** The one global `Esc`, which the chrome registers in the app and nothing else may. */
function Escape(): null {
  useEscapeClosesTopLayer();
  return null;
}

function mount(ui: ReactNode): Harness {
  const h = harness();
  teardown.push(h.dispose);
  const { Providers } = h;
  render(
    <Providers>
      <Escape />
      {ui}
    </Providers>,
  );
  return h;
}

const crumbs = [
  { type: "item", id: "auth-sso-epic", label: "auth-sso-epic" },
  { type: "run", id: "7f3a2c", label: "7f3a2c", current: true },
] as const;

const header = (onChoose: (crumb: Crumb, counterpart: Counterpart) => void = () => {}): ReactNode => (
  <ObjectHeader crumbs={crumbs} onOpenCounterpart={onChoose} />
);

const trigger = (): HTMLElement => screen.getByRole("button", { name: "Links for auth-sso-epic" });
const menu = (): HTMLElement => screen.getByRole("menu", { name: "Links for auth-sso-epic" });
const items = (): HTMLElement[] => within(menu()).getAllByRole("menuitem");

/** A key pressed where focus is, which is what the window listener sees in the app. */
function press(key: string): void {
  fireEvent.keyDown(document.activeElement ?? window, { key, code: key });
}

afterEach(() => {
  cleanup();
  setTheme(undefined);
  while (teardown.length) teardown.pop()?.();
});

/* The crumb menu is Copy link and then the counterparts (#165), so the first row of an
   item crumb's menu is the link and the two counterparts follow it. */
describe("the crumb menu, over the Menu primitive", () => {
  it("walks with the arrow keys, activates with Enter, and puts focus back on the trigger", () => {
    const chosen = vi.fn();
    mount(header(chosen));

    fireEvent.click(trigger());
    // Focus moves into the menu on open, onto the first item.
    expect(document.activeElement).toBe(items()[0]);
    expect(items().map((item) => item.textContent)).toEqual([
      "Copy linkorca://",
      "Runs that attempted thisrun",
      "Dependenciesitem",
    ]);

    press("ArrowDown");
    expect(document.activeElement).toBe(items()[1]);
    press("ArrowDown");
    expect(document.activeElement).toBe(items()[2]);
    press("ArrowDown"); // wraps round the end
    expect(document.activeElement).toBe(items()[0]);
    press("ArrowUp");
    expect(document.activeElement).toBe(items()[2]);

    press("Enter");
    expect(chosen).toHaveBeenCalledTimes(1);
    expect(chosen.mock.calls[0]?.[1]).toMatchObject({ id: "dependencies", label: "Dependencies" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Esc, choosing nothing, and puts focus back on the trigger", () => {
    const chosen = vi.fn();
    mount(header(chosen));

    fireEvent.click(trigger());
    press("ArrowDown");
    expect(document.activeElement).toBe(items()[1]);

    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chosen).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
  });

  it("jumps with Home and End, and with the first letter of an item", () => {
    mount(header());
    fireEvent.click(trigger());

    press("End");
    expect(document.activeElement).toBe(items()[2]);
    press("Home");
    expect(document.activeElement).toBe(items()[0]);

    // Typeahead is a local handler on the list, so it is fired there rather than at the window.
    fireEvent.keyDown(document.activeElement!, { key: "d", code: "KeyD" });
    expect(document.activeElement).toBe(items()[2]);
    fireEvent.keyDown(document.activeElement!, { key: "r", code: "KeyR" });
    expect(document.activeElement).toBe(items()[1]);
    // A letter no item starts with leaves focus where it is rather than moving it oddly.
    fireEvent.keyDown(document.activeElement!, { key: "z", code: "KeyZ" });
    expect(document.activeElement).toBe(items()[1]);
    // A modified key is somebody else's shortcut, not typeahead.
    fireEvent.keyDown(document.activeElement!, { key: "d", code: "KeyD", metaKey: true });
    expect(document.activeElement).toBe(items()[1]);
  });

  it("dismisses on a press outside without dragging focus back to the trigger", () => {
    mount(header());
    fireEvent.click(trigger());

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).not.toBe(trigger());
  });

  it("toggles from its own trigger, and reopens", () => {
    mount(header());
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());

    fireEvent.click(trigger());
    expect(menu()).toBeTruthy();
  });

  it("renders no disclosure at all for a crumb with neither a link nor counterparts", () => {
    mount(
      <ObjectHeader
        crumbs={[{ type: "step", id: "build.2", label: "build", current: true }]}
        onOpenCounterpart={() => {}}
      />,
    );
    /* A step crumb on its own: its canonical URL needs the run above it in the trail, and
       a step has no counterparts — so there is nothing to disclose. */
    expect(screen.queryByRole("button", { name: /Links for/ })).toBeNull();
  });
});

describe("the menu's keys in the keyboard map", () => {
  const menuKeys = (h: Harness): string[] =>
    h.keyboard
      .list()
      .filter((shortcut) => shortcut.scope === "menu")
      .map((shortcut) => shortcut.key);

  it("registers them only while a menu is open, so the palette lists what is reachable", () => {
    const h = mount(header());
    expect(menuKeys(h)).toEqual([]);

    fireEvent.click(trigger());
    expect(menuKeys(h)).toEqual(["ArrowDown", "ArrowUp", "Home", "End", "Enter"]);
    // Every one is labelled for the palette, and says what it acts on.
    for (const shortcut of h.keyboard.list().filter((s) => s.scope === "menu")) {
      expect(shortcut.label, shortcut.key).toMatch(/menu/);
    }

    press("Escape");
    expect(menuKeys(h)).toEqual([]);
  });

  it("registers them once for two open menus, and holds them until the last one closes", () => {
    const h = mount(header());
    // `click` alone, with no `mousedown`, is the one way to get two menus open at once:
    // this is the registry's guard, since the map rejects a second bind on one key.
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Links for 7f3a2c" }));
    expect(screen.getAllByRole("menu")).toHaveLength(2);
    expect(menuKeys(h)).toHaveLength(5);

    press("Escape");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(menuKeys(h)).toHaveLength(5);
    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(menuKeys(h)).toEqual([]);
  });
});

describe("menu placement", () => {
  const near = { top: 100, left: 100, width: 20, height: 20 };
  const viewport = { width: 1440, height: 900 };

  it("stays below and start-aligned when there is room, and when nothing is measured", () => {
    expect(placeMenu({ trigger: near, menu: { width: 200, height: 200 }, viewport })).toEqual({
      block: "below",
      inline: "start",
    });
    // happy-dom's zeros, and the first frame of any menu: the default placement.
    const zero = { top: 0, left: 0, width: 0, height: 0 };
    expect(placeMenu({ trigger: zero, menu: { width: 0, height: 0 }, viewport: { width: 0, height: 0 } })).toEqual({
      block: "below",
      inline: "start",
    });
  });

  it("flips above a control near the bottom, and to the end edge for a crumb near the right", () => {
    const low = { top: 860, left: 100, width: 20, height: 20 };
    expect(placeMenu({ trigger: low, menu: { width: 200, height: 200 }, viewport }).block).toBe("above");

    const late = { top: 100, left: 1380, width: 20, height: 20 };
    expect(placeMenu({ trigger: late, menu: { width: 200, height: 200 }, viewport }).inline).toBe("end");
  });

  it("does not flip when the other side is no better", () => {
    // Taller than the window: clipped either way, so it stays on the roomier side.
    const low = { top: 860, left: 100, width: 20, height: 20 };
    expect(placeMenu({ trigger: low, menu: { width: 200, height: 2000 }, viewport }).block).toBe("above");
    const high = { top: 40, left: 100, width: 20, height: 20 };
    expect(placeMenu({ trigger: high, menu: { width: 200, height: 2000 }, viewport }).block).toBe("below");
    // Wider than the window from either edge: do not move for nothing.
    expect(placeMenu({ trigger: near, menu: { width: 4000, height: 100 }, viewport }).inline).toBe("start");
  });

  /** Rectangles a layout engine would have produced, handed to the component directly. */
  const measureAt = (top: number, left: number) =>
    vi.fn((): MenuMeasurement => ({
      trigger: { top, left, width: 20, height: 20 },
      menu: { width: 300, height: 300 },
      viewport,
    }));

  it("carries the decision into the classes the stylesheet flips on", () => {
    mount(
      <Menu label="Versions" items={versions} onChoose={() => {}} measure={measureAt(800, 1300)}>
        v3
      </Menu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    expect(screen.getByRole("menu").className).toBe("orca-menu orca-menu--above orca-menu--end");
  });

  it("measures again when the window resizes", () => {
    const measure = measureAt(100, 100);
    mount(
      <Menu label="Versions" items={versions} onChoose={() => {}} measure={measure}>
        v3
      </Menu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    expect(screen.getByRole("menu").className).toBe("orca-menu");

    const before = measure.mock.calls.length;
    fireEvent.resize(window);
    expect(measure.mock.calls.length).toBeGreaterThan(before);
  });
});

const versions: MenuItem[] = [
  { id: "v3", label: "Version 3", hint: "latest" },
  { id: "v2", label: "Version 2" },
  { id: "v1", label: "Version 1", disabled: true },
];

describe("a menu's items", () => {
  it("shows a disabled item, names it, and skips it with the arrow keys", () => {
    const chosen = vi.fn();
    mount(
      <Menu label="Versions" items={versions} onChoose={chosen}>
        v3
      </Menu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    const all = screen.getAllByRole("menuitem");
    expect(all).toHaveLength(3);
    expect(all[2]?.getAttribute("aria-disabled")).toBe("true");

    press("ArrowUp"); // from the first item, wrapping past the disabled last one
    expect(document.activeElement).toBe(all[1]);

    fireEvent.click(all[2]!);
    expect(chosen).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("draws the hint in the menu's meta style, and chooses on a click", () => {
    const chosen = vi.fn();
    mount(
      <Menu label="Versions" items={versions} onChoose={chosen}>
        v3
      </Menu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    expect(screen.getByRole("menu").querySelector(".orca-menu__type")?.textContent).toBe("latest");

    fireEvent.click(screen.getAllByRole("menuitem")[0]!);
    expect(chosen.mock.calls[0]?.[0]).toMatchObject({ id: "v3" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("the menu surface", () => {
  it("sits on the overlay surface in both themes", () => {
    const h = harness();
    teardown.push(h.dispose);
    const { Providers } = h;
    inBothThemes(
      <Providers>
        <Menu label="Versions" items={versions} onChoose={() => {}}>
          v3
        </Menu>
      </Providers>,
      ({ theme, container }) => {
        fireEvent.click(within(container).getByRole("button", { name: "Versions" }));
        const surface = container.querySelector(".orca-menu")!;
        expect(resolved(surface, "background-color"), theme).toBe(expectedToken(theme, "surface-overlay"));
      },
    );
  });
});
