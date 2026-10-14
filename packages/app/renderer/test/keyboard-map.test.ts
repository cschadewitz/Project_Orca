// @vitest-environment happy-dom
/**
 * The registry itself: the duplicate that has to fail loudly, the scope chain resolved
 * from focus, the text-entry rule that keeps `J` a letter while someone is typing, and the
 * control rule that leaves `Enter` on a focused button to the button.
 * The palette's end of it is in command-palette.test.tsx.
 */
import { describe, expect, it } from "vitest";
import {
  KeyboardMap,
  activatesItself,
  isTextEntry,
  keyOfEvent,
  normalizeKey,
  scopeProps,
  scopesFrom,
  shortcutLabel,
} from "../src/keyboard-map.js";

const noop = (): void => {};

/** A `keydown` the map can read, dispatched at `target` so scope resolution has somewhere to start. */
function press(
  target: EventTarget,
  init: { key: string; code?: string; metaKey?: boolean; shiftKey?: boolean },
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { ...init, code: init.code ?? "", bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("key notation", () => {
  it("normalises modifiers to one spelling", () => {
    expect(normalizeKey("mod+shift+l")).toBe("Mod+Shift+L");
    expect(normalizeKey("Shift+Mod+L")).toBe("Mod+Shift+L");
    expect(normalizeKey("Escape")).toBe("Escape");
  });

  it("rejects a key it cannot spell", () => {
    expect(() => normalizeKey("Cmd+K")).toThrow(/unknown modifier/);
    expect(() => normalizeKey("")).toThrow(/names no key/);
  });

  it("renders the key the way each platform writes it", () => {
    expect(shortcutLabel("Mod+Shift+L", "darwin")).toBe("⌘⇧L");
    expect(shortcutLabel("Mod+Shift+L", "win32")).toBe("Ctrl+Shift+L");
    expect(shortcutLabel("Mod+\\", "darwin")).toBe("⌘\\");
  });

  it("reads a letter from `code`, so the layout and Shift cannot change which key it is", () => {
    const event = new KeyboardEvent("keydown", { key: "Ł", code: "KeyL", metaKey: true, shiftKey: true });
    expect(keyOfEvent(event, "darwin")).toBe("Mod+Shift+L");
    expect(keyOfEvent(event, "win32")).toBe("Shift+L");
  });

  it("drops the Shift a punctuation key was typed with, and keeps the one that modifies a named key", () => {
    /* `+` is Shift and Equal on every layout that has it, so the press a keyboard produces
       carries `shiftKey: true` — and spelled `Shift++`, which matched the canvas's `+`
       registration not at all (#177). The shift is spelling the character here, not
       modifying it. */
    const plus = new KeyboardEvent("keydown", { key: "+", code: "Equal", shiftKey: true });
    expect(keyOfEvent(plus, "win32")).toBe("+");
    expect(normalizeKey("+")).toBe("+");

    // Same for the other punctuation a shifted row key produces.
    for (const [key, code] of [
      ["?", "Slash"],
      ["_", "Minus"],
      [":", "Semicolon"],
    ] as const) {
      expect(keyOfEvent(new KeyboardEvent("keydown", { key, code, shiftKey: true }), "win32")).toBe(key);
    }

    // A named key is not one character, so the shift there is a modifier and stays.
    const up = new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp", shiftKey: true });
    expect(keyOfEvent(up, "win32")).toBe("Shift+ArrowUp");
    const enter = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", shiftKey: true });
    expect(keyOfEvent(enter, "win32")).toBe("Shift+Enter");
    // And a digit still reads off `code`, so `Shift+0` is not the `)` it printed.
    const zero = new KeyboardEvent("keydown", { key: ")", code: "Digit0", shiftKey: true });
    expect(keyOfEvent(zero, "win32")).toBe("Shift+0");
  });

  it("has no key for a bare modifier", () => {
    expect(keyOfEvent(new KeyboardEvent("keydown", { key: "Meta", code: "MetaLeft" }), "darwin")).toBeUndefined();
  });
});

describe("registration", () => {
  it("fails loudly when one key is registered twice in one scope", () => {
    const map = new KeyboardMap("darwin");
    map.register({ scope: "list", key: "F", label: "Filter", action: noop });
    expect(() => map.register({ scope: "list", key: "f", label: "Find", action: noop })).toThrow(
      /F is already registered in scope list as "Filter"/,
    );
  });

  it("lets two scopes bind the same key", () => {
    const map = new KeyboardMap("darwin");
    map.register({ scope: "list", key: "F", label: "Filter the list", action: noop });
    expect(() => map.register({ scope: "run-tree", key: "F", label: "Filter the tree", action: noop })).not.toThrow();
    expect(map.list()).toHaveLength(2);
  });

  it("frees the key when the registration is undone", () => {
    const map = new KeyboardMap("darwin");
    const undo = map.register({ scope: "list", key: "F", label: "Filter", action: noop });
    undo();
    expect(map.list()).toEqual([]);
    expect(() => map.register({ scope: "list", key: "F", label: "Find", action: noop })).not.toThrow();
  });
});

describe("scope resolution", () => {
  it("reads the chain from the focused element outwards, ending in global", () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-kbd-scope", "panel");
    const tree = document.createElement("div");
    tree.setAttribute("data-kbd-scope", "run-tree");
    const row = document.createElement("button");
    panel.append(tree);
    tree.append(row);

    expect(scopesFrom(row)).toEqual(["run-tree", "panel", "global"]);
    expect(scopesFrom(null)).toEqual(["global"]);
  });

  it("ignores a scope attribute that names nothing", () => {
    const div = document.createElement("div");
    div.setAttribute("data-kbd-scope", "sidebar");
    expect(scopesFrom(div)).toEqual(["global"]);
  });

  it("writes the attribute through scopeProps", () => {
    expect(scopeProps("stream")).toEqual({ "data-kbd-scope": "stream" });
  });

  it("dispatches to the innermost scope that binds the key, then outwards", () => {
    const map = new KeyboardMap("darwin");
    const ran: string[] = [];
    map.register({ scope: "run-tree", key: "F", label: "tree", action: () => ran.push("tree") });
    map.register({ scope: "global", key: "F", label: "global", action: () => ran.push("global") });

    const tree = document.createElement("div");
    tree.setAttribute("data-kbd-scope", "run-tree");
    const row = document.createElement("button");
    tree.append(row);
    document.body.append(tree);
    const unlisten = map.listen(window);

    press(row, { key: "f", code: "KeyF" });
    expect(ran).toEqual(["tree"]);

    // The same key outside the tree falls through to global.
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    press(elsewhere, { key: "f", code: "KeyF" });
    expect(ran).toEqual(["tree", "global"]);

    unlisten();
    tree.remove();
    elsewhere.remove();
  });
});

describe("typing", () => {
  it("knows what a text entry is", () => {
    const input = document.createElement("input");
    expect(isTextEntry(input)).toBe(true);
    input.type = "checkbox";
    expect(isTextEntry(input)).toBe(false);
    expect(isTextEntry(document.createElement("textarea"))).toBe(true);
    expect(isTextEntry(document.createElement("button"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });

  it("leaves bare keys alone in a text entry but still dispatches modified ones and Escape", () => {
    const map = new KeyboardMap("darwin");
    const ran: string[] = [];
    map.register({ scope: "global", key: "J", label: "down", action: () => ran.push("J") });
    map.register({ scope: "global", key: "Mod+K", label: "palette", action: () => ran.push("Mod+K") });
    map.register({ scope: "global", key: "Escape", label: "close", action: () => ran.push("Escape") });

    const input = document.createElement("input");
    document.body.append(input);
    const unlisten = map.listen(window);

    press(input, { key: "j", code: "KeyJ" });
    press(input, { key: "k", code: "KeyK", metaKey: true });
    press(input, { key: "Escape" });
    expect(ran).toEqual(["Mod+K", "Escape"]);

    unlisten();
    input.remove();
  });

  it("does not preventDefault a key it did not handle", () => {
    const map = new KeyboardMap("darwin");
    const unlisten = map.listen(window);
    const event = press(document.body, { key: "q", code: "KeyQ" });
    expect(event.defaultPrevented).toBe(false);
    unlisten();
  });
});

describe("a control that presses itself", () => {
  it("leaves Enter and Space on a control to the control, and does not preventDefault them", () => {
    /* A card is a `card` scope with buttons in it, and binds `Enter` to "answer with the
       selected option". On a focused button that press is the button's: dispatching it
       would cancel the button's own activation and answer with something else. */
    const map = new KeyboardMap("darwin");
    const ran: string[] = [];
    for (const key of ["Enter", "Shift+Enter", "1", "Escape"]) {
      map.register({ scope: "card", key, label: key, action: () => ran.push(key) });
    }
    // `Space` cannot be registered at all — the notation trims it to no key — so nothing in
    // the map can take it from a control; it is asserted below only as never prevented.
    expect(() => map.register({ scope: "card", key: " ", label: "space", action: () => ran.push(" ") })).toThrow(
      /names no key/,
    );
    const card = document.createElement("section");
    card.setAttribute("data-kbd-scope", "card");
    card.tabIndex = 0;
    const button = document.createElement("button");
    const link = document.createElement("a");
    link.href = "#run";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const summary = document.createElement("summary");
    card.append(button, link, checkbox, summary);
    document.body.append(card);
    const unlisten = map.listen(window);

    for (const control of [button, link, checkbox, summary]) {
      expect(press(control, { key: "Enter", code: "Enter" }).defaultPrevented).toBe(false);
      expect(press(control, { key: "Enter", code: "Enter", shiftKey: true }).defaultPrevented).toBe(false);
      expect(press(control, { key: " ", code: "Space" }).defaultPrevented).toBe(false);
    }
    expect(ran).toEqual([]);

    // The scope's other keys still reach it from a control: a digit on an option chooses.
    expect(press(button, { key: "1", code: "Digit1" }).defaultPrevented).toBe(true);
    press(button, { key: "Escape" });
    // And on the element that owns the scope, `Enter` is the scope's.
    expect(press(card, { key: "Enter", code: "Enter" }).defaultPrevented).toBe(true);
    expect(ran).toEqual(["1", "Escape", "Enter"]);

    unlisten();
    card.remove();
  });

  it("still gives Enter to a list's single tab stop and to a menu item, whose keys are their scope's", () => {
    const map = new KeyboardMap("darwin");
    const ran: string[] = [];
    map.register({ scope: "list", key: "Enter", label: "open", action: () => ran.push("list") });
    map.register({ scope: "list", key: "J", label: "next", action: () => ran.push("J") });
    map.register({ scope: "menu", key: "Enter", label: "choose", action: () => ran.push("menu") });

    // `VirtualList`: one tab stop, rows named by `aria-activedescendant`, so the target is the list.
    const list = document.createElement("div");
    list.setAttribute("data-kbd-scope", "list");
    list.setAttribute("role", "listbox");
    list.tabIndex = 0;
    // `Menu`: a `<button role="menuitem">` in a `menu` scope, which clicks it on `Enter`.
    const menu = document.createElement("ul");
    menu.setAttribute("data-kbd-scope", "menu");
    const item = document.createElement("button");
    item.setAttribute("role", "menuitem");
    menu.append(item);
    document.body.append(list, menu);
    const unlisten = map.listen(window);

    press(list, { key: "j", code: "KeyJ" });
    expect(press(list, { key: "Enter", code: "Enter" }).defaultPrevented).toBe(true);
    expect(press(item, { key: "Enter", code: "Enter" }).defaultPrevented).toBe(true);
    expect(ran).toEqual(["J", "list", "menu"]);

    unlisten();
    list.remove();
    menu.remove();
  });

  it("knows which elements press themselves", () => {
    const element = (tag: string, attributes: Record<string, string> = {}): Element => {
      const node = document.createElement(tag);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
      return node;
    };
    expect(activatesItself(element("button"))).toBe(true);
    expect(activatesItself(element("a", { href: "#x" }))).toBe(true);
    expect(activatesItself(element("summary"))).toBe(true);
    expect(activatesItself(element("input", { type: "checkbox" }))).toBe(true);
    expect(activatesItself(element("input", { type: "submit" }))).toBe(true);
    // A link with nowhere to go is not a control, and a text field types rather than presses.
    expect(activatesItself(element("a"))).toBe(false);
    expect(activatesItself(element("input"))).toBe(false);
    expect(activatesItself(element("div", { role: "listbox", tabindex: "0" }))).toBe(false);
    expect(activatesItself(element("button", { role: "menuitem" }))).toBe(false);
    expect(activatesItself(null)).toBe(false);
  });
});
