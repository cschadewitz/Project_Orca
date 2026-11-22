/** Automatic store carryover for the desktop app's bundled daemon after an update (#897). */
import type { CarryoverAuthority } from "@orca/store";
import type { FirstRunWriterHold } from "@orca/protocol/first-run-fence";
import { claimUpdateHandoff, removeUpdateHandoff } from "@orca/protocol/update-handoff";
import { storePrivacy } from "./store-privacy.js";

/**
 * Automatic carryover on the first start after a desktop update (#897), or `undefined` to keep
 * refusing. Only a first-run writer that holds the store's kernel-lifetime fence, whose claim
 * directly follows the claim of the daemon the updater stopped, and which is the version the
 * update installed, gets one; the fence it holds is checked throughout the carryover.
 */
export function desktopCarryover(
  hold: FirstRunWriterHold | undefined,
  appVersion: string,
): CarryoverAuthority | undefined {
  const claimed = claimUpdateHandoff(hold, appVersion);
  if (!claimed.ok || !hold) return undefined;
  const privacy = storePrivacy();
  return {
    fence: hold,
    ...(privacy ? { privacy } : {}),
    // Done or refused: the handoff is spent either way. An interrupted carryover keeps it, bound
    // to this writer's claim, so the next start retries under the same proof.
    settle: () => removeUpdateHandoff(hold.storeDir),
  };
}
