/**
 * The five keys that belong to the run tree and to nothing else, registered on the
 * `KeyboardMap` in the `run-tree` scope: `→`, `←`, `⇧→`, `Enter` and `F`
 * (docs/design/50-accessibility-and-keyboard.md).
 *
 * The other eight — `J`/`K`, `↑`/`↓`, `Home`/`End` and the page keys — are **not** here.
 * They are the list substrate's and it registers them in whichever scope its `scope` prop
 * names, so binding them again would throw at registration, which is exactly how the map
 * is meant to find a collision. What is left is the part that is a tree's rather than a
 * list's: the second axis.
 *
 * Registering rather than listening is what makes these five discoverable: the command
 * palette is a view of the registry, so a `keydown` handler here would be a shortcut
 * nobody could find.
 */
import { useCallback, useEffect, useRef } from "react";
import { useKeyboard } from "../../keyboard-context.js";

export interface TreeKeyActions {
  /** `→` — open the selected row, or move into it when it is already open. */
  expand: () => void;
  /** `←` — close the selected row, or go to its parent when it is already closed. */
  collapse: () => void;
  /** `⇧→` — open the selected row and everything under it. */
  expandDeep: () => void;
  /** `Enter` — open the step detail for the selected row. */
  open: () => void;
  /** `F` — show only the failed and the waiting, and back again. */
  toggleAttention: () => void;
}

export function useTreeKeys(actions: TreeKeyActions, attentionOnly: boolean): void {
  const keyboard = useKeyboard();

  /* Through a ref, so a tree whose rows change on every notification does not unregister
     and re-register five shortcuts each time — a keypress landing between the two would
     do nothing. The same trick `list/use-list-keys.ts` uses. */
  const current = useRef(actions);
  current.current = actions;

  const run = useCallback((pick: (a: TreeKeyActions) => () => void) => pick(current.current)(), []);

  useEffect(() => {
    const off = [
      keyboard.register({
        scope: "run-tree",
        key: "ArrowRight",
        label: "Expand the selected row",
        action: () => run((a) => a.expand),
      }),
      keyboard.register({
        scope: "run-tree",
        key: "ArrowLeft",
        label: "Collapse the selected row, or go to its parent",
        action: () => run((a) => a.collapse),
      }),
      keyboard.register({
        scope: "run-tree",
        key: "Shift+ArrowRight",
        label: "Expand the whole subtree",
        action: () => run((a) => a.expandDeep),
      }),
      keyboard.register({
        scope: "run-tree",
        key: "Enter",
        label: "Open the step detail",
        action: () => run((a) => a.open),
      }),
      keyboard.register({
        scope: "run-tree",
        key: "F",
        // The label says what the press does next, because the palette lists the label and
        // a toggle that always reads the same way tells a person nothing.
        label: attentionOnly ? "Show every row again" : "Filter to failed and waiting",
        detail: "Keeps the failed and the waiting rows, and the rows that lead to them",
        action: () => run((a) => a.toggleAttention),
      }),
    ];
    return () => off.forEach((remove) => remove());
  }, [keyboard, run, attentionOnly]);
}
