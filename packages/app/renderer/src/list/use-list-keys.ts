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
 * second list would otherwise register `J` in the same scope a second time, which the map
 * throws on — correctly. One list substrate, one set of list keys per scope.
 *
 * Which scope is the caller's, because a screen can hold more than one list and they are
 * not the same list: the Runs surface is a run tree above an event timeline beside a stream
 * of agent output, and `J` has to mean "next" in whichever of the three the focus is in.
 * Scope resolution is innermost-from-focus, so three registrations of `J` in three scopes
 * is not a collision — two in one scope still is.
 *
 * The labels take the surface's noun ("Next run", not "Next row") so the palette reads as
 * the screen does, and the moves are registered in the order the palette should list them.
 */
import { useCallback, useEffect, useRef } from "react";
import { useKeyboard } from "../keyboard-context.js";
import type { ListScope } from "./list-scope.js";
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

export function useListKeys(noun: string, onMove: (move: ListMove) => void, scope: ListScope = "list"): void {
  const keyboard = useKeyboard();

  /* Through a ref, so a caller that rebuilds its handler on every render — which is every
     caller whose list changes — does not unregister and re-register eight shortcuts each
     time. A keypress landing between the two would do nothing. */
  const handler = useRef(onMove);
  handler.current = onMove;
  const move = useCallback((kind: ListMove) => handler.current(kind), []);

  useEffect(() => {
    const unregister = MOVES.map((m) =>
      keyboard.register({ scope, key: m.key, label: m.label(noun), action: () => move(m.move) }),
    );
    return () => unregister.forEach((u) => u());
  }, [keyboard, noun, move, scope]);
}
