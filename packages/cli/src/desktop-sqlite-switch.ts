/**
 * The desktop app's switch of its own workspace's store to SQLite (#339), in place, by the
 * daemon the app launches, on the start the app asks for it.
 *
 * In a workspace in general, an in-place switch cannot keep out a released ORCA that is already
 * running (an idle daemon, a command between two writes), so the CLI never offers one and
 * converts into a new store instead (`orca store sqlite convert`). The app's own workspaces are
 * different: every supported ORCA that may write one (0.7.0 and later, the versions that know app
 * workspaces) must first hold the workspace's kernel-lifetime writer fence with a launch the app
 * granted, and only one writer holds it at a time. So the daemon holding that fence knows no
 * other supported ORCA writes the store, and the switch runs under it, checked throughout. An
 * ORCA from before 0.7 pointed at an app workspace by hand is outside what is supported: the
 * legacy fence turns it away if it starts after the switch, but one already running is not seen. The app's
 * layout (its store is always `.orca`, its config is pinned by its ownership claim) stays as it
 * is. Windows stays refused (#947).
 */
import { StoreFormatError, switchStoreToSqlite, type SwitchToSqliteOptions } from "@orca/store";
import type { FirstRunWriterHold } from "@orca/protocol/first-run-fence";
import { storePrivacy } from "./store-privacy.js";

/**
 * Set by the app on one daemon launch to ask for the switch (daemon-process.ts):
 * `sqlite:<claim hash>`, naming the first-run claim of the daemon the app stopped exactly for it.
 */
export const STORE_SWITCH_ENV = "ORCA_STORE_SWITCH";

/** The stopped claim a `STORE_SWITCH_ENV` value names, or `undefined` when it is not a request. */
export function parseStoreSwitchRequest(value: string | undefined): { after: string } | undefined {
  const match = value === undefined ? null : /^sqlite:([a-f0-9]{64})$/.exec(value);
  return match ? { after: match[1]! } : undefined;
}

export type DesktopSqliteSwitchOutcome =
  | { status: "switched" | "current" }
  /** The store stays on files, exactly as it was (any backup taken first is kept). */
  | { status: "refused"; reason: string; message: string };

/**
 * Switch `storeDir` to SQLite under `writer`'s fence, or refuse and leave it on files. A refusal
 * while this launch still holds the fence is an outcome, not an error: the daemon goes on
 * starting on files. A lost fence is thrown (`FENCE_LOST`, after the switch was undone): this
 * launch is no longer the workspace's writer and must not open the store at all. Anything else
 * (a failed write) is thrown too, and the switch's journal makes the next start finish or undo it.
 */
export async function desktopSqliteSwitch(
  storeDir: string,
  writer: FirstRunWriterHold | undefined,
  appVersion: string,
  /** The claim of the daemon the app stopped for this switch: this writer's must directly follow it. */
  after: string,
  /** Tests. */
  hooks: Pick<SwitchToSqliteOptions, "afterFenceStep" | "beforeMarker" | "platform"> = {},
): Promise<DesktopSqliteSwitchOutcome> {
  if (!writer)
    return {
      status: "refused",
      reason: "SWITCH_REFUSED",
      message: `${storeDir} is not one of the desktop app's own workspaces, so it is not switched in place. Use \`orca store sqlite convert\`, which converts into a new store and leaves this one as it is.`,
    };
  // Only the launch directly after the exact stop the app made for the switch: a request that
  // outlived that stop (another launch came between, the workspace was replaced) is refused.
  if (writer.previous !== after || !writer.check())
    return {
      status: "refused",
      reason: "SWITCH_REFUSED",
      message: `The switch to SQLite was asked for another start of ${storeDir} than this one, so the store stays on files. Ask for it again.`,
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
    if (!(error instanceof StoreFormatError) || error.reason === "INTERRUPTED") throw error;
    if (error.reason === "FENCE_LOST") throw error;
    if (!writer.check())
      throw new StoreFormatError(
        "FENCE_LOST",
        `This ORCA no longer provably holds the only write access to ${storeDir}, so it does not open the store. The switch to SQLite was refused (${error.reason}) and the store stays on files. Start ORCA again.`,
        storeDir,
      );
    return { status: "refused", reason: error.reason, message: error.message };
  }
}
