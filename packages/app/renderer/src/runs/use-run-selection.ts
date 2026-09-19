/**
 * Selection in the Runs list, and the four keys that move it.
 *
 * `J`/`K` and `↑`/`↓` are the `Lists` row of the keyboard table in
 * docs/design/50-accessibility-and-keyboard.md. All four register on the `KeyboardMap` in
 * the `list` scope rather than in a `keydown` listener, so the command palette lists them
 * and so the `↑`/`↓` of an open menu out-rank them (scope resolution is innermost first).
 *
 * The moves read the current rows through a ref. The alternative — re-registering whenever
 * the list changes — would unregister and re-register four shortcuts on every notification,
 * and a keypress that landed between the two would do nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyboard } from "../keyboard-context.js";

export interface RunSelection {
  /** The selected run, or `undefined` when nothing is selected yet. */
  selectedId: string | undefined;
  /** Select by id — what a click on a row calls. */
  select: (id: string) => void;
}

/** The moves, in the order the palette should list them. */
const MOVES = [
  { key: "J", step: 1, label: "Next run" },
  { key: "ArrowDown", step: 1, label: "Next run" },
  { key: "K", step: -1, label: "Previous run" },
  { key: "ArrowUp", step: -1, label: "Previous run" },
] as const;

export function useRunSelection(ids: readonly string[]): RunSelection {
  const keyboard = useKeyboard();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  const current = useRef<readonly string[]>(ids);
  current.current = ids;

  const move = useCallback((step: number) => {
    setSelectedId((selected) => {
      const rows = current.current;
      if (rows.length === 0) return undefined;
      const at = selected === undefined ? -1 : rows.indexOf(selected);
      // Nothing selected: the key takes the end it points at, so the first `J` lands on the
      // newest run and the first `K` on the oldest, rather than both on row one.
      if (at === -1) return step > 0 ? rows[0] : rows[rows.length - 1];
      return rows[Math.min(rows.length - 1, Math.max(0, at + step))];
    });
  }, []);

  useEffect(() => {
    const unregister = MOVES.map((m) =>
      keyboard.register({ scope: "list", key: m.key, label: m.label, action: () => move(m.step) }),
    );
    return () => unregister.forEach((u) => u());
  }, [keyboard, move]);

  /* A row can leave the list under the selection — the text filter narrowed, or a status
     filter dropped the run when it finished. Clearing is the honest answer: keeping an id
     that names no row would make the next `J` jump somewhere unrelated. */
  useEffect(() => {
    setSelectedId((selected) => (selected !== undefined && !ids.includes(selected) ? undefined : selected));
  }, [ids]);

  return { selectedId, select: setSelectedId };
}
