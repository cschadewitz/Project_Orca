/**
 * Durable delegation receipts (#883): what this daemon has asked a remote daemon to run for
 * one logical delegation, so that neither an engine retry of the step nor a restart of this
 * daemon submits replacement work before the earlier submission's fate is known.
 *
 * A logical delegation is one parent run's one step, across its retry attempts: the step's
 * first attempt names it (`TurnContext.delegationId`), and every later attempt of the same
 * visit reads the same receipt. Its remote admission key changes only when a new `generation`
 * starts, and a new generation starts only once the previous remote run is verified finished
 * without success (or verified never admitted).
 *
 * States:
 * - `submitting`: an admission was (or is about to be) sent and its answer is not known. The
 *   same key is safe to send again (the remote replays it); anything else first looks it up.
 * - `admitted`: the remote run exists (`remoteRunId`); follow it, never submit.
 * - `cancel-pending`: the parent cancelled while the admission's answer was unknown, and the
 *   no-create lookup has not yet shown whether a run exists. Kept until it does.
 * - `settled`: the remote run ended (`outcome`), or was found never to exist after a cancel.
 *   A later attempt of the step reuses a succeeded run whose artifacts it has not yet brought
 *   back (the parent stopped in between); any other settled receipt starts a new generation.
 *
 * One JSON file per delegation under `<store>/delegations/`, replaced atomically.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const DelegationReceiptSchema = z
  .object({
    version: z.literal(1),
    profile: z.string().min(1),
    parentRunId: z.string().min(1),
    delegationId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    key: z.string().min(1),
    state: z.enum(["submitting", "admitted", "cancel-pending", "settled"]),
    remoteRunId: z.string().min(1).optional(),
    outcome: z.enum(["succeeded", "failed", "cancelled", "never-admitted"]).optional(),
    /** The parent step attempt that last brought a succeeded run's artifacts back. */
    deliveredAttempt: z.number().int().positive().optional(),
    updatedAt: z.string(),
  })
  .strict();
export type DelegationReceipt = z.infer<typeof DelegationReceiptSchema>;

export class DelegationReceipts {
  constructor(readonly dir: string) {}

  private file(parentRunId: string, delegationId: string): string {
    const name = createHash("sha256").update(`${parentRunId}\n${delegationId}`).digest("hex").slice(0, 40);
    return join(this.dir, `${name}.json`);
  }

  /** The delegation's receipt, or undefined. A receipt that cannot be read refuses: never guess. */
  read(parentRunId: string, delegationId: string): DelegationReceipt | undefined {
    let text: string;
    try {
      text = readFileSync(this.file(parentRunId, delegationId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const receipt = DelegationReceiptSchema.parse(JSON.parse(text));
    if (receipt.parentRunId !== parentRunId || receipt.delegationId !== delegationId)
      throw new Error("delegation receipt does not match its delegation");
    return receipt;
  }

  /** Replace the receipt: written, flushed and renamed into place before this returns. */
  write(receipt: Omit<DelegationReceipt, "version" | "updatedAt">): DelegationReceipt {
    const full = DelegationReceiptSchema.parse({ ...receipt, version: 1, updatedAt: new Date().toISOString() });
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(full.parentRunId, full.delegationId);
    const temp = `${target}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(full));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
    try {
      const dir = openSync(this.dir, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch {
      // Directory fsync is not available everywhere (Windows); the rename stands.
    }
    return full;
  }

  /** Receipts still waiting to learn whether a cancelled admission made a run, for one remote. */
  cancelPending(profile: string, limit = 20): DelegationReceipt[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: DelegationReceipt[] = [];
    for (const name of names) {
      if (out.length >= limit) break;
      try {
        const receipt = DelegationReceiptSchema.parse(JSON.parse(readFileSync(join(this.dir, name), "utf8")));
        if (receipt.profile === profile && receipt.state === "cancel-pending") out.push(receipt);
      } catch {
        // An unreadable receipt is left for its own delegation to refuse on.
      }
    }
    return out;
  }
}

/** The remote admission key for one generation of one delegation: ≤128 bytes, stable. */
export function delegationKey(parentRunId: string, delegationId: string, generation: number): string {
  const digest = createHash("sha256").update(`${parentRunId}\n${delegationId}\n${generation}`).digest("hex");
  return `orca-delegate-${digest.slice(0, 48)}`;
}
