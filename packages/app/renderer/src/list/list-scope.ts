/**
 * The three `ShortcutScope`s a `VirtualList` may claim, named once so the prop, the key
 * registration and the subtree marker cannot disagree.
 *
 * It is a subset of `ShortcutScope` rather than the whole of it on purpose: `global` would
 * make one list's `J` the whole app's, and `card`, `panel` and `menu` belong to layers that
 * are not lists — a menu's `↑`/`↓` are the `Menu` primitive's and out-rank a list's by
 * being nearer the focus, which only works while the two stay different scopes.
 *
 * One list per scope, three scopes, so a screen can hold three lists: the run tree
 * (`run-tree`), the event timeline (`list`) and the stream of agent output (`stream`). A
 * fourth list on one screen is not a missing scope, it is a screen with too much on it.
 */
import type { ShortcutScope } from "../keyboard-map.js";

export type ListScope = Extract<ShortcutScope, "list" | "run-tree" | "stream">;

export const LIST_SCOPES: readonly ListScope[] = ["list", "run-tree", "stream"];
