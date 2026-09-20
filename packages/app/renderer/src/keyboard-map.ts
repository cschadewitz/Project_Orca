/// <reference lib="dom" />
/**
 * The keyboard map: every shortcut in the app registers here as `{ scope, key, label,
 * action }`, so the command palette can list each one with its key beside it and nothing
 * is reachable by keyboard alone (docs/design/50-accessibility-and-keyboard.md). Keys are
 * written platform-neutrally as `Mod+Shift+L`; `Mod` is ⌘ on macOS and Ctrl elsewhere.
 *
 * The scope of a keypress is resolved from focus, not from a mode flag: a component that
 * owns a scope marks its subtree with `data-kbd-scope="run-tree"` (`scopeProps` writes the
 * attribute), and a keypress is offered to each scope from the focused element outwards
 * before `global`. That is why two components can both bind `F` — one in `run-tree`, one
 * in `list` — and why binding it twice in one scope throws instead.
 */

/**
 * The scopes in docs/design/50-accessibility-and-keyboard.md's table, plus `menu`: an open
 * popover is a place focus can be, and its roving keys have to out-rank the `↑`/`↓` of the
 * list underneath it. Scope resolution is innermost first, so marking the open list with
 * `scopeProps("menu")` is all that takes.
 */
export type ShortcutScope = "global" | "list" | "run-tree" | "stream" | "card" | "panel" | "menu";

export const SHORTCUT_SCOPES: readonly ShortcutScope[] = [
  "global",
  "list",
  "run-tree",
  "stream",
  "card",
  "panel",
  "menu",
];

/** Which of the palette's three sections a shortcut belongs in. Search is not a command. */
export type ShortcutSection = "actions" | "navigation";

export interface Shortcut {
  scope: ShortcutScope;
  /**
   * `Mod`, `Shift`, `Alt` in that order, then one key: a letter, digit or
   * `KeyboardEvent.key` name.
   *
   * **Optional (#205).** A command with no key is still a command: it registers here, so
   * the palette lists it — with no chip beside it — and the palette is then the only way
   * to it. The design's keyboard table is deliberately short, and a command worth doing
   * but not worth one of the letters left should be discoverable rather than absent.
   */
  key?: string;
  label: string;
  action: () => void;
  /** Where the palette files it. Defaults to `actions` — most shortcuts act on the current object. */
  section?: ShortcutSection;
  /** A second line for the palette: what the action is for, when the label cannot say it. */
  detail?: string;
}

/**
 * A shortcut as the map holds it: the same thing with the slot it occupies, which is the
 * one name a keyless command has. The palette keys its rows off it, because `scope:key` —
 * which used to be that name — is not a name two keyless commands could differ by.
 */
export interface RegisteredShortcut extends Shortcut {
  readonly id: string;
}

/**
 * An event target as an element, duck-typed rather than `instanceof Element`: the target
 * may belong to a window that is not the global one — a second window in a test, a future
 * detached preview — and `instanceof` against the global constructor would say no.
 */
function asElement(target: EventTarget | null): Element | null {
  const candidate = target as Element | null;
  return candidate && typeof candidate.getAttribute === "function" ? candidate : null;
}

/** The attribute a component puts on its root to own a scope for everything focused inside it. */
export const SCOPE_ATTRIBUTE = "data-kbd-scope";

/** Spread onto the element that owns `scope`: `<div {...scopeProps("run-tree")}>`. */
export function scopeProps(scope: ShortcutScope): { [SCOPE_ATTRIBUTE]: ShortcutScope } {
  return { [SCOPE_ATTRIBUTE]: scope };
}

const isScope = (value: string | null): value is ShortcutScope =>
  value !== null && (SHORTCUT_SCOPES as readonly string[]).includes(value);

/**
 * The scopes a keypress on `element` should be offered, innermost first, always ending in
 * `global`. An unrecognised `data-kbd-scope` value is ignored rather than thrown on: this
 * runs inside a keydown, and a typo there should not take the keyboard down with it.
 */
export function scopesFrom(element: Element | null): readonly ShortcutScope[] {
  const scopes: ShortcutScope[] = [];
  for (let node = element; node; node = node.parentElement) {
    const scope = node.getAttribute(SCOPE_ATTRIBUTE);
    if (isScope(scope) && !scopes.includes(scope)) scopes.push(scope);
  }
  if (!scopes.includes("global")) scopes.push("global");
  return scopes;
}

/**
 * Whether `element` is somewhere a person types. In a text entry only modified shortcuts
 * and `Escape` dispatch, so `J` in the palette's query field types a J rather than moving
 * a selection three layers below it.
 */
export function isTextEntry(element: Element | null): boolean {
  if (!element) return false;
  // `isContentEditable` is inherited, so a span inside an editable region answers true too.
  if ((element as HTMLElement).isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (element.getAttribute("type") ?? "text").toLowerCase();
  return !["button", "checkbox", "radio", "range", "reset", "submit", "color", "file"].includes(type);
}

/** `Escape` is the one bare key a text entry still lets through — it closes the layer, it does not type. */
const dispatchesInTextEntry = (key: string): boolean =>
  key.includes("Mod+") || key.includes("Alt+") || key === "Escape";

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
  private readonly shortcuts = new Map<string, RegisteredShortcut>();
  /** Only ever counts up, so a keyless command that unregisters cannot hand its slot on. */
  private keyless = 0;

  constructor(readonly platform: string) {}

  /**
   * Register one shortcut; returns its unregister. Two shortcuts on one key in one scope is
   * a bug, so it throws — that throw is how a collision is found, and it stays.
   *
   * A shortcut with no key (#205) cannot collide with anything, so it gets a slot of its
   * own instead: `scope:!keyless-n`, which no normalised key can spell, so `handle()`
   * looks a keypress up and never finds one. Two keyless commands in one scope are two
   * commands and not a bug.
   */
  register(shortcut: Shortcut): () => void {
    const key = shortcut.key === undefined ? undefined : normalizeKey(shortcut.key);
    const slot = key === undefined ? `${shortcut.scope}:!keyless-${this.keyless++}` : `${shortcut.scope}:${key}`;
    const taken = this.shortcuts.get(slot);
    if (taken) throw new Error(`${key} is already registered in scope ${shortcut.scope} as "${taken.label}"`);
    // The given `key` is dropped and the normalised one put back, so a keyless entry has no
    // `key` property at all rather than an `undefined` one — `exactOptionalPropertyTypes`.
    const { key: _given, ...rest } = shortcut;
    this.shortcuts.set(slot, key === undefined ? { ...rest, id: slot } : { ...rest, key, id: slot });
    return () => {
      this.shortcuts.delete(slot);
    };
  }

  list(): readonly RegisteredShortcut[] {
    return [...this.shortcuts.values()];
  }

  /**
   * Run the shortcut the event spells in the first of `scopes` that has one. Returns
   * whether one ran. `scopes` defaults to the chain resolved from the event's target, so
   * callers normally pass nothing; pass an explicit list only to dispatch out of band.
   *
   * Keyless commands are skipped by construction: their slot is not one a keypress can
   * spell, so there is no branch here that has to know about them.
   */
  handle(event: KeyboardEvent, scopes?: readonly ShortcutScope[]): boolean {
    const key = keyOfEvent(event, this.platform);
    if (!key) return false;
    const target = asElement(event.target);
    if (isTextEntry(target) && !dispatchesInTextEntry(key)) return false;
    for (const scope of scopes ?? scopesFrom(target)) {
      const shortcut = this.shortcuts.get(`${scope}:${key}`);
      if (shortcut) {
        event.preventDefault();
        shortcut.action();
        return true;
      }
    }
    return false;
  }

  /**
   * Listen for `keydown` on `target`, resolving each press's scope from where focus is.
   * Returns the remover.
   */
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
