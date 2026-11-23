/**
 * The desktop app's switch of its own workspace's store to SQLite (#339), in place, by the
 * daemon the app launches, on the start the app asks for it.
 *
 * In a workspace in general, an in-place switch cannot keep out a released ORCA that is already
 * running (an idle daemon, a command between two writes), so the CLI never offers one and
 * converts into a new store instead (`orca store sqlite convert`). The app's own workspaces are
 * different: every ORCA that may write one (0.7.0 and later; the app's workspaces did not exist
 * before) must first hold the workspace's kernel-lifetime writer fence with a launch the app
 * granted, and only one writer holds it at a time. So the daemon holding that fence knows no
 * other ORCA writes the store, and the switch runs under it, checked throughout. The app's
 * layout (its store is always `.orca`, its config is pinned by its ownership claim) stays as it
 * is. Windows stays refused (#947).
 */
import { StoreFormatError, switchStoreToSqlite, type SwitchToSqliteOptions } from "@orca/store";
import type { FirstRunWriterHold } from "@orca/protocol/first-run-fence";
import { storePrivacy } from "./store-privacy.js";

/** Set by the app on one daemon launch to ask for the switch (daemon-process.ts). */
export const STORE_SWITCH_ENV = "ORCA_STORE_SWITCH";

export type DesktopSqliteSwitchOutcome =
  | { status: "switched" | "current" }
  /** The store stays on files, exactly as it was (any backup taken first is kept). */
  | { status: "refused"; reason: string; message: string };

/**
 * Switch `storeDir` to SQLite under `writer`'s fence, or refuse and leave it on files. A refusal
 * is an outcome, not an error: the daemon goes on starting on files. Anything else (a failed
 * write) is thrown, and the switch's journal makes the next start finish or undo it.
 */
export async function desktopSqliteSwitch(
  storeDir: string,
  writer: FirstRunWriterHold | undefined,
  appVersion: string,
  /** Tests. */
  hooks: Pick<SwitchToSqliteOptions, "afterFenceStep" | "beforeMarker" | "platform"> = {},
): Promise<DesktopSqliteSwitchOutcome> {
  if (!writer)
    return {
      status: "refused",
      reason: "SWITCH_REFUSED",
      message: `${storeDir} is not one of the desktop app's own workspaces, so it is not switched in place. Use \`orca store sqlite convert\`, which converts into a new store and leaves this one as it is.`,
    };
  const privacy = storePrivacy();
  try {
    const outcome = await switchStoreToSqlite(storeDir, {
      appVersion,
      fence: writer,
      ...(privacy ? { privacy } : {}),
      ...hooks,
    });
    return { status: outcome.status };
  } catch (error) {
    if (error instanceof StoreFormatError && error.reason !== "INTERRUPTED")
      return { status: "refused", reason: error.reason, message: error.message };
    throw error;
  }
}
