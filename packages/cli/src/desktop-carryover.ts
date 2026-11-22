/** Automatic store carryover for the desktop app's bundled daemon after an update (#897). */
import { enterStoreFormat, type CarryoverAuthority, type StoreFormatOutcome } from "@orca/store";
import type { FirstRunWriterHold } from "@orca/protocol/first-run-fence";
import { claimUpdateHandoff, spendSameFormatHandoff, spendUpdateHandoff } from "@orca/protocol/update-handoff";
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
  /** Injected for tests. */
  afterCopy?: () => Promise<void>,
): CarryoverAuthority | undefined {
  const claimed = claimUpdateHandoff(hold, appVersion);
  if (!claimed.ok || !hold) return undefined;
  const privacy = storePrivacy();
  return {
    fence: hold,
    ...(privacy ? { privacy } : {}),
    ...(afterCopy ? { afterCopy } : {}),
    // Done or refused: the handoff is spent either way. An interrupted carryover keeps it, bound
    // to this writer's claim, so the next start retries under the same proof. Only while the same
    // fence still holds and the record is exactly the one this writer claimed: once that proof is
    // gone, this process changes nothing in the store, the record included.
    settle: () => {
      spendUpdateHandoff(hold, (current) => JSON.stringify(current) === JSON.stringify(claimed.handoff));
    },
  };
}

/**
 * The daemon's store format gate (#566, #897): refuse what this build cannot open, carry an
 * older store forward only under {@link desktopCarryover}'s proof, whose guarded `settle` alone
 * cleans up after a carryover. When the format was already current, a handoff for that update is
 * spent only if this writer provably owns that exact record.
 */
export async function enterDaemonStoreFormat(
  storeDir: string,
  writer: FirstRunWriterHold | undefined,
  version: string,
  mode: "write" | "read",
  /** Injected for tests. */
  afterCopy?: () => Promise<void>,
): Promise<StoreFormatOutcome> {
  const outcome = await enterStoreFormat(storeDir, {
    appVersion: version,
    mode,
    ...(writer ? { carryover: () => Promise.resolve(desktopCarryover(writer, version, afterCopy)) } : {}),
  });
  if (writer && outcome.status !== "carried") spendSameFormatHandoff(writer);
  return outcome;
}
