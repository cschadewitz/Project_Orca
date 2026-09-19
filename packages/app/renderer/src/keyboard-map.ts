/// <reference lib="dom" />
/**
 * The keyboard map: every shortcut in the app registers here as `{ scope, key, label,
 * action }`, so the command palette (#149) can list each one with its key beside it and
 * nothing is reachable by keyboard alone. Keys are written platform-neutrally as
 * `Mod+Shift+L`; `Mod` is ⌘ on macOS and Ctrl elsewhere. Today only the global scope is
 * dispatched — resolving the scope from focus is the palette's job when it lands.
 */

/** The scopes in docs/design/50-accessibility-and-keyboard.md's table. */
export type ShortcutScope = "global" | "list" | "run-tree" | "stream" | "card" | "panel";

export interface Shortcut {
  scope: ShortcutScope;
  /** `Mod`, `Shift`, `Alt` in that order, then one key: a letter, digit or `KeyboardEvent.key` name. */
  key: string;
  label: string;
  action: () => void;
}

const MODIFIERS = ["Mod", "Shift", "Alt"] as const;

/** `mod+shift+l` → `Mod+Shift+L`; the same shortcut always produces the same string. */
export function normalizeKey(key: string): string {
  const parts = key.split("+").map((p) => p.trim());
  const main = parts.pop();
  if (!main) throw new Error(`shortcut ${JSON.stringify(key)} names no key`);
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  for (const m of mods) {
    if (!MODIFIERS.some((known) => known.toLowerCase() === m)) throw new Error(`unknown modifier ${m} in ${key}`);
  }
  const ordered = MODIFIERS.filter((m) => mods.has(m.toLowerCase()));
  return [...ordered, main.length === 1 ? main.toUpperCase() : main].join("+");
}

/** The key a `keydown` event spells in the map's notation, or `undefined` for a bare modifier. */
export function keyOfEvent(event: KeyboardEvent, platform: string): string | undefined {
  const mod = platform === "darwin" ? event.metaKey : event.ctrlKey;
  // `code` for letters and digits so ⌘⇧L is ⌘⇧L on every layout and whatever Shift did to the
  // character; `key` for everything else (Escape, Enter, ArrowDown, `/`, `[`).
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1] ?? /^Digit([0-9])$/.exec(event.code)?.[1];
  const main = letter ?? event.key;
  if (["Meta", "Control", "Shift", "Alt"].includes(main)) return undefined;
  return [mod ? "Mod" : "", event.shiftKey ? "Shift" : "", event.altKey ? "Alt" : "", main].filter(Boolean).join("+");
}

/** How the palette shows a key: `⌘⇧L` on macOS, `Ctrl+Shift+L` elsewhere. */
export function shortcutLabel(key: string, platform: string): string {
  const parts = normalizeKey(key).split("+");
  if (platform !== "darwin") return parts.map((p) => (p === "Mod" ? "Ctrl" : p)).join("+");
  const glyph: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥" };
  return parts.map((p) => glyph[p] ?? p).join("");
}

export class KeyboardMap {
  private readonly shortcuts = new Map<string, Shortcut>();

  constructor(readonly platform: string) {}

  /** Register one shortcut; returns its unregister. Two shortcuts on one key in one scope is a bug, so it throws. */
  register(shortcut: Shortcut): () => void {
    const key = normalizeKey(shortcut.key);
    const slot = `${shortcut.scope}:${key}`;
    const taken = this.shortcuts.get(slot);
    if (taken) throw new Error(`${key} is already registered in scope ${shortcut.scope} as "${taken.label}"`);
    this.shortcuts.set(slot, { ...shortcut, key });
    return () => {
      this.shortcuts.delete(slot);
    };
  }

  list(): readonly Shortcut[] {
    return [...this.shortcuts.values()];
  }

  /** Run the shortcut the event spells in the first of `scopes` that has one. Returns whether one ran. */
  handle(event: KeyboardEvent, scopes: readonly ShortcutScope[] = ["global"]): boolean {
    const key = keyOfEvent(event, this.platform);
    if (!key) return false;
    for (const scope of scopes) {
      const shortcut = this.shortcuts.get(`${scope}:${key}`);
      if (shortcut) {
        event.preventDefault();
        shortcut.action();
        return true;
      }
    }
    return false;
  }

  /** Listen for `keydown` on `target`, dispatching in the global scope. Returns the remover. */
  listen(target: EventTarget): () => void {
    // Duck-typed rather than `instanceof KeyboardEvent`, so a window that is not the global
    // one (a test's) dispatches through here too.
    const onKeydown = (event: Event) => {
      if ("key" in event && "code" in event) this.handle(event as KeyboardEvent);
    };
    target.addEventListener("keydown", onKeydown);
    return () => target.removeEventListener("keydown", onKeydown);
  }
}
