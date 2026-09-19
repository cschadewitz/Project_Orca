// @vitest-environment happy-dom
/**
 * The registry itself: the duplicate that has to fail loudly, the scope chain resolved
 * from focus, and the text-entry rule that keeps `J` a letter while someone is typing.
 * The palette's end of it is in command-palette.test.tsx.
 */
import { describe, expect, it } from "vitest";
import {
  KeyboardMap,
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
