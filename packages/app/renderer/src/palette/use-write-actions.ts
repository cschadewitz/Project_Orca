/**
 * How a surface puts a write in the palette (#178).
 *
 * "The palette is the only place a phase-2 write action needs to be discoverable, which
 * keeps the chrome of the screens empty" (docs/design/10-information-architecture.md), so
 * every write in the app registers here as a keyless command on the object in focus. This
 * hook is the one place the two questions in front of every one of them are asked, so that
 * seven surfaces cannot answer them seven ways:
 *
 * - **Does this daemon serve the write at all?** If not the row is *absent*. A palette
 *   listing a command with nothing behind it is worse than a palette without it:
 *   docs/design/40-connection-states.md draws the distinction as "a screen with no cancel
 *   button reads as a viewer; a screen with a greyed cancel button reads as broken", and a
 *   palette row is a control like any other. `useWritesPresent()` is the answer, which is
 *   the same answer the Agents surface's two controls take — a daemon started `--read-only`
 *   omits `runs.control` *and* leaves every control method out of `hello.methods`, so the
 *   capability and the method list cannot disagree.
 * - **Can it take the write right now?** If not the row stays, disabled, with
 *   `useWritability()`'s sentence beside it in `.orca-palette__why` — the same sentence
 *   `Button`'s `disabledReason` carries, so a reconnecting socket says the same thing
 *   wherever a person meets it.
 *
 * **Per method rather than per capability is the refinement still wanted.** `hello.methods`
 * names each method one by one and the renderer never sees it: the handshake is the main
 * process's, and what reaches here is the connection snapshot's `capabilities`. The
 * capability is today's honest approximation — they move together — and the day the
 * snapshot carries `methods`, `writesPresent` is where the per-method check goes, once,
 * rather than in each caller.
 *
 * Callers memoise their rows. A fresh array every render would unregister and re-register
 * the whole set on every render of the surface, which is churn rather than a bug, but the
 * map's registration order is the palette's reading order and it should not shuffle.
 */
import { useEffect } from "react";
import { useWritability, useWritesPresent } from "../chrome/use-connection.js";
import { useKeyboard } from "../keyboard-context.js";
import type { Shortcut } from "../keyboard-map.js";

/**
 * A write as a surface declares it: an ordinary `Shortcut` minus the one field this hook
 * fills in. `key` is left out too — every write action built for #178 is keyless, because
 * the design's key table is short and none of these is worth one of the letters left.
 */
export type PaletteWrite = Omit<Shortcut, "unavailable" | "key">;

/**
 * Register `rows` for as long as the surface is mounted, or not at all where the daemon
 * has no such write. `rows` must be memoised by the caller.
 */
export function usePaletteWrites(rows: readonly PaletteWrite[]): void {
  const keyboard = useKeyboard();
  const present = useWritesPresent();
  const writability = useWritability();
  const reason = writability.can ? undefined : writability.reason;

  useEffect(() => {
    if (!present) return;
    const off = rows.map((row) =>
      keyboard.register({ ...row, ...(reason === undefined ? {} : { unavailable: reason }) }),
    );
    return () => off.forEach((unregister) => unregister());
  }, [keyboard, present, reason, rows]);
}
