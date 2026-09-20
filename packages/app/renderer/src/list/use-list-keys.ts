/**
 * Every key that moves a selection down a list, registered on the `KeyboardMap` in the
 * `list` scope.
 *
 * `J`/`K`, `↑`/`↓`, `Home`/`End` and the page keys are the `Lists` row of the keyboard
 * table in docs/design/50-accessibility-and-keyboard.md. None of them is a `keydown`
 * listener: the command palette is a view of the registry, so a shortcut that skips it is
 * a shortcut nobody can discover (AGENTS.md). Registering rather than listening also
 * settles the collisions for free — the `↑`/`↓` of an open menu out-rank these, because
 * scope resolution is innermost first, and typing a `J` into the filter field types a J,
 * because `KeyboardMap` does not dispatch a bare letter inside a text entry.
 *
 * They live here rather than in a surface for the same reason the arithmetic does: a
 * second list would otherwise register `J` in the `list` scope a second time, which the
 * map throws on — correctly. One list substrate, one set of list keys.
 *
 * The labels take the surface's noun ("Next run", not "Next row") so the palette reads as
 * the screen does, and the moves are registered in the order the palette should list them.
 */
import { useCallback, useEffect, useRef } from "react";
import { useKeyboard } from "../keyboard-context.js";
import type { ListMove } from "./list-window.js";

/** Key, move, and how the palette says it. `noun` is the surface's word for a row. */
const MOVES: readonly { key: string; move: ListMove; label: (noun: string) => string }[] = [
  { key: "J", move: "next", label: (noun) => `Next ${noun}` },
  { key: "ArrowDown", move: "next", label: (noun) => `Next ${noun}` },
  { key: "K", move: "previous", label: (noun) => `Previous ${noun}` },
  { key: "ArrowUp", move: "previous", label: (noun) => `Previous ${noun}` },
  { key: "Home", move: "first", label: (noun) => `First ${noun}` },
  { key: "End", move: "last", label: (noun) => `Last ${noun}` },
  { key: "PageDown", move: "page-down", label: (noun) => `Next page of ${noun}s` },
  { key: "PageUp", move: "page-up", label: (noun) => `Previous page of ${noun}s` },
];

export function useListKeys(noun: string, onMove: (move: ListMove) => void): void {
  const keyboard = useKeyboard();

  /* Through a ref, so a caller that rebuilds its handler on every render — which is every
     caller whose list changes — does not unregister and re-register eight shortcuts each
     time. A keypress landing between the two would do nothing. */
  const handler = useRef(onMove);
  handler.current = onMove;
  const move = useCallback((kind: ListMove) => handler.current(kind), []);

  useEffect(() => {
    const unregister = MOVES.map((m) =>
      keyboard.register({ scope: "list", key: m.key, label: m.label(noun), action: () => move(m.move) }),
    );
    return () => unregister.forEach((u) => u());
  }, [keyboard, noun, move]);
}
