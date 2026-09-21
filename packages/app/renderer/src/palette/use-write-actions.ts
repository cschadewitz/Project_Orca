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
 *   palette row is a control like any other. The answer is `methodPresent(connection,
 *   row.method)` — the *method* the row calls, never the capability above it.
 * - **Can it take the write right now?** If not the row stays, disabled, with
 *   `useWritability()`'s sentence beside it in `.orca-palette__why` — the same sentence
 *   `Button`'s `disabledReason` carries, so a reconnecting socket says the same thing
 *   wherever a person meets it.
 *
 * **Per method, not per capability.** Every row names the wire method it calls, and the
 * connection snapshot carries `hello.methods` — `Object.keys` of the daemon's own dispatch
 * table (ADR 0008: "a method this daemon will not answer is a method it does not
 * advertise"). `runs.control` is one word over four dispatch tables, so asking it would
 * draw a waive row at a daemon serving a store with no plan in it, and hide a release row
 * at a daemon that answers `claims.release` without claiming the capability. A daemon too
 * old to list its methods still falls back to the capability, in `methodPresent` and only
 * there.
 *
 * Callers memoise their rows. A fresh array every render would unregister and re-register
 * the whole set on every render of the surface, which is churn rather than a bug, but the
 * map's registration order is the palette's reading order and it should not shuffle.
 */
import { useEffect } from "react";
import { useConnection, useWritability } from "../chrome/use-connection.js";
import { methodPresent } from "../connection.js";
import { useKeyboard } from "../keyboard-context.js";
import type { Shortcut } from "../keyboard-map.js";

/**
 * A write as a surface declares it: an ordinary `Shortcut` minus the one field this hook
 * fills in, plus the one it cannot fill in for the caller. `key` is left out too — every
 * write action built for #178 is keyless, because the design's key table is short and none
 * of these is worth one of the letters left.
 */
export type PaletteWrite = Omit<Shortcut, "unavailable" | "key"> & {
  /**
   * The wire method this row calls — `runs.cancel`, `decisions.decide`, `claims.release`.
   * It decides whether the row exists at all: a daemon that does not answer the method
   * gets no row for it, which is the difference between a viewer and something broken.
   */
  method: string;
};

/**
 * Register `rows` for as long as the surface is mounted, minus the ones whose method this
 * daemon does not answer. `rows` must be memoised by the caller.
 */
export function usePaletteWrites(rows: readonly PaletteWrite[]): void {
  const keyboard = useKeyboard();
  const connection = useConnection();
  const writability = useWritability();
  const reason = writability.can ? undefined : writability.reason;

  useEffect(() => {
    const off = rows
      .filter((row) => methodPresent(connection, row.method))
      // `method` is this hook's field and not the registry's: the map holds commands, and
      // what a command calls is nobody's business once it has been decided to offer it.
      .map(({ method: _method, ...row }) =>
        keyboard.register({ ...row, ...(reason === undefined ? {} : { unavailable: reason }) }),
      );
    return () => off.forEach((unregister) => unregister());
  }, [keyboard, connection, reason, rows]);
}
