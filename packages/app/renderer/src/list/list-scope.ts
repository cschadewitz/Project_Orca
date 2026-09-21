/**
 * The three `ShortcutScope`s a `VirtualList` may claim, named once so the prop, the key
 * registration and the subtree marker cannot disagree.
 *
 * It is a subset of `ShortcutScope` rather than the whole of it on purpose: `global` would
 * make one list's `J` the whole app's, and `card`, `panel` and `menu` belong to layers that
 * are not lists — a menu's `↑`/`↓` are the `Menu` primitive's and out-rank a list's by
 * being nearer the focus, which only works while the two stay different scopes.
 *
 * One list per scope, so a screen can hold as many lists as it has scopes: the run tree
 * (`run-tree`), the event timeline (`list`) and the stream of agent output (`stream`) on
 * Runs, and the schedule table (`list`) above the plan journal (`plan-journal`) on Plan
 * (#170). A *fourth* list on the Runs screen is still not a missing scope — a scope is
 * added when a surface has a second list whose `J` means something else, which is what the
 * journal is, and not to let one screen grow another pane.
 */
import type { ShortcutScope } from "../keyboard-map.js";

export type ListScope = Extract<ShortcutScope, "list" | "run-tree" | "stream" | "plan-journal">;

export const LIST_SCOPES: readonly ListScope[] = ["list", "run-tree", "stream", "plan-journal"];
