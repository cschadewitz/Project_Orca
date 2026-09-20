/**
 * `Menu` — the app's popover primitive: a trigger button, a short list of items hung off
 * it, and the keyboard contract docs/design/50-accessibility-and-keyboard.md asks of every
 * transient layer. The crumb's counterparts were the first one (#147); the schedule
 * badge's explanation, the artifact version menu and the risk cell's detail are next, and
 * none of them should re-derive any of this.
 *
 * What it owns, and why each piece is where it is:
 *
 *  - **`Esc` is not handled here.** The menu puts itself on the transient layer stack while
 *    it is open and the one global `Esc` closes whatever is topmost, so a menu inside an
 *    overlaid panel closes the menu and nothing else.
 *  - **Roving focus is in the keyboard map, not in a `keydown` listener.** `↑`/`↓`,
 *    `Home`/`End` and `Enter` register in the `menu` scope, which the open list marks with
 *    `scopeProps("menu")` — so the palette lists them, and so they cannot collide with the
 *    `↑`/`↓` a list below binds (scope resolution is innermost first). They are registered
 *    once per keyboard map however many menus are open, and act on the menu that holds
 *    focus: a scope is a place, not a component, and two registrations on one key in one
 *    scope is an error by design.
 *  - **Typeahead is the exception** and stays a local handler. A letter pressed in a menu
 *    is typing into the widget rather than a command: it depends on what the items are
 *    called, it cannot be labelled without naming them, and registering A–Z would bury the
 *    palette's real commands under 26 rows nobody asked for.
 *  - **Focus moves in on open and back to the trigger on close**, including an `Esc` close.
 *    The one case it deliberately does not is a click outside — focus is already going
 *    where the person clicked.
 *  - **Placement flips rather than clips**, decided by `placeMenu` over measurements this
 *    component takes through an injectable measurer (see `menu-placement.ts` for why).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useOptionalKeyboard } from "../keyboard-context.js";
import { useTransientLayer } from "../layers-context.js";
import { scopeProps, type KeyboardMap, type Shortcut } from "../keyboard-map.js";
import {
  DEFAULT_PLACEMENT,
  placeMenu,
  placementClass,
  type MenuMeasurement,
  type MenuPlacement,
  type Rect,
} from "./menu-placement.js";
import { textClass } from "./text.js";

export interface MenuItem {
  id: string;
  label: string;
  /** A trailing note in the menu's meta style — the type a counterpart leads to, a date. */
  hint?: string;
  /** Listed, named and skipped by the arrow keys; a menu never hides what it cannot do. */
  disabled?: boolean;
}

/**
 * How the menu learns where it is. The default measures the document; a test injects
 * rectangles, because happy-dom has no layout engine and measures everything as zero.
 */
export type MenuMeasurer = (trigger: Element, menu: Element) => MenuMeasurement;

export interface MenuProps {
  /** The accessible name of both the trigger and the list it opens. */
  label: string;
  items: readonly MenuItem[];
  onChoose: (item: MenuItem) => void;
  /** The trigger's content — a glyph, a word, whatever the surface draws. */
  children: ReactNode;
  /** The trigger's class, so a surface keeps its own disclosure styling. */
  triggerClassName?: string;
  measure?: MenuMeasurer;
}

/** The marker `menu`-scope shortcuts use to find the open menu around the focused item. */
const MENU_ATTRIBUTE = "data-orca-menu";
/** The item's label, for typeahead: its text node also carries the hint. */
const LABEL_ATTRIBUTE = "data-orca-menu-label";

const rectOf = (element: Element): Rect => {
  const { top, left, width, height } = element.getBoundingClientRect();
  return { top, left, width, height };
};

const measureInDocument: MenuMeasurer = (trigger, menu) => ({
  trigger: rectOf(trigger),
  menu: rectOf(menu),
  viewport: { width: window.innerWidth, height: window.innerHeight },
});

/** The items of `menu` that the arrow keys visit — disabled ones are shown but skipped. */
function itemsOf(menu: Element): HTMLElement[] {
  const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  return items.filter((item) => item.getAttribute("aria-disabled") !== "true");
}

/** Where focus is, expressed as a menu: `undefined` when it is not in one at all. */
function focusedMenu(): { items: HTMLElement[]; at: number } | undefined {
  const active = document.activeElement;
  const menu = active?.closest(`[${MENU_ATTRIBUTE}]`);
  if (!menu) return undefined;
  const items = itemsOf(menu);
  const at = items.indexOf(active as HTMLElement);
  return at === -1 ? undefined : { items, at };
}

/** Move focus by `delta` items, wrapping, or to an absolute index when `to` is given. */
function moveFocus(delta: number, to?: (count: number) => number): void {
  const found = focusedMenu();
  if (!found) return;
  const { items, at } = found;
  if (items.length === 0) return;
  const next = to ? to(items.length) : (at + delta + items.length) % items.length;
  items[next]?.focus();
}

/**
 * The `menu` scope's shortcuts. `Enter` clicks the focused item rather than letting the
 * browser activate the button, because the map calls `preventDefault` before running an
 * action — one path for the key, whichever way it was pressed.
 */
const MENU_SHORTCUTS: readonly Shortcut[] = [
  {
    scope: "menu",
    key: "ArrowDown",
    label: "Next item in the open menu",
    section: "navigation",
    action: () => moveFocus(1),
  },
  {
    scope: "menu",
    key: "ArrowUp",
    label: "Previous item in the open menu",
    section: "navigation",
    action: () => moveFocus(-1),
  },
  {
    scope: "menu",
    key: "Home",
    label: "First item in the open menu",
    section: "navigation",
    action: () => moveFocus(0, () => 0),
  },
  {
    scope: "menu",
    key: "End",
    label: "Last item in the open menu",
    section: "navigation",
    action: () => moveFocus(0, (count) => count - 1),
  },
  {
    scope: "menu",
    key: "Enter",
    label: "Choose the focused menu item",
    action: () => {
      const found = focusedMenu();
      found?.items[found.at]?.click();
    },
  },
];

/**
 * One registration per keyboard map, refcounted across every open menu: the map rejects a
 * second shortcut on the same key in the same scope, and two menus open at once (a menu in
 * a panel, a menu in the header above it) must not be an error.
 */
const registrations = new WeakMap<KeyboardMap, { count: number; dispose: () => void }>();

function acquireMenuKeys(keyboard: KeyboardMap): () => void {
  const existing = registrations.get(keyboard);
  if (existing) existing.count += 1;
  else {
    const disposers = MENU_SHORTCUTS.map((shortcut) => keyboard.register(shortcut));
    registrations.set(keyboard, { count: 1, dispose: () => disposers.forEach((off) => off()) });
  }
  let released = false;
  return () => {
    const held = registrations.get(keyboard);
    if (released || !held) return;
    released = true;
    held.count -= 1;
    if (held.count === 0) {
      registrations.delete(keyboard);
      held.dispose();
    }
  };
}

/**
 * Hold the `menu` scope's shortcuts for as long as this menu is open. Registered on open
 * rather than on mount so that what is in the map is what the person can reach right now —
 * the palette shows the whole map, and a menu key with no menu open means nothing.
 */
function useMenuKeys(open: boolean): void {
  const keyboard = useOptionalKeyboard();
  useEffect(() => {
    if (!open) return;
    // A closed menu in a provider-less tree is fine — the static preview gallery renders
    // one — but an open menu with no map is a menu nobody can drive.
    if (!keyboard) throw new Error("an open Menu needs a <KeyboardProvider> above it");
    return acquireMenuKeys(keyboard);
  }, [keyboard, open]);
}

export function Menu({
  label,
  items,
  onChoose,
  children,
  triggerClassName,
  measure = measureInDocument,
}: MenuProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<MenuPlacement>(DEFAULT_PLACEMENT);
  const anchor = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);

  /* Closing returns focus to the trigger — the rule for every transient layer, and the
     reason `Esc` out of a menu does not strand focus on the body. */
  const close = useCallback(() => {
    setOpen(false);
    const element = trigger.current;
    if (element?.isConnected) element.focus();
  }, []);

  useTransientLayer(open, { name: "menu", close });
  useMenuKeys(open);

  // Focus moves into the menu on open: the first item, so ↓ and Enter work immediately.
  useEffect(() => {
    if (!open) return;
    const menu = list.current;
    if (menu) itemsOf(menu)[0]?.focus();
  }, [open]);

  /* Measured after layout and again on resize, so a menu opened near an edge flips on the
     frame it appears rather than after a repaint the person can see. */
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(DEFAULT_PLACEMENT);
      return;
    }
    const update = (): void => {
      const [button, menu] = [trigger.current, list.current];
      if (button && menu) setPlacement(placeMenu(measure(button, menu)));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open, measure]);

  /* A press outside dismisses. `setOpen` rather than `close`: focus is already on its way
     to whatever was clicked, and pulling it back to the trigger would fight the person. */
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  // Typeahead: the next item whose label starts with the letter, wrapping, from the one
  // after the focused item — so pressing the same letter twice cycles the matches.
  const onTypeahead = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key.length !== 1 || event.key === " " || event.metaKey || event.ctrlKey || event.altKey) return;
    const found = focusedMenu();
    if (!found) return;
    const letter = event.key.toLowerCase();
    const order = [...found.items.slice(found.at + 1), ...found.items.slice(0, found.at + 1)];
    const hit = order.find((item) => (item.getAttribute(LABEL_ATTRIBUTE) ?? "").toLowerCase().startsWith(letter));
    if (!hit) return;
    event.preventDefault();
    hit.focus();
  };

  // A trigger for an empty menu is a control that does nothing; the surface draws neither.
  if (items.length === 0) return null;

  return (
    <span className="orca-menu-anchor" ref={anchor}>
      <button
        type="button"
        ref={trigger}
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {children}
      </button>
      {open && (
        <ul
          className={placementClass(placement)}
          role="menu"
          aria-label={label}
          ref={list}
          onKeyDown={onTypeahead}
          {...{ [MENU_ATTRIBUTE]: "" }}
          {...scopeProps("menu")}
        >
          {items.map((item) => (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                className={`orca-menu__item ${textClass("label")}`}
                /* Roving focus: the menu is one tab stop, and focus inside it moves with
                   the arrow keys. Tab leaves the menu rather than walking it. */
                tabIndex={-1}
                {...(item.disabled ? { "aria-disabled": true } : {})}
                {...{ [LABEL_ATTRIBUTE]: item.label }}
                onClick={() => {
                  if (item.disabled) return;
                  // Close first: it restores focus to the trigger, and what the choice
                  // does next may well move focus somewhere else on purpose.
                  close();
                  onChoose(item);
                }}
              >
                <span>{item.label}</span>
                {item.hint === undefined ? null : (
                  <span className={`orca-menu__type ${textClass("eyebrow")}`}>{item.hint}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
