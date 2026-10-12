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
 * The scopes in docs/design/50-accessibility-and-keyboard.md's table, plus three the table
 * gained as the surfaces that need them landed:
 *
 * - `menu` — an open popover is a place focus can be, and its roving keys have to out-rank
 *   the `↑`/`↓` of the list underneath it. Scope resolution is innermost first, so marking
 *   the open list with `scopeProps("menu")` is all that takes.
 * - `workflow` (#177) — the graph canvas is not a list: its `↑`/`↓` move between *nodes* in
 *   a layer rather than between rows, its `←`/`→` move between layers, and it binds `+`,
 *   `-` and `0` for zoom, which no list has. A canvas inside a surface that also has a list
 *   is the same situation `run-tree` beside `list` is, and it is settled the same way.
 * - `plan-journal` (#170) — the Plan surface holds two lists: the schedule table in `list`
 *   and the plan journal below it. One scope holds one `VirtualList`, so the second list
 *   needs a scope of its own or the substrate's `J` would be registered twice and the map
 *   would throw. It is the same situation `run-tree` beside `list` is, named for the list
 *   rather than for the surface because that is what a person's `J` is moving through.
 * - `plan-graph` (#171) — the plan's dependency graph is a canvas like the workflow's, with
 *   the same arrows, zoom and pan, and it is not the workflow canvas: the two can never share
 *   a scope without one registering `↑` over the other, which the map throws on.
 */
export type ShortcutScope =
  | "global"
  | "list"
  | "run-tree"
  | "stream"
  | "card"
  | "panel"
  | "config"
  | "menu"
  | "workflow"
  | "plan-journal"
  | "plan-graph"
  | "workflow-edit";

export const SHORTCUT_SCOPES: readonly ShortcutScope[] = [
  "global",
  "list",
  "run-tree",
  "stream",
  "card",
  "panel",
  /**
   * The config form and the raw editor (#175). It is a scope rather than a `global`
   * registration because `⌘S` is a word with one obvious meaning inside a form holding a
   * draft and no meaning at all on the run tree — and because the workflow editor's draft
   * bar is this same bar (docs/design/70-workflow-editing.md), so the key has to be able to
   * mean "save *this* draft" on two screens.
   */
  "config",
  "menu",
  "workflow",
  "plan-journal",
  "plan-graph",
  /**
   * The workflow editor's canvas (#181). Its own scope rather than `workflow`'s: the editor
   * adds keys the read-only viewer must not have - delete, undo, rename, connect - and the
   * arrows move the same selection over a graph that changes under them.
   */
  "workflow-edit",
];

/** Which of the palette's three sections a shortcut belongs in. Search is not a command. */
export type ShortcutSection = "actions" | "navigation";

/**
 * One choice in a palette picker. Structurally a `Menu`'s `MenuItem` — the palette renders
 * these *as* menu items — written out here rather than imported so the keyboard map keeps
 * knowing nothing about the UI primitives.
 */
export interface PaletteChoice {
  id: string;
  label: string;
  /** A trailing note: a workflow's version and node count, a decision option's rationale. */
  hint?: string;
  /** The same note when it is machine text — an id, `ai-sdlc · v3 · 7 nodes` — in mono, never re-cased. */
  hintMachine?: string;
}

/**
 * A command that asks which one before it acts (#178): **Start a run** needs a workflow,
 * **Decide** needs an option. Choosing the row replaces the palette's list with a `Menu`
 * of these — the app's one popover primitive, so the palette grows no second one.
 *
 * `load` runs when the row is chosen and never before: a palette that read `workflows.list`
 * to draw its rows would read it on every ⌘K, whether or not anybody wanted a workflow.
 */
export interface ShortcutPicker {
  /** The accessible name of the menu, and the line above it. */
  label: string;
  load: () => Promise<readonly PaletteChoice[]>;
  choose: (id: string) => void;
  /** What the palette says when `load` answers nothing at all. A sentence, not a shrug. */
  empty: string;
}

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
  /**
   * The part of `label` (and of `confirm`) that is machine text — a run id, a work item
   * id, a decision key. The palette draws that substring in mono and the rest in sans,
   * because "mono means ORCA produced it" is load-bearing (docs/design/RULES.md rule 8)
   * and "Cancel run-gate — confirm" is two voices in one sentence.
   *
   * It is a substring rather than a second label so that the label stays one string: it is
   * what the palette matches a query against, what `aria-activedescendant` names, and what
   * a person reads back. A value that does not occur in the text draws nothing special.
   *
   * An id in a label is never the raw id: it is the object's name and its token,
   * `Release claim on Database schema ⬡ 5M579G`, with the token (`idText`) as this value —
   * the palette draws it as an `ObjectId` token, glyph and all.
   */
  labelMachine?: string;
  /**
   * The full id of the object the command acts on. Never drawn — the label carries the
   * object's name and token — but matched, so a person who pastes the whole id, or types
   * the tail a row showed them, finds the command.
   */
  objectId?: string;
  action: () => void;
  /** Where the palette files it. Defaults to `actions` — most shortcuts act on the current object. */
  section?: ShortcutSection;
  /** A second line for the palette: what the action is for, when the label cannot say it. */
  detail?: string;
  /**
   * Why this command cannot be run right now — `useWritability()`'s sentence, verbatim
   * (#178). The palette draws the row disabled with this beside it, which is the same
   * contract `Button`'s `disabledReason` has: a control that is dead and silent reads as
   * broken. A command that is not merely unavailable but *absent* — a method this daemon
   * does not serve — does not register at all.
   */
  unavailable?: string;
  /**
   * A destructive command's second row state (#178): choosing the row swaps its label for
   * this one and a second `Enter` commits. `tone: "danger"` goes with it.
   *
   * It is in the registry rather than in the palette because the confirmation is a property
   * of the *command* — "cancelling run-42 cannot be undone" is true wherever the command is
   * offered from — and because the palette must not have to know which labels are dangerous.
   */
  confirm?: string;
  /** `danger` draws the row in the status colour for a destructive act. */
  tone?: "danger";
  /** A command that asks which one first — see `ShortcutPicker`. Never with `confirm`. */
  picker?: ShortcutPicker;
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
  /* `+` is both this notation's separator and a key a person presses — the workflow
     canvas's zoom in (#177). Splitting leaves it as two empty tails (`"+"` → `["", ""]`,
     `"Shift++"` → `["Shift", "", ""]`), which is unambiguous, so it is folded back into the
     one key it was rather than rejected as naming none. */
  if (parts.length > 1 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") {
    parts.splice(-2, 2, "+");
  }
  const main = parts.pop();
  if (!main) throw new Error(`shortcut ${JSON.stringify(key)} names no key`);
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  for (const m of mods) {
    if (!MODIFIERS.some((known) => known.toLowerCase() === m)) throw new Error(`unknown modifier ${m} in ${key}`);
  }
  const ordered = MODIFIERS.filter((m) => mods.has(m.toLowerCase()));
  return [...ordered, main.length === 1 ? main.toUpperCase() : main].join("+");
}

/**
 * A key `event.key` reports as a printable character that is neither a letter nor a digit:
 * `+`, `?`, `_`, `:`, `~`. On every layout that has them, Shift is how they are typed — `+`
 * *is* Shift and Equal — so the shift is spelling the character rather than modifying it, and
 * a registration of `+` has no `Shift+` to name. `ArrowUp` and `Enter` are not one character,
 * so `Shift+ArrowUp` and `Shift+Enter` are untouched by this.
 */
const shiftSpellsTheCharacter = (key: string): boolean => key.length === 1 && !/[a-zA-Z0-9]/.test(key);

/** The key a `keydown` event spells in the map's notation, or `undefined` for a bare modifier. */
export function keyOfEvent(event: KeyboardEvent, platform: string): string | undefined {
  const mod = platform === "darwin" ? event.metaKey : event.ctrlKey;
  // `code` for letters and digits so ⌘⇧L is ⌘⇧L on every layout and whatever Shift did to the
  // character; `key` for everything else (Escape, Enter, ArrowDown, `/`, `[`).
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1] ?? /^Digit([0-9])$/.exec(event.code)?.[1];
  const main = letter ?? event.key;
  if (["Meta", "Control", "Shift", "Alt"].includes(main)) return undefined;
  /* A punctuation key produced *by* Shift drops it (#177): the workflow canvas registers `+`
     for zoom in, and a real keyboard sends `{ key: "+", code: "Equal", shiftKey: true }` —
     which spelled `Shift++` and matched nothing. `code` is no help here, because which
     character `Equal` shifts to is exactly what a layout decides. */
  const shift = event.shiftKey && !(letter === undefined && shiftSpellsTheCharacter(main));
  return [mod ? "Mod" : "", shift ? "Shift" : "", event.altKey ? "Alt" : "", main].filter(Boolean).join("+");
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
