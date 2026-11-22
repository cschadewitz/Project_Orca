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
import { removeIssuedUpdateHandoff, writeUpdateHandoff, type UpdateHandoff } from "@orca/protocol/update-handoff";
import { hash, inspectFirstRunOwnership, refuse } from "./ownership.js";

const directChildTerminal = z.object({ observation: z.literal("direct-child-terminal") }).passthrough();

/** Returns the record written: the receipt that alone may withdraw it later. */
export function handOffStoreForUpdate(
  path: string,
  from: string,
  to: string,
  now: () => Date = () => new Date(),
  /** Injected for tests. */
  afterWrite?: () => void,
): UpdateHandoff {
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
  const issued: UpdateHandoff = {
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
  };
  writeUpdateHandoff(storeDir, issued);
  afterWrite?.();
  // The journal must still end on the attempt the record names: nothing launched meanwhile.
  // Only this exact record is taken back; one written or moved by anything else stays.
  const after = inspectFirstRunOwnership(path).latest;
  if (after?.reservationId !== latest.reservationId) {
    removeIssuedUpdateHandoff(storeDir, issued);
    refuse();
  }
  return issued;
}

/**
 * The updater did not install after all: the record it issued must not outlive this attempt.
 * Withdrawn only while the attempt it names is still the journal's latest (nothing launched since
 * could have claimed it) and the record on disk is exactly the one issued; anything else stays.
 */
export function withdrawUpdateHandoff(path: string, issued: UpdateHandoff): boolean {
  const latest = inspectFirstRunOwnership(path).latest;
  if (latest?.reservationId !== issued.reservationId) return false;
  if (!latest.texts["claim.json"] || hash(latest.texts["claim.json"]) !== issued.claimHash) return false;
  return removeIssuedUpdateHandoff(join(path, ".orca"), issued);
}
