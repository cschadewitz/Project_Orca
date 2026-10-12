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
 *  - **A destructive item is never focused on open, and never listed first.** Focus lands
 *    on the first item that is neither disabled nor `danger`, because the item focus lands
 *    on is the one a second `Enter` chooses — a person who opened a menu and pressed `Enter`
 *    out of habit must not have destroyed something. That half is the primitive's. The other
 *    half is the caller's, and is the rule a gate's options and the palette's rows keep too
 *    (docs/design/20-attention-and-gates.md, 60-implementation.md): **a destructive item is
 *    never first.** The menu does not re-sort what it is given, because the order of a list
 *    is the caller's to mean something by, so a caller with a destructive choice puts the
 *    safe one above it. A destructive item draws in the danger tone and leads with `✕`,
 *    since colour is never the only channel (RULES.md rule 4).
 *  - **A sentence is a `note`, never a `hint`.** `hint` is drawn in the eyebrow style —
 *    uppercase, unwrapped, at the trailing edge — which is right for a type or a date and
 *    wrong for anything a person has to read: a consequence set there was an uppercase line
 *    that blew the menu out past the window (the Agents surface's release confirmation).
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
import { CHROME_GLYPHS } from "@orca/design";
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
  /**
   * A one-word meta at the item's trailing edge — the type a counterpart leads to, a date.
   * It is set in the eyebrow style, so uppercase and unwrapped: never a sentence (put that
   * in the menu's `note`) and never an id, which uppercase would re-capitalise.
   */
  hint?: string;
  /** Listed, named and skipped by the arrow keys; a menu never hides what it cannot do. */
  disabled?: boolean;
  /**
   * A destructive choice: drawn in the danger tone and led by `✕`, and never the item focus
   * lands on when the menu opens. The caller still lists it below the safe choices — see
   * the file header.
   */
  danger?: boolean;
}

/**
 * How the menu learns where it is. The default measures the document; a test injects
 * rectangles, because happy-dom has no layout engine and measures everything as zero.
 */
export type MenuMeasurer = (trigger: Element, menu: Element) => MenuMeasurement;

/**
 * What may be put on the trigger from outside: the wiring a form field owns, and nothing
 * that would change what the menu is. `ConfigFieldControl` is exactly this shape.
 */
export interface MenuTriggerProps {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

export interface MenuProps {
  /** The accessible name of both the trigger and the list it opens. */
  label: string;
  items: readonly MenuItem[];
  onChoose: (item: MenuItem) => void;
  /** The trigger's content — a glyph, a word, whatever the surface draws. */
  children: ReactNode;
  /** The trigger's class, so a surface keeps its own disclosure styling. */
  triggerClassName?: string;
  /**
   * Ids a field wants on the control it wraps — `ConfigField`'s `control`, spread onto the
   * trigger button.
   *
   * A `Menu` *is* the control when it renders an enum field, so the field's `htmlFor`, its
   * `aria-describedby` and its `aria-invalid` have to land on the button. Without this they
   * dangled: the label pointed at an id nothing carried, and the help and the error under
   * the field were written for a screen reader that never reached them. The trigger keeps
   * its own `aria-label` — an `id` names nothing.
   */
  triggerProps?: MenuTriggerProps;
  measure?: MenuMeasurer;
  /**
   * Controlled disclosure, for the one case a surface cannot press the trigger itself:
   * `orca://item/<slug>` lands on Plan **with the explanation open** (#165, #170), and a
   * link that arrives is not a click.
   *
   * Pass both or neither. Everything else stays the primitive's — focus in on open and
   * back to the trigger on close, `Esc` through the layer stack, the roving keys, the
   * placement — so a controlled menu is the same menu with its open state held one level
   * up, not a second implementation. Omitted, the menu owns its own state, which is what
   * every other caller wants.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Something the popover has to *say* rather than offer: an error where a list of choices
   * was expected, or a sentence about the choices that an item's `hint` cannot carry (why
   * one of them is unavailable). It is rendered above the items, is not a `menuitem`,
   * is never focused, never typed to and never chosen — so it cannot be mistaken for, or
   * copied as, one of them.
   *
   * It is here rather than as a disabled item because a disabled item is still an item: it
   * is counted, named and read as one of the choices, and a menu whose only row is a
   * disabled error is a popover focus cannot enter. A note keeps the menu openable with no
   * items at all, and focus goes to the list itself so `Esc` still returns to the trigger.
   */
  note?: ReactNode;
}

/** The marker `menu`-scope shortcuts use to find the open menu around the focused item. */
const MENU_ATTRIBUTE = "data-orca-menu";
/** The item's label, for typeahead: its text node also carries the hint. */
const LABEL_ATTRIBUTE = "data-orca-menu-label";
/** On a destructive item, so the open menu can step past it when it chooses where to land. */
const DANGER_ATTRIBUTE = "data-orca-menu-danger";

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

/**
 * Where focus is, expressed as a menu: `undefined` when it is not in one at all. `at` is
 * `-1` when focus is on the list itself rather than an item — a menu that opened with no
 * item it was willing to land on (only a note, or only destructive choices).
 */
function focusedMenu(): { items: HTMLElement[]; at: number } | undefined {
  const active = document.activeElement;
  const menu = active?.closest(`[${MENU_ATTRIBUTE}]`);
  if (!menu) return undefined;
  const items = itemsOf(menu);
  if (active === menu) return { items, at: -1 };
  const at = items.indexOf(active as HTMLElement);
  return at === -1 ? undefined : { items, at };
}

/** Move focus by `delta` items, wrapping, or to an absolute index when `to` is given. */
function moveFocus(delta: number, to?: (count: number) => number): void {
  const found = focusedMenu();
  if (!found) return;
  const { items, at } = found;
  if (items.length === 0) return;
  // From the list itself, ↓ enters at the top and ↑ at the bottom, as from outside a list.
  const from = at === -1 ? (delta > 0 ? -1 : 0) : at;
  const next = to ? to(items.length) : (from + delta + items.length) % items.length;
  items[next]?.focus();
}

/**
 * The item focus lands on when the menu opens: the first that is neither disabled (the
 * arrow keys skip those, so `itemsOf` already has) nor destructive. `undefined` when there
 * is none, and the list itself takes focus instead.
 */
function landingItem(menu: Element): HTMLElement | undefined {
  return itemsOf(menu).find((item) => !item.hasAttribute(DANGER_ATTRIBUTE));
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
  triggerProps,
  measure = measureInDocument,
  open: controlled,
  onOpenChange,
  note,
}: MenuProps): JSX.Element | null {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  /* One setter, whichever half owns the state: an uncontrolled menu writes its own, a
     controlled one reports and lets its owner write. Both tell the owner, so a surface
     that opened a menu hears it close. */
  const report = useRef(onOpenChange);
  report.current = onOpenChange;
  const setOpen = useCallback(
    (next: boolean) => {
      if (controlled === undefined) setUncontrolled(next);
      report.current?.(next);
    },
    [controlled],
  );
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
  }, [setOpen]);

  useTransientLayer(open, { name: "menu", close });
  useMenuKeys(open);

  /* Focus moves into the menu on open: the first safe item, so ↓ and Enter work
     immediately and Enter cannot destroy anything (`landingItem`). A menu that is only a
     note — or only destructive choices — has no item to land on, so focus goes to the list
     itself, which is what keeps the layer something focus is *inside*, so `Esc` returns it
     to the trigger rather than stranding it; ↓ from there enters the items. */
  useEffect(() => {
    if (!open) return;
    const menu = list.current;
    if (!menu) return;
    const landing = landingItem(menu);
    if (landing) landing.focus();
    else menu.focus();
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
  }, [open, setOpen]);

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
  // A note is something to say, so a menu that has one is not empty.
  if (items.length === 0 && note === undefined) return null;

  return (
    <span className="orca-menu-anchor" ref={anchor}>
      <button
        {...triggerProps}
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
          /* Focusable only as a fallback: with items, focus lives on them and the list is
             never the active element. */
          tabIndex={-1}
          {...{ [MENU_ATTRIBUTE]: "" }}
          {...scopeProps("menu")}
        >
          {note === undefined ? null : (
            <li className={`orca-menu__note ${textClass("caption")}`} role="none">
              {note}
            </li>
          )}
          {items.map((item) => (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                className={`orca-menu__item${item.danger ? " orca-menu__item--danger" : ""} ${textClass("label")}`}
                /* Roving focus: the menu is one tab stop, and focus inside it moves with
                   the arrow keys. Tab leaves the menu rather than walking it. */
                tabIndex={-1}
                {...(item.disabled ? { "aria-disabled": true } : {})}
                {...(item.danger ? { [DANGER_ATTRIBUTE]: "" } : {})}
                {...{ [LABEL_ATTRIBUTE]: item.label }}
                onClick={() => {
                  if (item.disabled) return;
                  // Close first: it restores focus to the trigger, and what the choice
                  // does next may well move focus somewhere else on purpose.
                  close();
                  onChoose(item);
                }}
              >
                {/* The glyph as well as the colour (rule 4). Hidden from the accessible name,
                    which the label already makes, so typeahead and a screen reader both
                    meet the word first — the palette's danger row does the same. */}
                {item.danger ? (
                  <span className="orca-menu__glyph" aria-hidden="true">
                    {CHROME_GLYPHS.danger}
                  </span>
                ) : null}
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
