/**
 * The Windows updater hands the stopped bundled daemon's store to the next start (#897).
 *
 * Written only after the updater closed admission, the daemon reported no active work, the exact
 * child exit was observed and its terminal evidence recorded in the first-run journal: the
 * journal's latest attempt must be settled by that direct-child observation, never by recovery
 * or a reboot settlement. The record binds the exact store and workspace directories, that
 * attempt's claim and the version being installed (`@orca/protocol/update-handoff`). The new
 * app's daemon may carry an older-format store forward only if its own claim directly follows
 * this one and it holds the first-run writer fence; otherwise startup keeps refusing.
 */
import { join } from "node:path";
import { z } from "zod";
import { fenceDirectory } from "@orca/protocol/first-run-fence";
import { removeUpdateHandoff, writeUpdateHandoff } from "@orca/protocol/update-handoff";
import { hash, inspectFirstRunOwnership, refuse } from "./ownership.js";

const directChildTerminal = z.object({ observation: z.literal("direct-child-terminal") }).passthrough();

export function handOffStoreForUpdate(
  path: string,
  from: string,
  to: string,
  now: () => Date = () => new Date(),
): void {
  const journal = inspectFirstRunOwnership(path);
  const latest = journal.latest;
  if (
    !latest?.settled ||
    !latest.texts["claim.json"] ||
    !latest.texts["writer.json"] ||
    !latest.texts["terminal.json"] ||
    latest.texts["recovery-request.json"] ||
    latest.texts["ended-after-reboot.json"] ||
    !directChildTerminal.safeParse(JSON.parse(latest.texts["terminal.json"])).success
  )
    return refuse();
  const storeDir = join(path, ".orca");
  writeUpdateHandoff(storeDir, {
    version: 1,
    kind: "orca-update-handoff",
    reservationId: latest.reservationId,
    claimHash: hash(latest.texts["claim.json"]),
    workspace: fenceDirectory(path),
    store: fenceDirectory(storeDir),
    from,
    to,
    drained: true,
    attempts: 0,
    createdAt: now().toISOString(),
  });
  // The journal must still end on the attempt the record names: nothing launched meanwhile.
  const after = inspectFirstRunOwnership(path).latest;
  if (after?.reservationId !== latest.reservationId) {
    removeUpdateHandoff(storeDir);
    refuse();
  }
}

/** The updater did not install after all: the record must not outlive this attempt. */
export function withdrawUpdateHandoff(path: string): void {
  removeUpdateHandoff(join(path, ".orca"));
}
