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
 *
 * The updater never deletes the record, not even one it just wrote: it holds no fence over the
 * store, so it cannot prove that no participating writer reads, moves or replaces the record
 * between its check and an unlink. A record the update did not use is inert instead. Any
 * reservation made after it (the recovered daemon of a cancelled update, or anything launched
 * meanwhile) directly follows the stopped claim only if nothing else came first; that writer
 * holds the fence and spends the record (`spendSameFormatHandoff`), and a version other than
 * `to` can never carry under it. Every later reservation follows another claim, so the record
 * grants nothing to it.
 */
import { join } from "node:path";
import { z } from "zod";
import { fenceDirectory } from "@orca/protocol/first-run-fence";
import { writeUpdateHandoff, type UpdateHandoff } from "@orca/protocol/update-handoff";
import { hash, inspectFirstRunOwnership, refuse } from "./ownership.js";

const directChildTerminal = z.object({ observation: z.literal("direct-child-terminal") }).passthrough();

/** Returns the record written. */
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
  // If it moved on, the update is refused and the record left inert (see above).
  const after = inspectFirstRunOwnership(path).latest;
  if (after?.reservationId !== latest.reservationId) refuse();
  return issued;
}
